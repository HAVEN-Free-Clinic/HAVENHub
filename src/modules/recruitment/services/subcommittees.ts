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

export type SubcommitteeChange = { applicationId: string; subcommitteeId: string | null };

/**
 * Assign (or clear with null) the final subcommittee for accepted applicants of
 * one cycle, as many as the Subcommittees page's single Save sends.
 *
 * All or nothing: every change is checked before any is written, so one bad row
 * cannot leave the table half saved. The page used to save one row per click,
 * which across a cycle's worth of acceptances (183 in Fall 2026) was a click
 * and a full reload per person. Each change still writes its own audit row.
 */
export async function assignSubcommittees(
  cycleId: string,
  changes: SubcommitteeChange[],
  actorId: string,
): Promise<number> {
  await assertLead(actorId);
  if (changes.length === 0) return 0;

  const ids = new Set(changes.map((c) => c.applicationId));
  if (ids.size !== changes.length) {
    throw new SubcommitteeAssignError("An applicant appears twice in one save.");
  }
  const apps = await prisma.application.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, cycleId: true, _count: { select: { acceptances: true } } },
  });
  const byId = new Map(apps.map((a) => [a.id, a]));
  for (const c of changes) {
    const app = byId.get(c.applicationId);
    // Another cycle's application is "not found" from here: the page that sent
    // it only ever lists this cycle's.
    if (!app || app.cycleId !== cycleId) throw new SubcommitteeAssignError("Application not found.");
    if (app._count.acceptances === 0) {
      throw new SubcommitteeAssignError("Assign a subcommittee only after the applicant is accepted.");
    }
  }

  const subIds = [...new Set(changes.flatMap((c) => (c.subcommitteeId === null ? [] : [c.subcommitteeId])))];
  if (subIds.length > 0) {
    const active = await prisma.subcommittee.count({ where: { id: { in: subIds }, isActive: true } });
    if (active !== subIds.length) throw new SubcommitteeAssignError("That subcommittee is not available.");
  }

  const now = new Date();
  await prisma.$transaction(
    changes.map((c) =>
      prisma.application.update({
        where: { id: c.applicationId },
        data: {
          assignedSubcommitteeId: c.subcommitteeId,
          assignedSubcommitteeById: c.subcommitteeId === null ? null : actorId,
          assignedSubcommitteeAt: c.subcommitteeId === null ? null : now,
        },
      }),
    ),
  );
  for (const c of changes) {
    await recordAudit({
      actorPersonId: actorId,
      action: "recruitment.subcommittee_assign",
      entityType: "Application",
      entityId: c.applicationId,
      after: { assignedSubcommitteeId: c.subcommitteeId },
    });
  }
  return changes.length;
}

type SubcommitteeRef = { id: string; name: string; active: boolean };

export type AssignmentRow = {
  applicationId: string;
  applicant: { firstName: string; lastName: string; email: string };
  acceptedDepartments: string[];
  ranking: SubcommitteeRef[];
  assignedSubcommitteeId: string | null;
  /**
   * The current assignment, resolved even when that subcommittee has since
   * been deactivated. The dropdown offers active subcommittees only, so without
   * this a row assigned to an inactive one would render as "Unassigned", and
   * the page's single Save would clear it while saving some other row.
   */
  assignedSubcommittee: SubcommitteeRef | null;
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

  // Resolve every referenced subcommittee id (ranked or assigned, active or not)
  // to a name in one query.
  const ids = [
    ...new Set(apps.flatMap((a) => [...a.subcommitteeRanking, ...(a.assignedSubcommitteeId ? [a.assignedSubcommitteeId] : [])])),
  ];
  const subs = ids.length
    ? await prisma.subcommittee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, isActive: true } })
    : [];
  const byId = new Map(subs.map((s) => [s.id, s]));
  const ref = (id: string): SubcommitteeRef | null => {
    const s = byId.get(id);
    return s ? { id: s.id, name: s.name, active: s.isActive } : null;
  };

  return apps.map((a) => ({
    applicationId: a.id,
    applicant: a.applicant,
    acceptedDepartments: [...new Set(a.acceptances.map((x) => x.departmentCode))],
    ranking: a.subcommitteeRanking.map(ref).filter((s): s is SubcommitteeRef => s !== null),
    assignedSubcommitteeId: a.assignedSubcommitteeId,
    assignedSubcommittee: a.assignedSubcommitteeId ? ref(a.assignedSubcommitteeId) : null,
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
