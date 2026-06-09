import type { Interview, InterviewPanelist } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { queueEmail } from "@/platform/email/send";
import { recordAudit } from "@/platform/audit";
import { reviewScope, RecruitmentAuthError } from "./review";
import { interviewInviteEmail } from "../email/templates/interview-invite";

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
    if (typeof err === "object" && err && "code" in err && (err as { code?: string }).code === "P2002") {
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

export async function addPanelist(interviewId: string, personId: string, isLead: boolean, actorId: string): Promise<InterviewPanelist> {
  const iv = await prisma.interview.findUnique({ where: { id: interviewId } });
  if (!iv) throw new InterviewError("Interview not found.");
  await assertCanManage(iv.departmentCode, actorId);
  try {
    return await prisma.interviewPanelist.create({ data: { interviewId, personId, isLead } });
  } catch (err) {
    if (typeof err === "object" && err && "code" in err && (err as { code?: string }).code === "P2002") {
      throw new InterviewError("That person is already on the panel.");
    }
    throw err;
  }
}

export async function removePanelist(panelistId: string, actorId: string): Promise<void> {
  const p = await prisma.interviewPanelist.findUnique({ where: { id: panelistId }, include: { interview: true } });
  if (!p) throw new InterviewError("Panelist not found.");
  await assertCanManage(p.interview.departmentCode, actorId);
  await prisma.interviewPanelist.delete({ where: { id: panelistId } });
}

export async function sendInterviewInvite(interviewId: string, actorId: string): Promise<void> {
  const iv = await prisma.interview.findUnique({ where: { id: interviewId }, include: { application: { include: { applicant: true } } } });
  if (!iv) throw new InterviewError("Interview not found.");
  await assertCanManage(iv.departmentCode, actorId);
  if (!iv.scheduledAt) throw new InterviewError("Set an interview time first.");
  const dept = await prisma.department.findUnique({ where: { code: iv.departmentCode }, select: { name: true } });
  const applicant = iv.application.applicant;
  const email = interviewInviteEmail({ firstName: applicant.firstName, departmentName: dept?.name ?? iv.departmentCode, scheduledAt: iv.scheduledAt, zoomLink: iv.zoomLink });
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

export async function getInterview(interviewId: string) {
  return prisma.interview.findUnique({
    where: { id: interviewId },
    include: {
      application: { include: { applicant: true, cycle: true } },
      panelists: { include: { person: { select: { id: true, name: true } } } },
      evaluations: { include: { evaluator: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } },
    },
  });
}

export async function listApplicationInterviews(applicationId: string) {
  return prisma.interview.findMany({ where: { applicationId }, select: { id: true, departmentCode: true } });
}
