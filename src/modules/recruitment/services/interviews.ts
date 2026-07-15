import type { Interview, InterviewPanelist } from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { queueEmail } from "@/platform/email/send";
import { recordAudit } from "@/platform/audit";
import { reviewScope, RecruitmentAuthError } from "./review";
import { renderCycleEmail } from "../email/render";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { notify, type NotifyInput } from "@/platform/notifications/notify";
import { getSetting } from "@/platform/settings/service";
import { esc } from "@/platform/email/render/escape";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatDateTime } from "@/platform/dates";

export class InterviewError extends Error {
  constructor(message: string) { super(message); this.name = "InterviewError"; }
}

async function assertCanManage(departmentCode: string, actorId: string): Promise<void> {
  const scope = await reviewScope(actorId);
  if (!(scope.all || scope.departmentCodes.includes(departmentCode))) {
    throw new RecruitmentAuthError("You can't manage interviews for that department.");
  }
}

export async function createInterview(applicationId: string, departmentCode: string, createdById: string): Promise<Interview> {
  const app = await prisma.application.findUnique({ where: { id: applicationId }, include: { cycle: true } });
  if (!app) throw new InterviewError("Application not found.");
  // A DRAFT application is not a real submission, so it must not be
  // interviewed (and later accepted) (audit3 L1).
  if (app.status !== "SUBMITTED") throw new InterviewError("This application hasn't been submitted yet.");
  // Interviews are the DIRECTOR-track review path. Volunteer applications are
  // decided directly by the routed department (decideRoutedApplication) with no interview.
  if (app.cycle.track !== "DIRECTOR") throw new InterviewError("Interviews apply to director cycles.");
  if (!app.cycle.departments.includes(departmentCode)) throw new InterviewError("That department is not part of this cycle.");
  const scope = await reviewScope(createdById);
  if (!(scope.all || scope.departmentCodes.includes(departmentCode))) {
    throw new RecruitmentAuthError("You can't manage interviews for that department.");
  }
  if (!scope.all && !app.departmentChoices.includes(departmentCode)) {
    throw new RecruitmentAuthError("This applicant did not rank that department.");
  }
  try {
    const interview = await prisma.interview.create({ data: { applicationId, departmentCode, createdById } });
    await recordAudit({ actorPersonId: createdById, action: "recruitment.interview_create", entityType: "Interview", entityId: interview.id, after: { applicationId, departmentCode } });
    return interview;
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new InterviewError("An interview already exists for that department.");
    }
    throw err;
  }
}

export async function updateInterview(
  interviewId: string,
  patch: { scheduledAt?: Date | null; zoomLink?: string | null; notes?: string | null },
  actorId: string
): Promise<Interview> {
  const iv = await prisma.interview.findUnique({ where: { id: interviewId } });
  if (!iv) throw new InterviewError("Interview not found.");
  await assertCanManage(iv.departmentCode, actorId);
  return prisma.interview.update({
    where: { id: interviewId },
    data: {
      scheduledAt: patch.scheduledAt === undefined ? undefined : patch.scheduledAt,
      zoomLink: patch.zoomLink === undefined ? undefined : patch.zoomLink,
      notes: patch.notes === undefined ? undefined : patch.notes,
    },
  });
}

/**
 * Build the notification a panelist receives when added to a panel by someone
 * else. It is their only inbound signal: the interview invite goes to the
 * applicant, not the panel, and a panelist who is not recruitment staff has no
 * recruitment hub tile or nav. The link points at their My interviews page.
 * Returns null when the panelist record can't be loaded. `iv` must include
 * application.applicant.
 */
async function buildPanelistAssignmentNotify(
  iv: { departmentCode: string; application: { applicant: { firstName: string; lastName: string } } },
  panelistId: string,
  actorId: string,
): Promise<NotifyInput | null> {
  const [panelist, dept, baseUrl] = await Promise.all([
    prisma.person.findUnique({
      where: { id: panelistId },
      select: { id: true, name: true, entraObjectId: true, contactEmail: true },
    }),
    prisma.department.findUnique({ where: { code: iv.departmentCode }, select: { name: true } }),
    getSetting<string>("app.baseUrl"),
  ]);
  if (!panelist) return null;

  const candidateName = `${iv.application.applicant.firstName} ${iv.application.applicant.lastName}`.trim();
  const departmentName = dept?.name ?? iv.departmentCode;
  const interviewsUrl = `${baseUrl}/recruitment/interviews`;
  const panelistFirstName = panelist.name?.trim().split(/\s+/)[0] || "there";

  const { subject, html } = await renderEmail("recruitment.interview_assignment", {
    panelistFirstName,
    candidateName,
    departmentName,
    interviewsUrl,
  });

  return {
    type: "recruitment.interview_assignment",
    person: { id: panelist.id, entraObjectId: panelist.entraObjectId, contactEmail: panelist.contactEmail },
    email: { subject, html },
    teams: {
      title: "New interview assignment",
      summary: `You're on the interview panel for ${candidateName} (${departmentName} director interview).`,
      link: interviewsUrl,
    },
    triggeredById: actorId,
  };
}

