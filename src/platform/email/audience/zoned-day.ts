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

/**
 * The calendar day `days` after `day` (a "YYYY-MM-DD" string).
 *
 * Deliberately pure calendar arithmetic with no zone involved: adding 24 hours
 * to an instant is NOT the same as adding a day, because a DST fall-back day is
 * 25 hours long and a spring-forward day is 23. Doing it on the date itself
 * sidesteps that entirely, and parseZonedInput then resolves the resulting
 * midnight correctly whichever side of a transition it lands on.
 */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
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
