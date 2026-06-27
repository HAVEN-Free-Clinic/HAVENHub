import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { reviewScope, RecruitmentAuthError } from "./review";

export class SubcommitteeAssignError extends Error {
  constructor(message: string) { super(message); this.name = "SubcommitteeAssignError"; }
}

/** Recruitment leads only: review_all or manage_cycles. */
async function assertLead(actorId: string): Promise<void> {
  const [scope, managesCycles] = await Promise.all([
    reviewScope(actorId),
    can(actorId, "recruitment.manage_cycles"),
  ]);
  if (!(scope.all || managesCycles)) {
    throw new RecruitmentAuthError("Only recruitment leads can assign subcommittees.");
  }
}

/** Assign (or clear with null) the final subcommittee for an accepted applicant. */
export async function assignSubcommittee(
  applicationId: string,
  subcommitteeId: string | null,
  actorId: string
): Promise<void> {
  await assertLead(actorId);

  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { _count: { select: { acceptances: true } } },
  });
  if (!app) throw new SubcommitteeAssignError("Application not found.");
  if (app._count.acceptances === 0) {
    throw new SubcommitteeAssignError("Assign a subcommittee only after the applicant is accepted.");
  }

  if (subcommitteeId !== null) {
    const sub = await prisma.subcommittee.findFirst({ where: { id: subcommitteeId, isActive: true } });
    if (!sub) throw new SubcommitteeAssignError("That subcommittee is not available.");
  }

  await prisma.application.update({
    where: { id: applicationId },
    data: {
      assignedSubcommitteeId: subcommitteeId,
      assignedSubcommitteeById: subcommitteeId === null ? null : actorId,
      assignedSubcommitteeAt: subcommitteeId === null ? null : new Date(),
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.subcommittee_assign",
    entityType: "Application",
    entityId: applicationId,
    after: { assignedSubcommitteeId: subcommitteeId },
  });
}

export type AssignmentRow = {
  applicationId: string;
  applicant: { firstName: string; lastName: string; email: string };
  acceptedDepartments: string[];
  ranking: { id: string; name: string; active: boolean }[];
  assignedSubcommitteeId: string | null;
};

/** Accepted applicants for a cycle (>=1 acceptance) with their ranked preferences
 *  resolved to names + current assignment. Leads only. */
export async function listAcceptedForAssignment(cycleId: string, viewerId: string): Promise<AssignmentRow[]> {
  await assertLead(viewerId);

  const apps = await prisma.application.findMany({
    where: { cycleId, acceptances: { some: {} } },
    include: {
      applicant: { select: { firstName: true, lastName: true, email: true } },
      acceptances: { select: { departmentCode: true }, orderBy: { createdAt: "asc" } },
    },
    orderBy: { submittedAt: "desc" },
  });

  // Resolve every referenced subcommittee id (active or not) to a name in one query.
  const ids = [...new Set(apps.flatMap((a) => a.subcommitteeRanking))];
  const subs = ids.length
    ? await prisma.subcommittee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, isActive: true } })
    : [];
  const byId = new Map(subs.map((s) => [s.id, s]));

  return apps.map((a) => ({
    applicationId: a.id,
    applicant: a.applicant,
    acceptedDepartments: [...new Set(a.acceptances.map((x) => x.departmentCode))],
    ranking: a.subcommitteeRanking
      .map((id) => byId.get(id))
      .filter((s): s is { id: string; name: string; isActive: boolean } => Boolean(s))
      .map((s) => ({ id: s.id, name: s.name, active: s.isActive })),
    assignedSubcommitteeId: a.assignedSubcommitteeId,
  }));
}

/** Active subcommittees offered in the assignment dropdown. */
export async function listAssignableSubcommittees(): Promise<{ id: string; name: string }[]> {
  return prisma.subcommittee.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: [{ order: "asc" }, { name: "asc" }],
  });
}
