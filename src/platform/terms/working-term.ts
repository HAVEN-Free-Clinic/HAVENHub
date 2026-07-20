import { cache } from "react";
import type { Term } from "@prisma/client";
import { getActiveTerm } from "./active-term";
import { getNextTerm } from "./next-term";
import { prisma } from "@/platform/db";

/**
 * The term a staff member is working on for forward-looking tools. If selectedId
 * matches the live or next term, return it; otherwise fall back to the live term.
 * This makes an invalid or stale ?term=<id> degrade safely rather than error.
 * The UI that supplies selectedId (the <TermSwitcher>) ships with the scheduling
 * spec; this resolver is built now so the model is complete. Memoized per request.
 */
export const getWorkingTerm = cache(async (selectedId?: string): Promise<Term | null> => {
  const [live, next] = await Promise.all([getActiveTerm(), getNextTerm()]);
  if (selectedId) {
    if (live?.id === selectedId) return live;
    if (next?.id === selectedId) return next;
    // Any other real term (e.g. an archived term selected for read-only viewing in
    // the schedule builder) resolves to itself; an unknown/stale id falls through
    // to the live term below.
    const other = await prisma.term.findUnique({ where: { id: selectedId } });
    if (other) return other;
  }
  return live;
});
