import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { peopleWithPermission } from "@/platform/rbac/permission-holders";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";
import { allocateAssignments, type AssignmentPair } from "../engine/score-assignment";
import { applicationStage, isHandledStage } from "../engine/application-stage";
import { applicationOwnerAmong } from "../engine/own-application";
import { reviewerIdentities } from "./own-application";

export class ScoreAssignmentError extends Error {
  constructor(message: string) { super(message); this.name = "ScoreAssignmentError"; }
}

/** Widest target the panel will accept. Far above any real committee, and there
 *  only so a fat-fingered number cannot write thousands of rows. */
const MAX_TARGET = 20;

/**
 * The applications a cycle's committee still owes a read.
 *
 * Derived through applicationStage, not queried by column, so this list and the
 * roster's Stage column can never disagree about what is still open. Renewals
 * and first-choice submissions are routed at submit and documented as skipping
 * committee scoring, so they are already handled and never get divided out.
 */
async function eligibleApplications(cycleId: string) {
  const rows = await prisma.application.findMany({
    where: { cycleId, status: "SUBMITTED" },
    select: {
      id: true,
      routedDepartmentCode: true,
      returnedToRoutingAt: true,
      decision: true,
      applicant: { select: { applicantPersonId: true, emailLower: true, netId: true } },
      committeeScores: { select: { scorerId: true } },
      interviews: { select: { decision: true } },
    },
    orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
  });
  return rows
    .filter(
      (a) =>
        !isHandledStage(
          applicationStage({
            scoreCount: a.committeeScores.length,
            routedDepartmentCode: a.routedDepartmentCode,
            returnedToRoutingAt: a.returnedToRoutingAt,
            applicationDecision: a.decision,
            interviews: a.interviews,
          }),
        ),
    )
    .map((a) => ({
      id: a.id,
      applicant: a.applicant,
      scorerIds: a.committeeScores.map((c) => c.scorerId),
    }));
}

export type ScoringPanel = {
  target: number;
  /** Every recruitment.score holder, whether or not they are in this pool. */
  candidates: { personId: string; name: string; inPool: boolean; assigned: number; scored: number }[];
  /** Applications still open to committee scoring. */
  eligibleCount: number;
  /** How many of those have fewer than `target` scorers on them. */
  underTargetCount: number;
  /** Set when the pool is too small to reach the target, so the panel can say
   *  so rather than leaving the lead to wonder why nothing reaches it. */
  poolTooSmall: boolean;
};

/** Everything the assignment panel renders. review_all only, matching the gate
 *  on the routing thresholds it sits beside. */
