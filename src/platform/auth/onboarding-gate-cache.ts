/**
 * Process-local cache of the onboarding gate's CLEARED decision. The gate
 * (enforceOnboarding) runs ~6 DB queries via getOnboardingStatus on every
 * non-allowlisted page render; for the common case of an already-onboarded
 * person navigating the app, caching the cleared result for a short window
 * removes that cost. Only POSITIVE (cleared) decisions are cached: a blocking
 * decision is always recomputed, so a person who just completed onboarding is
 * never wrongly redirected by a stale entry. Bounded staleness: a person whose
 * clearance lapses (e.g. cert expiry) may pass the gate for up to TTL_MS. The
 * separate, uncached getActivePerson() offboarding check is unaffected.
 */
const TTL_MS = 60_000;
const clearedUntil = new Map<string, number>();

/** True when this person was cleared within the TTL window. */
export function isGateClearedCached(personId: string): boolean {
  const expiresAt = clearedUntil.get(personId);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    clearedUntil.delete(personId);
    return false;
  }
  return true;
}

/** Record that the gate cleared this person; valid for TTL_MS. */
export function markGateCleared(personId: string): void {
  clearedUntil.set(personId, Date.now() + TTL_MS);
}

/** Test-only: clear the cache between cases. */
export function _resetOnboardingGateCache(): void {
  clearedUntil.clear();
}
