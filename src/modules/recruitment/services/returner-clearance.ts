import { prisma } from "@/platform/db";
import { loadClearanceMap } from "@/platform/clearance";
import { getActiveTerm } from "@/platform/terms/active-term";
import { OUTSTANDING_ITEM_LABELS, type OutstandingItemKey } from "@/platform/compliance/outstanding-items";

export type ReturnerClearanceBlock = {
  /** The term the person is a member of and not cleared in. */
  termName: string;
  keys: OutstandingItemKey[];
  /** Member-facing sentences, the same wording the onboarding reminders use. */
  items: string[];
};

/**
 * Why a returning member may not apply yet, or null when nothing stops them.
 *
 * A returner is anyone with an ACTIVE membership, of either kind, in the ACTIVE
 * term. They must be fully cleared in that term (HIPAA, EHS, training, learning,
 * profile: the same `cleared` gate as their /get-started checklist, read through
 * the same engine) before they can submit another application. The check runs
 * whatever applicant type they pick, so choosing "New applicant" is not a way
 * around it.
 *
 * Deliberately limited to the ACTIVE term. A person whose latest membership is
 * in an older, ARCHIVED term (an alum offboarded at a term flip, or someone
 * known only from imported history) is not checked: the Hub's records for those
 * terms are incomplete, and an old term's checklist is not a fair test of
 * whether someone is cleared now. Missing history never blocks anyone.
 */
export async function returnerClearanceBlock(personId: string | null | undefined): Promise<ReturnerClearanceBlock | null> {
  if (!personId) return null;
  const term = await getActiveTerm();
  if (!term) return null;
  const member = await prisma.termMembership.findFirst({
    where: { personId, termId: term.id, status: "ACTIVE" },
    select: { id: true },
  });
  if (!member) return null;
  const summary = (await loadClearanceMap([personId], term.id)).get(personId);
  if (!summary || summary.cleared) return null;
  const keys: OutstandingItemKey[] = summary.missing;
  return { termName: term.name, keys, items: keys.map((k) => OUTSTANDING_ITEM_LABELS[k]) };
}
