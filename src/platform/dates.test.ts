import { describe, it, expect } from "vitest";
import {
  businessDaysSince,
  fmtDate,
  fmtDateTime,
  isoDateKey,
  parseZonedWallClock,
  toZonedInputValue,
  CLINIC_TIME_ZONE,
} from "./dates";

describe("isoDateKey", () => {
  it("formats a UTC day key", () => {
    expect(isoDateKey(new Date("2026-06-11T12:00:00Z"))).toBe("2026-06-11");
  });
});

describe("fmtDate", () => {
  it("formats a UTC date as 'Mon D, YYYY'", () => {
    expect(fmtDate(new Date("2026-06-13T12:00:00Z"))).toBe("Jun 13, 2026");
  });
  it("renders the fallback for null/undefined", () => {
    expect(fmtDate(null)).toBe("-");
    expect(fmtDate(undefined)).toBe("-");
    expect(fmtDate(null, "None")).toBe("None");
  });
});

describe("fmtDateTime", () => {
  it("formats a UTC date-time as 'YYYY-MM-DD HH:MM UTC'", () => {
    expect(fmtDateTime(new Date("2026-06-13T09:05:00Z"))).toBe("2026-06-13 09:05 UTC");
  });
  it("renders the fallback for null", () => {
    expect(fmtDateTime(null)).toBe("-");
  });
});

describe("businessDaysSince", () => {
  it("returns 0 when now is the same day as start", () => {
    const d = new Date("2026-06-11T12:00:00Z"); // Thursday
    expect(businessDaysSince(d, d)).toBe(0);
  });

  it("returns 0 when now is before start", () => {
    const start = new Date("2026-06-11T12:00:00Z");
    const earlier = new Date("2026-06-09T12:00:00Z");
    expect(businessDaysSince(start, earlier)).toBe(0);
  });

  it("counts weekdays exclusive of start, inclusive of now", () => {
    // Thu 2026-06-11 -> Mon 2026-06-15: Fri, Mon = 2 business days
    // (Sat/Sun skipped, start day Thu excluded).
    const start = new Date("2026-06-11T12:00:00Z");
    const now = new Date("2026-06-15T12:00:00Z");
    expect(businessDaysSince(start, now)).toBe(2);
  });

  it("skips weekends entirely", () => {
    // Fri 2026-06-12 -> Sun 2026-06-14: Sat, Sun = 0 business days.
    const start = new Date("2026-06-12T12:00:00Z");
    const now = new Date("2026-06-14T12:00:00Z");
    expect(businessDaysSince(start, now)).toBe(0);
  });

  it("is timezone-stable regardless of the wall-clock time of day", () => {
    // Late-evening start and early-morning now on adjacent weekdays still
    // count as one business day, because both are reduced to UTC calendar days.
    const start = new Date("2026-06-11T23:30:00Z"); // Thu
    const now = new Date("2026-06-12T00:30:00Z"); // Fri
    expect(businessDaysSince(start, now)).toBe(1);
  });
});

describe("parseZonedWallClock", () => {
  it("reads a summer (EDT, UTC-4) wall clock as Eastern, not the server zone", () => {
    // 2:00 PM Eastern on Jun 15 is 18:00 UTC (EDT = UTC-4).
    expect(parseZonedWallClock("2026-06-15T14:00")?.toISOString()).toBe("2026-06-15T18:00:00.000Z");
  });

  it("reads a winter (EST, UTC-5) wall clock as Eastern", () => {
    // 2:00 PM Eastern on Jan 15 is 19:00 UTC (EST = UTC-5).
    expect(parseZonedWallClock("2026-01-15T14:00")?.toISOString()).toBe("2026-01-15T19:00:00.000Z");
  });

  it("ignores a trailing seconds component and returns null on garbage", () => {
    expect(parseZonedWallClock("2026-06-15T14:00:30")?.toISOString()).toBe("2026-06-15T18:00:00.000Z");
    expect(parseZonedWallClock("")).toBeNull();
    expect(parseZonedWallClock("not-a-date")).toBeNull();
  });
});

describe("toZonedInputValue", () => {
  it("renders a UTC instant as the Eastern wall clock for a datetime-local input", () => {
    expect(toZonedInputValue(new Date("2026-06-15T18:00:00.000Z"))).toBe("2026-06-15T14:00");
    expect(toZonedInputValue(new Date("2026-01-15T19:00:00.000Z"))).toBe("2026-01-15T14:00");
  });

  it("returns empty string for null/undefined", () => {
    expect(toZonedInputValue(null)).toBe("");
    expect(toZonedInputValue(undefined)).toBe("");
  });

  it("round-trips with parseZonedWallClock for representative wall clocks", () => {
    for (const wall of ["2026-06-15T14:00", "2026-01-15T09:30", "2026-12-31T23:45"]) {
      const instant = parseZonedWallClock(wall, CLINIC_TIME_ZONE)!;
      expect(toZonedInputValue(instant, CLINIC_TIME_ZONE)).toBe(wall);
    }
  });
});
