import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { queueEmail } from "@/platform/email/send";
import { recordAudit } from "@/platform/audit";
import { findAcceptanceConflicts } from "../engine/conflicts";
import { acceptanceEmail } from "../email/templates/acceptance";
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

  const depts = await prisma.department.findMany({ where: { code: { in: cycle.departments } }, select: { code: true, name: true } });
  const deptName = new Map(depts.map((d) => [d.code, d.name]));

  const acceptances = await prisma.acceptance.findMany({
    where: { application: { cycleId } },
    include: { application: { include: { applicant: true } } },
  });
  const conflictIds = findAcceptanceConflicts(acceptances.map((a) => ({ applicationId: a.applicationId, departmentCode: a.departmentCode })));

  let sent = 0;
  const skippedApps = new Set<string>();
  for (const acc of acceptances) {
    if (acc.emailedAt) continue;
    if (conflictIds.has(acc.applicationId)) { skippedApps.add(acc.applicationId); continue; }
    const applicant = acc.application.applicant;
    const email = acceptanceEmail({ firstName: applicant.firstName, cycleTitle: cycle.title, departmentName: deptName.get(acc.departmentCode) ?? acc.departmentCode });
    await prisma.$transaction(async (tx) => {
      await queueEmail(tx, { to: applicant.email, subject: email.subject, html: email.html, template: "recruitment.acceptance" });
      await tx.acceptance.update({ where: { id: acc.id }, data: { emailedAt: new Date() } });
    });
    sent += 1;
  }

  await recordAudit({ actorPersonId: actorId, action: "recruitment.release", entityType: "RecruitmentCycle", entityId: cycleId, after: { sent, skippedConflicted: skippedApps.size } });
  return { sent, skippedConflicted: skippedApps.size };
}
