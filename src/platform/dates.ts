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
 * The clinic's civil timezone. Interview times and other wall-clock inputs are
 * entered and displayed in this zone, regardless of the server's timezone (which
 * is UTC on Vercel). Kept as a constant so every site agrees on one basis.
 */
export const CLINIC_TIME_ZONE = "America/New_York";

/**
 * The offset, in milliseconds, by which `timeZone`'s wall clock leads UTC at the
 * given instant (positive east of UTC, negative west). DST-aware because it asks
 * Intl what the zone's wall clock actually reads at that instant.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUTC - instant.getTime();
}

/**
 * Interpret a naive wall-clock string ("YYYY-MM-DDTHH:mm", as emitted by a
 * datetime-local input) as local time in `timeZone` and return the corresponding
 * UTC instant. Without this, `new Date(input)` parses the string in the SERVER's
 * timezone (UTC on Vercel), so a time entered as 2pm Eastern is stored as 2pm UTC
 * and shown 4-5h off wherever it is rendered in Eastern. Two-pass so the DST
 * transition edge resolves to the offset actually in effect. Returns null on a
 * malformed string.
 */
export function parseZonedWallClock(input: string, timeZone: string = CLINIC_TIME_ZONE): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(input);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const guessUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off1 = zoneOffsetMs(new Date(guessUtc), timeZone);
  let utc = guessUtc - off1;
  const off2 = zoneOffsetMs(new Date(utc), timeZone);
  if (off2 !== off1) utc = guessUtc - off2;
  return new Date(utc);
}

/**
 * Format a UTC instant as a "YYYY-MM-DDTHH:mm" wall-clock string in `timeZone`,
 * suitable for a datetime-local input's `value`/`defaultValue`. The inverse of
 * `parseZonedWallClock`, so the form round-trips in clinic-local time.
 */
export function toZonedInputValue(d: Date | null | undefined, timeZone: string = CLINIC_TIME_ZONE): string {
  if (!d) return "";
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(d)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * "Jun 15, 2026, 2:00 PM EDT" in the clinic timezone. Null/undefined render as
 * `fallback`. Use for staff-facing displays of interview times so they match the
 * Eastern time the applicant is emailed.
 */
export function fmtClinicDateTime(d: Date | null | undefined, fallback = "TBD", timeZone: string = CLINIC_TIME_ZONE): string {
  if (!d) return fallback;
  // Explicit components (not dateStyle/timeStyle) because Intl forbids combining
  // those presets with timeZoneName.
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
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
