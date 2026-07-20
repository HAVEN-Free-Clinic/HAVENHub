import { cache } from "react";
import type { Term } from "@prisma/client";
import { prisma } from "@/platform/db";

/**
 * The terms a person currently belongs to that are live or in preparation:
 * terms with status ACTIVE or PLANNING in which the person holds an ACTIVE
 * TermMembership. Ordered live-term (ACTIVE) first, then by startDate desc.
 * This is the set the merged member views iterate over; ARCHIVED terms and
 * terms the person is not an active member of are excluded. Memoized per
 * request via React cache().
 */
export const getPersonTerms = cache(async (personId: string): Promise<Term[]> => {
  const memberships = await prisma.termMembership.findMany({
    where: { personId, status: "ACTIVE", term: { status: { in: ["ACTIVE", "PLANNING"] } } },
    include: { term: true },
  });
  const byId = new Map<string, Term>();
  for (const m of memberships) byId.set(m.term.id, m.term);
  return [...byId.values()].sort((a, b) => {
    if (a.status !== b.status) return a.status === "ACTIVE" ? -1 : 1;
    return b.startDate.getTime() - a.startDate.getTime();
  });
});