export async function addPanelist(interviewId: string, personId: string, isLead: boolean, actorId: string): Promise<InterviewPanelist> {
  const iv = await prisma.interview.findUnique({
    where: { id: interviewId },
    include: { application: { include: { applicant: { select: { firstName: true, lastName: true } } } } },
  });
  if (!iv) throw new InterviewError("Interview not found.");
  await assertCanManage(iv.departmentCode, actorId);

  let created: InterviewPanelist;
  try {
    created = await prisma.interviewPanelist.create({ data: { interviewId, personId, isLead } });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new InterviewError("That person is already on the panel.");
    }
    throw err;
  }

  // Notify the panelist AFTER the panel row commits. Skip self-adds: a manager
  // adding themselves already knows. Notifications are best-effort side effects,
  // so they run post-commit on the global client, the pattern every other notify
  // caller uses. This keeps notify()'s Microsoft Graph identity lookup out of the
  // panel-row transaction, where a slow, un-timed lookup could exceed Prisma's
  // interactive-transaction timeout and roll back an otherwise-valid panelist add
  // (audit M11); it also means a rejected duplicate never enqueues a stray
  // notification. All data the notify needs (iv, personId, actorId) is available
  // here, and buildPanelistAssignmentNotify re-reads the person fresh.
  if (personId !== actorId) {
    const assignment = await buildPanelistAssignmentNotify(iv, personId, actorId);
    if (assignment) await notify(prisma, assignment);
  }

  return created;
}

/**
 * Active people who may be added to an interview's panel, by name. Excludes
 * anyone already on the panel so the picker never offers a duplicate (which the
 * unique constraint would reject anyway). Powers the panelist search dropdown.
 */
export async function listPanelistCandidates(interviewId: string): Promise<{ id: string; name: string }[]> {
  const existing = await prisma.interviewPanelist.findMany({ where: { interviewId }, select: { personId: true } });
  const exclude = existing.map((p) => p.personId);
  return prisma.person.findMany({
    where: { status: "ACTIVE", ...(exclude.length ? { id: { notIn: exclude } } : {}) },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

export async function removePanelist(panelistId: string, actorId: string): Promise<void> {
  const p = await prisma.interviewPanelist.findUnique({ where: { id: panelistId }, include: { interview: true } });
  if (!p) throw new InterviewError("Panelist not found.");
  await assertCanManage(p.interview.departmentCode, actorId);
  await prisma.interviewPanelist.delete({ where: { id: panelistId } });
}

export async function sendInterviewInvite(interviewId: string, actorId: string): Promise<void> {
  const iv = await prisma.interview.findUnique({ where: { id: interviewId }, include: { application: { include: { applicant: true, cycle: { select: { id: true } } } } } });
  if (!iv) throw new InterviewError("Interview not found.");
  await assertCanManage(iv.departmentCode, actorId);
  if (!iv.scheduledAt) throw new InterviewError("Set an interview time first.");
  const dept = await prisma.department.findUnique({ where: { code: iv.departmentCode }, select: { name: true } });
  const applicant = iv.application.applicant;
  const zone = await getDisplayTimeZone();
  const interviewTime = formatDateTime(iv.scheduledAt, zone, { dateStyle: "full", timeStyle: "short" });
  const joinLink = iv.zoomLink ? `<a href="${esc(iv.zoomLink)}">${esc(iv.zoomLink)}</a>` : "link to follow";
  const email = await renderCycleEmail(iv.application.cycle.id, "recruitment.interview_invite", {
    firstName: applicant.firstName || "there",
    departmentName: dept?.name ?? iv.departmentCode,
    interviewTime,
    joinLink,
  });
  await prisma.$transaction(async (tx) => {
    await queueEmail(tx, { to: applicant.email, subject: email.subject, html: email.html, template: "recruitment.interview_invite" });
    await tx.interview.update({ where: { id: interviewId }, data: { invitedAt: new Date() } });
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.interview_invite", entityType: "Interview", entityId: interviewId });
}

export async function listInterviewsForReview(cycleId: string, viewerId: string) {
  const [scope, managesCycles] = await Promise.all([
    reviewScope(viewerId),
    can(viewerId, "recruitment.manage_cycles"),
  ]);
  const seeAll = scope.all || managesCycles;
  const interviews = await prisma.interview.findMany({
    where: { application: { cycleId } },
    include: {
      application: { include: { applicant: { select: { firstName: true, lastName: true, email: true } } } },
      panelists: true,
      evaluations: true,
    },
    orderBy: { createdAt: "desc" },
  });
  if (seeAll) return interviews;
  const mine = new Set(scope.departmentCodes);
  return interviews.filter((i) => mine.has(i.departmentCode));
}

export async function myAssignedInterviews(personId: string) {
  return prisma.interview.findMany({
    where: { panelists: { some: { personId } } },
    include: {
      application: { include: { applicant: { select: { firstName: true, lastName: true } }, cycle: { select: { id: true, title: true } } } },
      evaluations: { where: { evaluatorId: personId } },
    },
    orderBy: { scheduledAt: "asc" },
  });
}

/** True when the person sits on any interview panel. Drives the panelist-only
 *  "My interviews" nav tab and home quick action, which must appear even for
 *  panelists who are not recruitment staff (they hold no recruitment.access). */
export async function isInterviewPanelist(personId: string): Promise<boolean> {
  const count = await prisma.interviewPanelist.count({ where: { personId } });
  return count > 0;
}

export async function getInterview(interviewId: string) {
  return prisma.interview.findUnique({
    where: { id: interviewId },
    include: {
      // Acceptances ride along so the decision UI can warn when this department's
      // offer has already been emailed (an emailed acceptance blocks changing the
      // decision away from ACCEPT; see decideInterview / issue #77).
      application: { include: { applicant: true, cycle: true, acceptances: { select: { id: true, departmentCode: true, emailedAt: true } } } },
      panelists: { include: { person: { select: { id: true, name: true } } } },
      evaluations: { include: { evaluator: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } },
    },
  });
}

export async function listApplicationInterviews(applicationId: string) {
  return prisma.interview.findMany({ where: { applicationId }, select: { id: true, departmentCode: true } });
}