export async function loadScoringPanel(cycleId: string, viewerId: string): Promise<ScoringPanel> {
  if (!(await can(viewerId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't manage scoring assignments.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id: cycleId },
    select: { scoresPerApplication: true },
  });
  if (!cycle) throw new ScoreAssignmentError("Cycle not found.");

  const [holders, pool, applications] = await Promise.all([
    peopleWithPermission("recruitment.score"),
    prisma.cycleScorer.findMany({ where: { cycleId }, select: { personId: true } }),
    eligibleApplications(cycleId),
  ]);
  const eligibleIds = applications.map((a) => a.id);
  const assignments = await prisma.scoreAssignment.findMany({
    where: { applicationId: { in: eligibleIds } },
    select: { applicationId: true, scorerId: true },
  });

  const inPool = new Set(pool.map((p) => p.personId));
  const assignedBy = new Map<string, number>();
  for (const a of assignments) assignedBy.set(a.scorerId, (assignedBy.get(a.scorerId) ?? 0) + 1);
  const scoredBy = new Map<string, number>();
  for (const a of applications) {
    for (const scorerId of a.scorerIds) scoredBy.set(scorerId, (scoredBy.get(scorerId) ?? 0) + 1);
  }
  // Assigned OR scored: an application a lead read from the detail page is
  // covered by that read, whether or not anyone was ever assigned to it.
  const coverage = new Map<string, Set<string>>();
  for (const a of applications) coverage.set(a.id, new Set(a.scorerIds));
  for (const a of assignments) coverage.get(a.applicationId)?.add(a.scorerId);

  const target = cycle.scoresPerApplication;
  return {
    target,
    candidates: holders.map((h) => ({
      personId: h.id,
      name: h.name,
      inPool: inPool.has(h.id),
      assigned: assignedBy.get(h.id) ?? 0,
      scored: scoredBy.get(h.id) ?? 0,
    })),
    eligibleCount: applications.length,
    underTargetCount: [...coverage.values()].filter((who) => who.size < target).length,
    poolTooSmall: pool.length > 0 && pool.length < target,
  };
}

/**
 * Save who is scoring this cycle and how many reads each application needs,
 * then divide the roster up to match.
 *
 * Idempotent and incremental: press it again after a late application arrives
 * and it tops up only what is short; lower the target and it takes back the
 * unstarted surplus. See allocateAssignments for the rules that make re-running
 * safe (a recorded score is never undone, and only unscored work moves).
 *
 * Emptying the pool turns the whole feature off for the cycle: the assignments
 * go, and every recruitment.score holder is back to seeing the full roster.
 */
export async function setCycleScoring(
  cycleId: string,
  input: { scorerIds: string[]; target: number },
  actorId: string,
): Promise<{ added: number; removed: number }> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't manage scoring assignments.");
  }
  if (!Number.isInteger(input.target) || input.target < 1 || input.target > MAX_TARGET) {
    throw new ScoreAssignmentError(`Scores per application must be a whole number from 1 to ${MAX_TARGET}.`);
  }
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { id: true } });
  if (!cycle) throw new ScoreAssignmentError("Cycle not found.");

  // Pool membership is a filter over people who can already score, never a
  // grant. Anyone not holding recruitment.score would sit in the pool with an
  // assigned pile they are not allowed to open.
  const scorerIds = [...new Set(input.scorerIds)];
  if (scorerIds.length > 0) {
    const allowed = new Set((await peopleWithPermission("recruitment.score")).map((p) => p.id));
    const rejected = scorerIds.filter((id) => !allowed.has(id));
    if (rejected.length > 0) {
      throw new ScoreAssignmentError("Everyone scoring a cycle needs the committee scoring permission.");
    }
  }

  const [applications, poolIdentities] = await Promise.all([
    eligibleApplications(cycleId),
    reviewerIdentities(scorerIds),
  ]);
  const eligibleIds = applications.map((a) => a.id);
  const existing = await prisma.scoreAssignment.findMany({
    where: { applicationId: { in: eligibleIds } },
    select: { applicationId: true, scorerId: true },
  });
  const scored: AssignmentPair[] = applications.flatMap((a) =>
    a.scorerIds.map((scorerId) => ({ applicationId: a.id, scorerId })),
  );

  const { add, remove } = allocateAssignments({
    applications: applications.map((a) => ({ id: a.id, applicantPersonId: applicationOwnerAmong(a.applicant, poolIdentities) })),
    scorerIds,
    target: input.target,
    existing,
    scored,
  });

  // One delete per scorer, not per assignment. Lowering the target on a full
  // cycle takes back hundreds of rows, and a pool is only ever a handful of
  // people.
  const removeByScorer = new Map<string, string[]>();
  for (const r of remove) {
    const ids = removeByScorer.get(r.scorerId);
    if (ids) ids.push(r.applicationId);
    else removeByScorer.set(r.scorerId, [r.applicationId]);
  }

  // Everything above is a read or a pure computation, so the transaction holds
  // only writes. A statement that fails inside a Postgres transaction aborts
  // the whole thing, and there is nothing here worth catching and continuing
  // past: a half-applied division is worse than none.
  await prisma.$transaction([
    prisma.recruitmentCycle.update({ where: { id: cycleId }, data: { scoresPerApplication: input.target } }),
    prisma.cycleScorer.deleteMany({
      // An empty notIn matches nothing in Prisma, which would silently keep the
      // whole pool on the one call that means to clear it.
      where: scorerIds.length > 0 ? { cycleId, personId: { notIn: scorerIds } } : { cycleId },
    }),
    ...scorerIds.map((personId) =>
      prisma.cycleScorer.upsert({
        where: { cycleId_personId: { cycleId, personId } },
        create: { cycleId, personId },
        update: {},
      }),
    ),
    ...[...removeByScorer].map(([scorerId, applicationIds]) =>
      prisma.scoreAssignment.deleteMany({ where: { scorerId, applicationId: { in: applicationIds } } }),
    ),
    ...(add.length > 0 ? [prisma.scoreAssignment.createMany({ data: add, skipDuplicates: true })] : []),
  ]);

  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.score_assignments",
    entityType: "RecruitmentCycle",
    entityId: cycleId,
    after: { target: input.target, scorers: scorerIds.length, added: add.length, removed: remove.length },
  });
  return { added: add.length, removed: remove.length };
}

