/**
 * Platform date helpers shared across modules and platform code.
 *
 * Calendar dates in HAVEN Hub (clinic dates, availability arrays, shift
 * assignment dates) are stored as DateTime anchored at 12:00 UTC and compared
 * by UTC day key, never by raw timestamp.
 */

/** Returns a UTC YYYY-MM-DD key for a date. */
export function isoDateKey(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
