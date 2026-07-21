/**
 * Process-local cache of the onboarding gate's CLEARED decision. The gate
 * (enforceOnboarding) runs ~9 DB queries via getOnboardingStatus on every
 * non-allowlisted page render; for the common case of an already-onboarded
 * person navigating the app, caching the cleared result for a short window
 * removes that cost. Only POSITIVE (cleared) decisions are cached: a blocking
 * decision is always recomputed, so a person who just completed onboarding is
 * never wrongly redirected by a stale entry. Bounded staleness: a person whose
 * clearance lapses (e.g. cert expiry) may pass the gate for up to TTL_MS. The
 * separate, uncached getActivePerson() offboarding check is unaffected.
 *
 * The cache key is `${activeTermId}:${personId}` (built by the caller), so activating
 * a new term implicitly invalidates every prior entry -- a person cleared for the old
 * term is re-gated against the new one on their next render rather than coasting on a
 * stale personId-only entry for up to TTL_MS.
 */
const TTL_MS = 5 * 60_000;
const clearedUntil = new Map<string, number>();

/** True when this key (term:person) was cleared within the TTL window. */
export function isGateClearedCached(key: string): boolean {
  const expiresAt = clearedUntil.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    clearedUntil.delete(key);
    return false;
  }
  return true;
}

/** Record that the gate cleared this key (term:person); valid for TTL_MS. */
export function markGateCleared(key: string): void {
  clearedUntil.set(key, Date.now() + TTL_MS);
}

/** Test-only: clear the cache between cases. */
export function _resetOnboardingGateCache(): void {
  clearedUntil.clear();
}
