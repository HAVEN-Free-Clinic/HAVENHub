/**
 * Platform facade for the onboarding clearance aggregator.
 *
 * loadClearanceMap computes full clearance (profile, HIPAA, training, learning, EHS)
 * by reusing the onboarding engine, which is owned by the onboarding module. Modules
 * (volunteers, schedule, email) must not import each other, so they consume clearance
 * through this platform facade. This mirrors the sanctioned platform->module import of
 * getOnboardingStatus in src/platform/auth/session.ts.
 */
import { cache } from "react";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
// eslint-disable-next-line no-restricted-imports, import/no-restricted-paths
import { loadClearanceMap } from "@/modules/onboarding/services/clearance";

// eslint-disable-next-line no-restricted-imports, import/no-restricted-paths
export { loadClearanceMap, type ClearanceSummary, type ClearanceTask } from "@/modules/onboarding/services/clearance";

/**
 * The subset of `personIds` who are fully cleared in the ACTIVE term.
 *
 * This exists for the verified badge, which renders beside names on pages all
 * over the app. The rule it enforces is that clearance is resolved ONCE per
 * page, never once per name: loadClearanceMap costs roughly a dozen queries, so
 * a component that fetched its own status would turn a roster of forty people
 * into hundreds of queries. Page loaders collect their ids and call this once.
 *
 * Wrapped in React `cache()` so two components in the same render that ask for
 * the same id list share one result rather than repeating that dozen queries.
 * The cache is per-request, so it cannot serve a stale answer across requests.
 *
 * Returns a Set, not per-task detail, because a badge has nothing useful to say
 * about WHICH task is outstanding. Anything needing that belongs on the
 * compliance roster, which already shows it.
 *
 * Empty when there is no active term: clearance is defined per term, so with no
 * term in progress nobody is cleared for anything and the badge simply does not
 * render. Same for someone with no ACTIVE membership in that term (an alum, or
 * an applicant who has not started) -- they are out of scope rather than failing.
 */
export const loadClearedSet = cache(async function loadClearedSet(
  personIds: string[]
): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();

  const activeTerm = await getActiveTerm();
  if (!activeTerm) return new Set();

  const unique = [...new Set(personIds)];

  // Membership is checked SEPARATELY, and must be. loadClearanceMap derives its
  // requirements from a person's memberships, so someone with none has no
  // learning or EHS requirements to fail and comes back `cleared` on the
  // strength of a profile and a HIPAA cert alone. That is correct for the
  // aggregator (there is nothing outstanding) and wrong for this badge: an alum
  // holding a still-valid certificate is not cleared to work a shift, they are
  // simply not working. Badging them would assert active standing the clinic
  // never granted.
  const members = await prisma.termMembership.findMany({
    where: { personId: { in: unique }, termId: activeTerm.id, status: "ACTIVE" },
    select: { personId: true },
  });
  const memberIds = [...new Set(members.map((m) => m.personId))];
  if (memberIds.length === 0) return new Set();

  const map = await loadClearanceMap(memberIds, activeTerm.id);
  const out = new Set<string>();
  for (const [personId, summary] of map) {
    if (summary.cleared) out.add(personId);
  }
  return out;
});
