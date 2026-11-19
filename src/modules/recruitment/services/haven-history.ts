import { prisma } from "@/platform/db";
import type { HavenHistory } from "../engine/haven-history";

/**
 * What the Hub record says about a person's HAVEN history, for the questions a
 * form answers from the record (see engine/haven-history.ts).
 *
 * Any TermMembership counts: any term (imported ARCHIVED terms included) and
 * any status (a REMOVED membership was still served). Volunteer history is a
 * VOLUNTEER membership; board history is a DIRECTOR membership.
 */
export async function loadHavenHistory(personId: string): Promise<HavenHistory> {
  const rows = await prisma.termMembership.groupBy({
    by: ["kind"],
    where: { personId },
    _count: { _all: true },
  });
  const kinds = new Set(rows.map((r) => r.kind));
  return { volunteered: kinds.has("VOLUNTEER"), directed: kinds.has("DIRECTOR") };
}
