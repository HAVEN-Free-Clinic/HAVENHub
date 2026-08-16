import { describe, expect, it } from "vitest";
import {
  resolveAvailability,
  isAvailableOn,
  isAvailabilityLocked,
  type AvailabilityTiers,
} from "./availability";

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

describe("isAvailabilityLocked", () => {
  const DATES = ["2026-09-12", "2026-09-19", "2026-09-26"];

  it("is open before the first clinic date", () => {
    expect(isAvailabilityLocked({ clinicDateKeys: DATES, todayKey: "2026-09-11" })).toBe(false);
  });

  // The lock lands ON the first clinic day, not the day after: once the clinic
  // is running, the schedule built from this availability is already in use.
  it("is locked on the first clinic date itself", () => {
    expect(isAvailabilityLocked({ clinicDateKeys: DATES, todayKey: "2026-09-12" })).toBe(true);
  });

  it("stays locked for the rest of the term", () => {
    expect(isAvailabilityLocked({ clinicDateKeys: DATES, todayKey: "2026-11-30" })).toBe(true);
  });

  // Term.clinicDates is a raw Postgres array with no ordering guarantee (the
  // check-in seed appends today's date to the end regardless of where it falls),
  // so the lock must find the EARLIEST date rather than trusting position 0.
  it("uses the earliest clinic date even when the array is unordered", () => {
    const unordered = ["2026-09-26", "2026-09-12", "2026-09-19"];
    expect(isAvailabilityLocked({ clinicDateKeys: unordered, todayKey: "2026-09-12" })).toBe(true);
  });

  // A term whose calendar has not been published yet has nothing to be late for,
  // and the page withholds the form in that state for a separate reason (#90).
  it("is never locked when the term has no clinic dates", () => {
    expect(isAvailabilityLocked({ clinicDateKeys: [], todayKey: "2099-01-01" })).toBe(false);
  });
});
