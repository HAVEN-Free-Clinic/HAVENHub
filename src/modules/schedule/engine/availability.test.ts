import { describe, expect, it } from "vitest";
import { resolveAvailability, isAvailableOn, type AvailabilityTiers } from "./availability";

// UTC helpers
function utc(year: number, month: number, day: number, hour = 12): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0));
}

describe("resolveAvailability - tier selection", () => {
  it("returns baseline tier when neither selfUpdatedAt nor directorSetAt is set", () => {
    const tiers: AvailabilityTiers = {
      baseline: [utc(2026, 7, 4)],
      selfDates: [utc(2026, 7, 11)],
      selfUpdatedAt: null,
      directorDates: [utc(2026, 7, 18)],
      directorSetAt: null,
    };
    const result = resolveAvailability(tiers);
    expect(result.tier).toBe("BASELINE");
    expect(result.dates).toEqual([utc(2026, 7, 4)]);
  });

  it("returns self tier when selfUpdatedAt is set but directorSetAt is not", () => {
    const tiers: AvailabilityTiers = {
      baseline: [utc(2026, 7, 4)],
      selfDates: [utc(2026, 7, 11)],
      selfUpdatedAt: utc(2026, 6, 1),
      directorDates: [],
      directorSetAt: null,
    };
    const result = resolveAvailability(tiers);
    expect(result.tier).toBe("SELF");
    expect(result.dates).toEqual([utc(2026, 7, 11)]);
  });

  it("returns director tier when directorSetAt is set, overriding self", () => {
    const tiers: AvailabilityTiers = {
      baseline: [utc(2026, 7, 4)],
      selfDates: [utc(2026, 7, 11)],
      selfUpdatedAt: utc(2026, 6, 1),
      directorDates: [utc(2026, 7, 18)],
      directorSetAt: utc(2026, 6, 15),
    };
    const result = resolveAvailability(tiers);
    expect(result.tier).toBe("DIRECTOR");
    expect(result.dates).toEqual([utc(2026, 7, 18)]);
  });

  it("returns director tier with empty dates when directorDates is empty but directorSetAt is set", () => {
    const tiers: AvailabilityTiers = {
      baseline: [utc(2026, 7, 4)],
      selfDates: [utc(2026, 7, 11)],
      selfUpdatedAt: utc(2026, 6, 1),
      directorDates: [],
      directorSetAt: utc(2026, 6, 15),
    };
    const result = resolveAvailability(tiers);
    expect(result.tier).toBe("DIRECTOR");
    expect(result.dates).toEqual([]);
  });
});

describe("isAvailableOn", () => {
  it("returns true when the date (by UTC day) is in the resolved dates", () => {
    const tiers: AvailabilityTiers = {
      baseline: [utc(2026, 7, 4)],
      selfDates: [],
      selfUpdatedAt: null,
      directorDates: [],
      directorSetAt: null,
    };
    expect(isAvailableOn(tiers, utc(2026, 7, 4))).toBe(true);
  });

  it("returns false when the date is not in the resolved dates", () => {
    const tiers: AvailabilityTiers = {
      baseline: [utc(2026, 7, 4)],
      selfDates: [],
      selfUpdatedAt: null,
      directorDates: [],
      directorSetAt: null,
    };
    expect(isAvailableOn(tiers, utc(2026, 7, 11))).toBe(false);
  });

  it("returns false everywhere when director override is empty", () => {
    const tiers: AvailabilityTiers = {
      baseline: [utc(2026, 7, 4)],
      selfDates: [utc(2026, 7, 4)],
      selfUpdatedAt: utc(2026, 6, 1),
      directorDates: [],
      directorSetAt: utc(2026, 6, 15),
    };
    expect(isAvailableOn(tiers, utc(2026, 7, 4))).toBe(false);
  });

  it("matches by UTC day key regardless of time-of-day differences", () => {
    // stored date at 12:00Z; query at 00:00Z - same calendar day must match
    const stored = utc(2026, 7, 4, 12); // 12:00Z
    const query = utc(2026, 7, 4, 0);   // 00:00Z
    const tiers: AvailabilityTiers = {
      baseline: [stored],
      selfDates: [],
      selfUpdatedAt: null,
      directorDates: [],
      directorSetAt: null,
    };
    expect(isAvailableOn(tiers, query)).toBe(true);
  });
});
