import { prisma } from "@/platform/db";

/**
 * Cycles the applicant portal announces as "opening soon": a title and a date,
 * nothing more.
 *
 * WHY THIS EXISTS. Before it, a visitor who found nothing open was told to
 * "check back soon" with no date, while staff had often already scheduled the
 * next cycle. The information was sitting in the row and nobody could see it.
 *
 * THE OPT-IN IS `opensAt`, and it is the whole safety argument for including
 * DRAFT rows. A DRAFT cycle is an internal artifact -- staff are still building
 * the form, and its working title may be a placeholder nobody meant to publish.
 * This does not list every DRAFT; it lists the ones where someone deliberately
 * put a future open date on the record, which is as close to "we have announced
 * this" as the schema gets. A dateless draft stays invisible, so the escape
 * hatch for anything staff would rather not show is to leave the date off.
 *
 * WHY TWO STATUSES. They look identical to an applicant and both are invisible
 * today. OPEN with a future opensAt is published but still ahead of its own
 * window (isCycleOpen in cycle-window.ts refuses it, correctly). DRAFT is not
 * published at all. CLOSED and ARCHIVED are excluded on purpose: a future date
 * on a closed cycle is contradictory, and archiving is how a cycle is retired
 * for good, so announcing either would be announcing something that is not
 * going to happen.
 *
 * NOT AN ACCESS DECISION, and must never become one. Nothing about appearing in
 * this list lets anyone apply: canSubmitToCycle (cycle-window.ts) refuses DRAFT
 * outright, invite or no invite, and refuses OPEN outside its window to anyone
 * uninvited. The portal renders these as plain rows rather than links for the
 * same reason -- an affordance that bounces off "Applications are closed" is
 * worse than none.
 *
 * `publicSlug` is selected as a stable React key, not to build a URL.
 */
export type UpcomingCycle = {
  title: string;
  publicSlug: string;
  /** Never null: the query requires a future date, which is the opt-in above. */
  opensAt: Date;
};

export async function listUpcomingCycles(now: Date): Promise<UpcomingCycle[]> {
  const cycles = await prisma.recruitmentCycle.findMany({
    where: { status: { in: ["DRAFT", "OPEN"] }, opensAt: { gt: now } },
    select: { title: true, publicSlug: true, opensAt: true },
    // Soonest first: the next thing to open is the answer to the question this
    // list exists to answer.
    orderBy: { opensAt: "asc" },
  });
  // The `opensAt: { gt: now }` filter already excludes nulls (Prisma's
  // comparison operators never match NULL -- see the same trap documented for
  // `not` elsewhere in this codebase), so this narrows the type without
  // discarding any row the query would have returned.
  return cycles.filter((c): c is UpcomingCycle => c.opensAt !== null);
}
