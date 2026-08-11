/**
 * When to ask Yalies for a person's photo.
 *
 * Photos are fetched lazily, on view, rather than by a scheduled sweep. That
 * makes the backoff load-bearing rather than a nicety: most of the roster is not
 * in the Yale Face Book at all (medicine, nursing, public health, graduate,
 * staff), and without a backoff every page view for every one of those people
 * would call Yalies. With it, a photoless person costs about one call a month.
 */

/** The subset of Person this policy reads. */
export type PhotoState = {
  netId: string | null;
  yaleAffiliation: string | null;
  photoKey: string | null;
  photoSuppressed: boolean;
  photoSyncedAt: Date | null;
  photoSyncMisses: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Wait after the Nth consecutive miss, in days. The last entry repeats forever. */
const BACKOFF_DAYS = [1, 7, 30];

/** How long to wait after `misses` consecutive misses before asking again. */
export function backoffMs(misses: number): number {
  const index = Math.min(Math.max(misses - 1, 0), BACKOFF_DAYS.length - 1);
  return BACKOFF_DAYS[index] * DAY_MS;
}

/**
 * True when it is worth asking Yalies about this person right now.
 *
 * `now` is injected rather than read: the project's lint rules forbid clock
 * reads in render paths, and a passed clock makes the backoff table testable.
 */
export function shouldAttemptYaliesPull(person: PhotoState, now: Date): boolean {
  if (person.photoKey) return false;
  if (person.photoSuppressed) return false;
  if (!person.netId) return false;
  // Only a declared non-affiliate is excluded outright. An unknown or
  // non-college Yale affiliation still gets one attempt, because the column is
  // self-reported and can be stale or wrong; the backoff absorbs the misses.
  if (person.yaleAffiliation === "non_yale") return false;
  if (!person.photoSyncedAt) return true;
  return now.getTime() - person.photoSyncedAt.getTime() >= backoffMs(person.photoSyncMisses);
}
