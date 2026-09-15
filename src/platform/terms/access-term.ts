import { cache } from "react";
import type { Term } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "./active-term";
import { getNextTerm } from "./next-term";

/**
 * The term a person's hub access and onboarding resolve through right now.
 *
 * - The live term, for anyone on its roster. That is nearly everyone nearly always,
 *   including a returner already on the next roster too, and a member who is not
 *   coming back, so neither gains nor loses anything before the switch.
 * - The NEXT term, for someone on that roster but not the live one: a new member
 *   accepted, onboarded, and added ahead of the term switch. Without this, everything
 *   term-scoped (role grants that come through a membership, the get-started gate and
 *   checklist, onboarding reminders) looks only at the live term, where they have no
 *   membership, so the incoming class would have no access, no gate, and no reminders
 *   until the switch, while being expected at training and onboarding before it.
 * - Otherwise the live term, so a person on neither roster (faculty, staff, alumni)
 *   resolves exactly as before.
 *
 * Memoized per request via React cache(), like getActiveTerm.
 */
export const getAccessTerm = cache(async (personId: string): Promise<Term | null> => {
  const live = await getActiveTerm();
  if (live) {
    const onLive = await prisma.termMembership.findFirst({
      where: { personId, termId: live.id, status: "ACTIVE" },
      select: { id: true },
    });
    if (onLive) return live;
  }
  const next = await getNextTerm();
  if (next) {
    const onNext = await prisma.termMembership.findFirst({
      where: { personId, termId: next.id, status: "ACTIVE" },
      select: { id: true },
    });
    if (onNext) return next;
  }
  return live;
});
