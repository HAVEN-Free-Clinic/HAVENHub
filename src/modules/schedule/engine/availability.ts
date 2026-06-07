/**
 * Availability tier resolution for volunteers and directors.
 *
 * Pure module: no Prisma imports, no platform imports.
 * Uses isoDateKey from map.ts for UTC day-key comparison.
 */

import { isoDateKey } from "./map";

export type AvailabilityTiers = {
  baseline: Date[];
  selfDates: Date[];
  selfUpdatedAt: Date | null;
  directorDates: Date[];
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
