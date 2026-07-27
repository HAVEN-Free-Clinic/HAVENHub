import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { queueEmail } from "@/platform/email/send";
import { recordAudit } from "@/platform/audit";
import { findAcceptanceConflicts } from "../engine/conflicts";
import { resolveCycleEmail, renderResolvedEmail } from "../email/render";
import { RecruitmentAuthError, AcceptanceError } from "./review";

export type Conflict = { applicationId: string; applicantName: string; departments: string[] };

export async function listConflicts(cycleId: string): Promise<Conflict[]> {
  const acceptances = await prisma.acceptance.findMany({
    where: { application: { cycleId } },
    include: { application: { include: { applicant: { select: { firstName: true, lastName: true } } } } },
  });
  const conflictIds = findAcceptanceConflicts(acceptances.map((a) => ({ applicationId: a.applicationId, departmentCode: a.departmentCode })));
  const byApp = new Map<string, Conflict>();
  for (const a of acceptances) {
    if (!conflictIds.has(a.applicationId)) continue;
    const existing = byApp.get(a.applicationId);
    if (existing) {
      existing.departments.push(a.departmentCode);
    } else {
      byApp.set(a.applicationId, {
        applicationId: a.applicationId,
        applicantName: `${a.application.applicant.firstName} ${a.application.applicant.lastName}`,
        departments: [a.departmentCode],
      });
    }
  }
  return [...byApp.values()];
}

export async function releaseSummary(cycleId: string): Promise<{
  acceptedApplications: number;
  conflictedApplications: number;
  unnotified: number;
  emailed: number;
}> {
  const acceptances = await prisma.acceptance.findMany({ where: { application: { cycleId } } });
  const conflictIds = findAcceptanceConflicts(acceptances.map((a) => ({ applicationId: a.applicationId, departmentCode: a.departmentCode })));
  const acceptedApplications = new Set(acceptances.map((a) => a.applicationId)).size;
  let unnotified = 0;
  let emailed = 0;
  for (const a of acceptances) {
    if (a.emailedAt) { emailed += 1; continue; }
    if (!conflictIds.has(a.applicationId)) unnotified += 1;
  }
  return { acceptedApplications, conflictedApplications: conflictIds.size, unnotified, emailed };
}

/** Render + queue the acceptance email for a single acceptance and atomically
 *  stamp emailedAt, using the SAME emailedAt: null claim as releaseDecisions so
 *  this path and a later Release never double-send. Used by the waitlist
 *  "promote to accept" flow to notify a promoted applicant immediately, without
 *  waiting for a separate release run. Skips (returns "conflicted") if the
 *  application now holds acceptances from more than one department, mirroring
 *  releaseDecisions' conflict skip -- the conflict must be resolved (and the
 *  cycle released) before that applicant is emailed. */
export async function sendAcceptanceEmail(
  applicationId: string,
  departmentCode: string,
): Promise<{ sent: boolean; reason?: "already_emailed" | "conflicted" | "not_found" }> {
  const acc = await prisma.acceptance.findUnique({
    where: { applicationId_departmentCode: { applicationId, departmentCode } },
    include: { application: { include: { applicant: true, cycle: { select: { id: true, title: true } } } } },
  });
  if (!acc) return { sent: false, reason: "not_found" };
  if (acc.emailedAt) return { sent: false, reason: "already_emailed" };
  // Conflict = this application accepted by more than one distinct department
  // (the single-application case of findAcceptanceConflicts). Don't notify until
  // the conflict is resolved and the cycle released.
  const appAcceptances = await prisma.acceptance.findMany({ where: { applicationId }, select: { departmentCode: true } });
  if (new Set(appAcceptances.map((a) => a.departmentCode)).size > 1) return { sent: false, reason: "conflicted" };

  const dept = await prisma.department.findUnique({ where: { code: departmentCode }, select: { name: true } });
  const sources = await resolveCycleEmail(acc.application.cycle.id, "recruitment.acceptance");
  const email = renderResolvedEmail(sources, {
    firstName: acc.application.applicant.firstName || "there",
    cycleTitle: acc.application.cycle.title,
    departmentName: dept?.name ?? departmentCode,
  });
  const sent = await prisma.$transaction(async (tx) => {
    // Atomic claim mirrors releaseDecisions: only one caller can flip emailedAt,
    // so a concurrent release/promote can't re-queue or re-stamp (audit3 L15).
    const claimed = await tx.acceptance.updateMany({ where: { id: acc.id, emailedAt: null }, data: { emailedAt: new Date() } });
    if (claimed.count !== 1) return false;
    await queueEmail(tx, { to: acc.application.applicant.email, subject: email.subject, html: email.html, template: "recruitment.acceptance" });
    return true;
  });
  return sent ? { sent: true } : { sent: false, reason: "already_emailed" };
}

