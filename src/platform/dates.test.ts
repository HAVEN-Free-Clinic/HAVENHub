import { describe, it, expect } from "vitest";
import { businessDaysSince, fmtDate, fmtDateTime, isoDateKey } from "./dates";

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
