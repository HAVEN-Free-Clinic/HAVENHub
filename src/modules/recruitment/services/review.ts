import type { Acceptance, Application } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { manageableDepartmentIds } from "@/platform/departments";
import { recordAudit } from "@/platform/audit";

export class RecruitmentAuthError extends Error {
  constructor(message: string) { super(message); this.name = "RecruitmentAuthError"; }
}
export class AcceptanceError extends Error {
  constructor(message: string) { super(message); this.name = "AcceptanceError"; }
}

export type ReviewScope = { all: boolean; departmentCodes: string[] };

/** A reviewer's scope: SRR (review_all) sees everything; a director sees the
 *  departments they direct (active-term DIRECTOR memberships + one-hop delegation,
 *  via manageableDepartmentIds), mapped from ids to codes. */
export async function reviewScope(personId: string): Promise<ReviewScope> {
  const all = await can(personId, "recruitment.review_all");
  const deptIds = await manageableDepartmentIds(personId);
  let departmentCodes: string[] = [];
  if (deptIds.length > 0) {
    const depts = await prisma.department.findMany({ where: { id: { in: deptIds } }, select: { code: true } });
    departmentCodes = depts.map((d) => d.code);
  }
  return { all, departmentCodes };
}

export type ReviewApplication = Application & {
  applicant: { firstName: string; lastName: string; email: string };
  acceptances: Acceptance[];
  committeeScores: { score: number }[];
  interviews: { decision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST" }[];
};

/** Applications a viewer may review for a cycle. SRR/review_all (and cycle
 *  managers, and committee scorers) see all; a director sees only applications
 *  intersecting their department codes. */
export async function listApplicantsForReview(cycleId: string, viewerId: string): Promise<ReviewApplication[]> {
  const [scope, managesCycles, canScore] = await Promise.all([
    reviewScope(viewerId),
    can(viewerId, "recruitment.manage_cycles"),
    can(viewerId, "recruitment.score"),
  ]);
  const seeAll = scope.all || managesCycles || canScore;
  const apps = await prisma.application.findMany({
    where: { cycleId, status: "SUBMITTED" },
    include: {
      applicant: { select: { firstName: true, lastName: true, email: true } },
      acceptances: true,
      committeeScores: { select: { score: true } },
      interviews: { select: { decision: true } },
    },
    orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
  });
  if (seeAll) return apps;
  const mine = new Set(scope.departmentCodes);
  // Director queues are driven by committee ROUTING, not applicant choice: a
  // director sees the applications routed to a department they direct.
  return apps.filter((a) => a.routedDepartmentCode != null && mine.has(a.routedDepartmentCode));
}

export async function listAcceptances(applicationId: string): Promise<Acceptance[]> {
  return prisma.acceptance.findMany({ where: { applicationId }, orderBy: { createdAt: "asc" } });
}

export async function revokeAcceptance(acceptanceId: string, actorId: string): Promise<void> {
  const acc = await prisma.acceptance.findUnique({
    where: { id: acceptanceId },
    include: { contract: { select: { id: true, status: true } } },
  });
  if (!acc) throw new AcceptanceError("Acceptance not found.");
  // OnboardingContract.acceptance is onDelete: Cascade, so deleting an acceptance
  // that already has a contract would silently destroy a submitted or promoted
  // onboarding record (signatures, DOB, HIPAA cert) and orphan its stored blob.
  // Tearing down the onboarding contract is the deliberate, separate teardown path
  // (mirrors the guard in interview-decisions.ts), so block the revoke here.
  if (acc.contract) {
    throw new AcceptanceError("This applicant has an onboarding contract. Remove the onboarding contract before revoking the acceptance.");
  }
  const scope = await reviewScope(actorId);
  const inScope = scope.all || scope.departmentCodes.includes(acc.departmentCode);
  if (!inScope) throw new RecruitmentAuthError("You can't revoke that acceptance.");
  if (acc.emailedAt && !scope.all) {
    throw new RecruitmentAuthError("This applicant was already notified; ask SRR to revoke.");
  }
  await prisma.acceptance.delete({ where: { id: acceptanceId } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.revoke", entityType: "Acceptance", entityId: acceptanceId, before: { applicationId: acc.applicationId, departmentCode: acc.departmentCode } });
}