/** Email every accepted, non-conflicted, un-emailed applicant once; stamp
 *  emailedAt. Idempotent. Conflicted applications are skipped (counted by
 *  distinct application). Requires review_all. */
export async function releaseDecisions(cycleId: string, actorId: string): Promise<{ sent: number; skippedConflicted: number }> {
  if (!(await can(actorId, "recruitment.review_all"))) throw new RecruitmentAuthError("Only SRR can release decisions.");
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new AcceptanceError("Cycle not found.");
  if (cycle.status === "DRAFT" || cycle.status === "ARCHIVED") {
    throw new AcceptanceError("Decisions can only be released for an open or closed cycle.");
  }

  const acceptances = await prisma.acceptance.findMany({
    where: { application: { cycleId } },
    include: { application: { include: { applicant: true } } },
  });

  // Key the dept-name map off the acceptances actually being emailed, not just
  // cycle.departments (#100): setCycleDepartments allows removing a department that
  // still has applicants (it only warns), so an Acceptance.departmentCode can fall
  // outside cycle.departments -- and then the map missed and the applicant-facing
  // acceptance email interpolated the bare CODE instead of the department name.
  const deptCodes = [...new Set([...cycle.departments, ...acceptances.map((a) => a.departmentCode)])];
  const depts = await prisma.department.findMany({ where: { code: { in: deptCodes } }, select: { code: true, name: true } });
  const deptName = new Map(depts.map((d) => [d.code, d.name]));
  const conflictIds = findAcceptanceConflicts(acceptances.map((a) => ({ applicationId: a.applicationId, departmentCode: a.departmentCode })));

  // Resolve the acceptance email sources once for the whole cycle.
  const acceptanceSources = await resolveCycleEmail(cycleId, "recruitment.acceptance");

  let sent = 0;
  const skippedApps = new Set<string>();
  for (const acc of acceptances) {
    if (acc.emailedAt) continue;
    if (conflictIds.has(acc.applicationId)) { skippedApps.add(acc.applicationId); continue; }
    const applicant = acc.application.applicant;
    const email = renderResolvedEmail(acceptanceSources, {
      firstName: applicant.firstName || "there",
      cycleTitle: cycle.title,
      departmentName: deptName.get(acc.departmentCode) ?? acc.departmentCode,
    });
    const claimedByThisRelease = await prisma.$transaction(async (tx) => {
      // Claim the send atomically: the emailedAt: null precondition means only one
      // of two concurrent releases can stamp this acceptance, so the loser neither
      // re-queues the acceptance email nor re-stamps emailedAt (audit3 L15).
      const claimed = await tx.acceptance.updateMany({ where: { id: acc.id, emailedAt: null }, data: { emailedAt: new Date() } });
      if (claimed.count !== 1) return false;
      await queueEmail(tx, { to: applicant.email, subject: email.subject, html: email.html, template: "recruitment.acceptance" });
      return true;
    });
    if (claimedByThisRelease) sent += 1;
  }

  // Mark the cycle's decisions released so the applicant portal may surface
  // final outcomes (accepted via emailedAt, not-selected/waitlist via this stamp).
  await prisma.recruitmentCycle.update({ where: { id: cycleId }, data: { decisionsReleasedAt: new Date() } });

  await recordAudit({ actorPersonId: actorId, action: "recruitment.release", entityType: "RecruitmentCycle", entityId: cycleId, after: { sent, skippedConflicted: skippedApps.size } });
  return { sent, skippedConflicted: skippedApps.size };
}
