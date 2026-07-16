import { prisma } from "@/platform/db";
import { GROUP_TERM, type EventGroups } from "./capture";

/**
 * Group-attachment helpers for server-side captures.
 *
 * A `term` group is attached wherever a term is in scope, so funnels and
 * retention can be sliced per semester. Cycle-scoped events resolve the
 * *cycle's* term (a cycle can belong to a PLANNING term, not the active one),
 * not the active term. Non-cycle authenticated events fall back to the active
 * term. Department groups are passed as `extra` only where exactly one
 * department is unambiguous.
 *
 * All shaping lives in the pure `termGroup`; the DB resolvers just look up a
 * term id and delegate.
 */

/** Build event groups from an explicit term id, merging any extra groups. */
export function termGroup(
  termId: string | null | undefined,
  extra?: EventGroups,
): EventGroups | undefined {
  const groups: EventGroups = { ...extra };
  if (termId) groups[GROUP_TERM] = termId;
  return Object.keys(groups).length > 0 ? groups : undefined;
}

/** Resolve the term for a recruitment cycle and build its groups. */
export async function termGroupForCycle(
  cycleId: string,
  extra?: EventGroups,
): Promise<EventGroups | undefined> {
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id: cycleId },
    select: { termId: true },
  });
  return termGroup(cycle?.termId ?? null, extra);
}

/** Resolve the term for a recruitment cycle by its public slug. */
export async function termGroupForCycleSlug(
  slug: string,
  extra?: EventGroups,
): Promise<EventGroups | undefined> {
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { publicSlug: slug },
    select: { termId: true },
  });
  return termGroup(cycle?.termId ?? null, extra);
}

/** Build groups for the current active term (non-cycle authenticated events). */
export async function activeTermGroup(
  extra?: EventGroups,
): Promise<EventGroups | undefined> {
  const term = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
    select: { id: true },
  });
  return termGroup(term?.id ?? null, extra);
}
