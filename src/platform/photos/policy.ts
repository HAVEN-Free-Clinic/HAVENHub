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

/**
 * How long to wait after an integration-level failure, as opposed to a miss that
 * says something durable about the person.
 *
 * The caller only counts person-specific misses (nobody matched that netId, or
 * that person has no Face Book photo) toward `photoSyncMisses`. A failure of the
 * integration itself stamps the timestamp and leaves the counter alone, landing
 * here. Minutes rather than days, because the condition is expected to be
 * transient and is equally true of everyone: once it clears, members should
 * recover on their next view instead of serving initials for a day.
 */
const TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * How long to wait before asking again, given the consecutive person-specific
 * miss count.
 *
 * Zero is not a degenerate case: it is the integration-failure path, and it
 * deliberately returns minutes rather than the one-day first step. Collapsing
 * the two is how a single bad deploy can leave an entire roster dark for a day,
 * which is exactly what happened when the upstream image host moved.
 */
export function backoffMs(misses: number): number {
  if (misses <= 0) return TRANSIENT_COOLDOWN_MS;
  const index = Math.min(misses - 1, BACKOFF_DAYS.length - 1);
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