/**
 * Give one application that has just come back to the committee its readers,
 * the way the panel's Save would, without touching anyone else's pile.
 *
 * Called when a department hands an application back (returnToRouting). An
 * application routed at submission, as renewals and first-choice departments
 * are, was never in the division, so it came back to "Needs re-routing"
 * assigned to nobody and, on a pooled cycle, sat in no scorer's queue.
 *
 * Runs the ordinary allocation over the whole open roster so the new readers
 * are the least-loaded scorers, but writes only this application's additions
 * and none of the removals: a hand-back is not the moment to reshuffle other
 * piles. The application goes first so its picks see today's loads, not loads
 * inflated by top-ups for other short applications that are not being written.
 *
 * A no-op on a cycle with no pool, where every scorer already sees everything.
 */
export async function assignReturnedApplication(cycleId: string, applicationId: string): Promise<number> {
  const [cycle, pool] = await Promise.all([
    prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { scoresPerApplication: true } }),
    prisma.cycleScorer.findMany({ where: { cycleId }, select: { personId: true } }),
  ]);
  if (!cycle || pool.length === 0) return 0;

  const [applications, poolIdentities] = await Promise.all([
    eligibleApplications(cycleId),
    reviewerIdentities(pool.map((p) => p.personId)),
  ]);
  const returned = applications.find((a) => a.id === applicationId);
  if (!returned) return 0;
  const ordered = [returned, ...applications.filter((a) => a.id !== applicationId)];
  const existing = await prisma.scoreAssignment.findMany({
    where: { applicationId: { in: ordered.map((a) => a.id) } },
    select: { applicationId: true, scorerId: true },
  });

  const { add } = allocateAssignments({
    applications: ordered.map((a) => ({ id: a.id, applicantPersonId: applicationOwnerAmong(a.applicant, poolIdentities) })),
    scorerIds: pool.map((p) => p.personId),
    target: cycle.scoresPerApplication,
    existing,
    scored: ordered.flatMap((a) => a.scorerIds.map((scorerId) => ({ applicationId: a.id, scorerId }))),
  });
  const mine = add.filter((a) => a.applicationId === applicationId);
  if (mine.length > 0) {
    await prisma.scoreAssignment.createMany({ data: mine, skipDuplicates: true });
  }
  return mine.length;
}

export type QueueScope = {
  /** False when the cycle has no pool. Every recruitment.score holder then sees
   *  the whole roster, exactly as they did before assignments existed. */
  pooled: boolean;
  assignedIds: Set<string>;
};

/** What this scorer has been given on this cycle. Read by the speed-score queue
 *  and by the detail page, so the queue and the "not assigned to you" note can
 *  never disagree. */
export async function scorerQueueScope(cycleId: string, scorerId: string): Promise<QueueScope> {
  const [poolSize, mine] = await Promise.all([
    prisma.cycleScorer.count({ where: { cycleId } }),
    prisma.scoreAssignment.findMany({
      where: { scorerId, application: { cycleId } },
      select: { applicationId: true },
    }),
  ]);
  if (poolSize === 0) return { pooled: false, assignedIds: new Set() };
  return { pooled: true, assignedIds: new Set(mine.map((m) => m.applicationId)) };
}
