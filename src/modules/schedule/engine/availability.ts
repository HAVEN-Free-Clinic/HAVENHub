/**
 * Availability tier resolution for volunteers and directors.
 *
 * Pure module: no Prisma imports, no platform imports.
 * Uses isoDateKey from map.ts for UTC day-key comparison.
 */

import { isoDateKey } from "./map";

export type AvailabilityTiers = {
  /** Tier 3 fallback: availability from the member's application. */
  baseline: Date[];
  /** Member self-update. Only active when selfUpdatedAt is non-null. */
  selfDates: Date[];
  /** Non-null activates the self tier; null falls through to baseline. */
  selfUpdatedAt: Date | null;
  /** Director override dates. Only active when directorSetAt is non-null. */
  directorDates: Date[];
  /** Non-null activates the director tier, overriding self and baseline. */
  directorSetAt: Date | null;
};

export type ResolvedAvailability = {
  dates: Date[];
  tier: "DIRECTOR" | "SELF" | "BASELINE";
};

/**
 * Resolves the active availability tier for a volunteer.
 *
 * Priority: director override (when directorSetAt is set) > self submission
 * (when selfUpdatedAt is set) > baseline schedule.
 */
export function resolveAvailability(t: AvailabilityTiers): ResolvedAvailability {
  if (t.directorSetAt !== null) {
    return { dates: t.directorDates, tier: "DIRECTOR" };
  }
  if (t.selfUpdatedAt !== null) {
    return { dates: t.selfDates, tier: "SELF" };
  }
  return { dates: t.baseline, tier: "BASELINE" };
}

/**
 * Returns true when the given date falls on a UTC day that appears in the
 * resolved availability dates.
 */
export function isAvailableOn(t: AvailabilityTiers, date: Date): boolean {
  const { dates } = resolveAvailability(t);
  const queryKey = isoDateKey(date);
  return dates.some((d) => isoDateKey(d) === queryKey);
}

/**
 * Is self-availability closed for a term?
 *
 * Availability is the input to building the schedule, so it is editable only
 * until the term's clinics actually start. From the first clinic date onward
 * the schedule is live and every change has to go through the swap/drop request
 * flow, where a director approves it and the counterparty is notified. Letting a
 * member silently withdraw their availability after that point would desync the
 * roster from the schedule already published to the clinic.
 *
 * Compared as YYYY-MM-DD day keys, never as timestamps: clinic dates are
 * noon-UTC calendar markers, so a raw instant comparison would leave the form
 * open for the first twelve hours of the clinic day. `todayKey` must be the
 * DISPLAY-zone day (displayTodayKey), not isoDateKey(new Date()), or the lock
 * lands ~4 hours early each evening when UTC has already rolled over. Plain
 * string comparison is correct for zero-padded ISO keys.
 *
 * A term with no clinic dates is never locked: there is nothing to be late for.
 */
export function isAvailabilityLocked(input: {
  clinicDateKeys: string[];
  todayKey: string;
}): boolean {
  if (input.clinicDateKeys.length === 0) return false;
  const first = input.clinicDateKeys.reduce((a, b) => (a < b ? a : b));
  return input.todayKey >= first;
}
