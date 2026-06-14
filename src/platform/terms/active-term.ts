import { cache } from "react";
import type { Term } from "@prisma/client";
import { prisma } from "@/platform/db";

/**
 * The current ACTIVE term (newest by start date), or null when none is active.
 * Memoized per request via React cache(): a single page render touches the
 * active term from several places (shell layout, RBAC, onboarding gate,
 * schedule, training, learning), so without this they each issue the same
 * query. cache() collapses them to one DB round-trip per request; it does not
 * memoize across requests, so an admin activating a term still takes effect on
 * the next navigation.
 */
export const getActiveTerm = cache(async (): Promise<Term | null> => {
  return prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
});
