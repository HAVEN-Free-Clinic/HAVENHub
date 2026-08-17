import { cache } from "react";
import type { Term } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "./active-term";

/**
 * The term being prepared for next: the SOONEST-starting PLANNING term that
 * starts after the live term, or null when nothing is in preparation (the normal
 * state most of the year). Memoized per request via React cache(), like
 * getActiveTerm.
 *
 * Both halves of that sentence are load-bearing, and neither used to be true.
 * This was `findFirst({ where: { status: "PLANNING" }, orderBy: { startDate:
 * "desc" } })`, which produced two wrong answers (audit 14):
 *
 * **1. It could return a term that already ended.** `activateTerm` demotes a
 * displaced term to PLANNING rather than ARCHIVED when its endDate is still in
 * the future, so an early or mistaken flip leaves the OUTGOING term in PLANNING
 * and recoverable. With no startDate relation to the live term, that demoted term
 * was normally the only PLANNING row left, so "next term" became the term that
 * just ended. The consequences were not cosmetic: `/volunteers/offboarding`
 * defaults to its Transition tab whenever a next term exists, and that tab
 * buckets everyone without an ACTIVE membership in "next" as NOT_RETURNING and
 * pre-checks them for bulk offboarding. Inverted, that pre-selects the entire
 * incoming class and marks the genuine returners non-selectable.
 *
 * **2. With two terms in preparation it picked the wrong one.** `desc` returns
 * the furthest-out term, so a PLANNING term for next year hid the imminent one
 * everywhere -- including `/schedule/requests`, which would then show none of the
 * shift requests actually waiting for a decision. "Next" means soonest.
 *
 * With no ACTIVE term there is nothing to anchor against, so the soonest PLANNING
 * term is the only sensible answer and the date filter is skipped.
 */
export const getNextTerm = cache(async (): Promise<Term | null> => {
  const active = await getActiveTerm();

  return prisma.term.findFirst({
    where: {
      status: "PLANNING",
      // A term that starts before the live one is not "next", whatever its
      // status says. `gt` rather than `gte` so a same-day re-activation of the
      // live term cannot return itself as its own successor.
      ...(active ? { startDate: { gt: active.startDate } } : {}),
    },
    // Soonest first: the next term is the one that arrives next.
    orderBy: [{ startDate: "asc" }, { code: "asc" }],
  });
});
