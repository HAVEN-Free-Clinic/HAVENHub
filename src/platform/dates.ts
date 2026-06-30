/**
 * Platform date helpers shared across modules and platform code.
 *
 * Calendar dates in HAVEN Hub (clinic dates, availability arrays, shift
 * assignment dates) are stored as DateTime anchored at 12:00 UTC and compared
 * by UTC day key, never by raw timestamp.
 */

/** "Jun 13, 2026" in UTC. Null/undefined render as `fallback` (default "-"). */
export function fmtDate(d: Date | null | undefined, fallback = "-"): string {
  if (!d) return fallback;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "2026-06-13 09:05 UTC" in UTC. Null/undefined render as `fallback` (default "-"). */
export function fmtDateTime(d: Date | null | undefined, fallback = "-"): string {
  if (!d) return fallback;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())} UTC`;
}

/** Returns a UTC YYYY-MM-DD key for a date. */
export function isoDateKey(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Counts Monday to Friday business days elapsed between `start` and `now`, exclusive of
 * the start day and inclusive of `now` (both treated as calendar dates in UTC,
 * so the result is timezone-stable). Returns 0 when `now` is on or before
 * `start`. Used to flag how long a request has been pending. `now` defaults to
 * the current date.
 */
export function businessDaysSince(start: Date, now: Date = new Date()): number {
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (endDay <= startDay) return 0;

  let count = 0;
  for (let cursor = startDay + 86_400_000; cursor <= endDay; cursor += 86_400_000) {
    const dow = new Date(cursor).getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}
