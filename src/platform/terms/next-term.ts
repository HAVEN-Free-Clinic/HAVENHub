import { cache } from "react";
import type { Term } from "@prisma/client";
import { prisma } from "@/platform/db";

/**
 * The single term being prepared for next (status PLANNING), newest by start
 * date, or null when nothing is in preparation (the normal state most of the
 * year). Memoized per request via React cache(), like getActiveTerm.
 */
export const getNextTerm = cache(async (): Promise<Term | null> => {
  return prisma.term.findFirst({
    where: { status: "PLANNING" },
    orderBy: { startDate: "desc" },
  });
});
