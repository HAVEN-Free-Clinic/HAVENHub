import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import type { AiReviewImportRow } from "../engine/ai-review";

export class AiReviewImportError extends Error {
  constructor(message: string) { super(message); this.name = "AiReviewImportError"; }
}

export type AiReviewImportPlan = {
  cycleTitle: string;
  runLabel: string;
  rows: number;
  /** Rows for applications with no AI review yet. */
  created: number;
  /** Rows replacing an application's existing AI review. */
  updated: number;
  /** This cycle's existing AI reviews that the file does not mention. */
  stale: number;
  /** How many of those were deleted: all of them with `replace`, otherwise none. */
  deleted: number;
  /** Submitted applications in the cycle the file has no row for. */
  unreviewed: number;
  /** Anything here stops an apply, so a bad file never lands half-written. */
  problems: string[];
  applied: boolean;
};

/**
 * Plan, and with `apply` write, one scoring run's AI reviews for a cycle.
 *
 * A dry run by default: it reports what would change and writes nothing. An
 * apply refuses the whole file if any row names an application outside the
 * cycle, a draft, or a best-fit department the cycle does not offer, since a
 * review pointing at a department nobody can be routed to is worse than none.
 *
 * Kept apart from services/ai-review.ts, which reads through the RBAC engine,
 * so the import script loads only the database and the audit log.
 */
export async function importAiReviews(input: {
  cycleId: string;
  runLabel: string;
  rows: AiReviewImportRow[];
  replace?: boolean;
  apply?: boolean;
  actorPersonId?: string | null;
}): Promise<AiReviewImportPlan> {
  const runLabel = input.runLabel.trim();
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id: input.cycleId },
    select: { id: true, title: true, departments: true },
  });
  if (!cycle) throw new AiReviewImportError(`No recruitment cycle ${input.cycleId}.`);

  const problems: string[] = [];
  if (!runLabel) problems.push("A run label is required, so every review says which run it came from.");

  const [apps, existing] = await Promise.all([
    prisma.application.findMany({ where: { cycleId: cycle.id }, select: { id: true, status: true } }),
    prisma.aiReview.findMany({ where: { application: { cycleId: cycle.id } }, select: { applicationId: true } }),
  ]);
  const statusById = new Map(apps.map((a) => [a.id, a.status]));
  const offered = new Set(cycle.departments);
  for (const row of input.rows) {
    const status = statusById.get(row.applicationId);
    if (status == null) problems.push(`${row.applicationId}: not an application in this cycle`);
    // A withdrawal after the run is fine to import: the review is still true of
    // what they submitted, and the page already says they withdrew.
    else if (status === "DRAFT") problems.push(`${row.applicationId}: still a draft`);
    if (row.bestFitDepartmentCode && !offered.has(row.bestFitDepartmentCode)) {
      problems.push(`${row.applicationId}: best fit ${row.bestFitDepartmentCode} is not a department in this cycle`);
    }
  }

  const existingIds = new Set(existing.map((e) => e.applicationId));
  const fileIds = new Set(input.rows.map((r) => r.applicationId));
  const updated = input.rows.filter((r) => existingIds.has(r.applicationId)).length;
  const stale = [...existingIds].filter((id) => !fileIds.has(id));
  const unreviewed = apps.filter((a) => a.status === "SUBMITTED" && !fileIds.has(a.id)).length;
  const plan: AiReviewImportPlan = {
    cycleTitle: cycle.title,
    runLabel,
    rows: input.rows.length,
    created: input.rows.length - updated,
    updated,
    stale: stale.length,
    deleted: 0,
    unreviewed,
    problems,
    applied: false,
  };
  if (!input.apply || problems.length > 0) return plan;

  const deleted = input.replace ? stale.length : 0;
  // Delete-then-create in one batched transaction rather than 800 upserts: the
  // same end state, one round trip, and nothing half-applied if it fails.
  await prisma.$transaction([
    prisma.aiReview.deleteMany({
      where: { applicationId: { in: [...fileIds, ...(input.replace ? stale : [])] } },
    }),
    prisma.aiReview.createMany({ data: input.rows.map((r) => ({ ...r, runLabel })) }),
  ]);
  await recordAudit({
    actorPersonId: input.actorPersonId ?? null,
    action: "recruitment.ai_review_import",
    entityType: "RecruitmentCycle",
    entityId: cycle.id,
    after: { runLabel, created: plan.created, updated, deleted },
  });
  return { ...plan, deleted, applied: true };
}
