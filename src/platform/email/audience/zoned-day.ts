/**
 * Zone-aware calendar-day boundary math, shared by the condition compiler
 * (operators.ts, for date-kind conditions) and the count loaders
 * (count-loaders.ts, for the "upcoming" cutoff).
 *
 * Extracted to its own module rather than duplicated a third time, and rather
 * than exported from operators.ts: that module is about compiling
 * AudienceConditions into Prisma predicates, and count-loaders.ts isn't a
 * condition compiler, so it has no business reaching into operators.ts's
 * exports for plain date math.
 */
import { parseZonedInput } from "@/platform/dates";

/** The calendar Y/M/D that `instant` falls on in `zone`. */
export function localDayParts(instant: Date, zone: string): { y: string; m: string; d: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return { y: g("year"), m: g("month"), d: g("day") };
}

/** The digit shape of a bare calendar date. Necessary, but far from sufficient. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A UTC instant back to "YYYY-MM-DD", with the year padded to four digits. */
function formatUtcDay(instant: Date): string {
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return [
    pad(instant.getUTCFullYear(), 4),
    pad(instant.getUTCMonth() + 1, 2),
    pad(instant.getUTCDate(), 2),
  ].join("-");
}

/**
 * True only for a "YYYY-MM-DD" string naming a date that REALLY EXISTS.
 *
 * The digit shape alone is not enough. `Date.UTC` does not reject an impossible
 * date, it rolls it forward: Feb 30 becomes Mar 2, month 13 becomes the
 * following January, day 00 becomes the last day of the previous month. Left
 * unchecked, an audience condition saying "before 2026-02-30" would silently
 * compile to a boundary on March 2 -- two days LATER than written, and for
 * `before`/`onOrBefore` that moves the boundary OUTWARD, widening the send
 * list. A send list that quietly grows is the one failure mode this whole
 * module is built to prevent (see the invariants at the top of operators.ts).
 *
 * The check is a round trip: rebuild the date from its parts and reformat it.
 * If Date.UTC moved it, the strings differ. Callers must treat false as
 * match-nobody rather than as "resolve it to whatever comes out".
 *
 * A native <input type="date"> cannot produce an impossible date, but audiences
 * are stored as schema-less JSON, so a hand-edited, imported, or migrated one
 * can, which is why the gate lives here rather than only in the UI.
 */
export function isCalendarDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const [y, m, d] = day.split("-").map(Number);
  return formatUtcDay(new Date(Date.UTC(y, m - 1, d))) === day;
}

/**
 * The calendar day `days` after `day` (a "YYYY-MM-DD" string).
 *
 * Deliberately pure calendar arithmetic with no zone involved: adding 24 hours
 * to an instant is NOT the same as adding a day, because a DST fall-back day is
 * 25 hours long and a spring-forward day is 23. Doing it on the date itself
 * sidesteps that entirely, and parseZonedInput then resolves the resulting
 * midnight correctly whichever side of a transition it lands on.
 *
 * Callers are expected to have run `day` past isCalendarDay first; this rolls
 * an impossible input forward silently, which is exactly what that gate exists
 * to stop.
 */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return formatUtcDay(new Date(Date.UTC(y, m - 1, d + days)));
}

/**
 * Shifts `now` by whole days (in the calendar, not by fixed milliseconds) and
 * returns the instant at which that day begins in `zone`. Passing `days: 0`
 * gives the start of "today" in `zone`, which is what a zone-aware "is this
 * upcoming" cutoff needs; comparing against a UTC-midnight cutoff instead is
 * wrong for hours every evening once the zone is behind UTC (see
 * count-loaders.ts's upcomingShiftCount).
 */
export function startOfDayOffsetFromNow(now: Date, days: number, zone: string): Date | null {
  const { y, m, d } = localDayParts(now, zone);
  return parseZonedInput(`${shiftDay(`${y}-${m}-${d}`, days)}T00:00`, zone);
}
