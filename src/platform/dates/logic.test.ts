import { describe, it, expect } from "vitest";
import { businessDaysSince, isoDateKey, isoWeekKey } from "./logic";

describe("isoDateKey", () => {
  it("formats a UTC day key", () => {
    expect(isoDateKey(new Date("2026-06-11T12:00:00Z"))).toBe("2026-06-11");
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
    const start = new Date("2026-06-11T12:00:00Z");
    const now = new Date("2026-06-15T12:00:00Z");
    expect(businessDaysSince(start, now)).toBe(2);
  });
  it("skips weekends entirely", () => {
    const start = new Date("2026-06-12T12:00:00Z");
    const now = new Date("2026-06-14T12:00:00Z");
    expect(businessDaysSince(start, now)).toBe(0);
  });
  it("is UTC-day-stable regardless of wall-clock time (default)", () => {
    const start = new Date("2026-06-11T23:30:00Z"); // Thu
    const now = new Date("2026-06-12T00:30:00Z"); // Fri
    expect(businessDaysSince(start, now)).toBe(1);
  });
  it("counts against clinic-local days when a zone is passed", () => {
    // Both instants are 2026-06-11 in ET (21:30 and 20:30 EDT), so 0 business days.
    const start = new Date("2026-06-12T01:30:00Z"); // 2026-06-11 21:30 EDT
    const now = new Date("2026-06-12T00:30:00Z"); // 2026-06-11 20:30 EDT
    expect(businessDaysSince(start, now, "America/New_York")).toBe(0);
  });
});

describe("isoWeekKey", () => {
  it("returns the ISO year and zero-padded week", () => {
    // 2026-07-29 is a Wednesday in ISO week 31.
    expect(isoWeekKey(new Date("2026-07-29T12:00:00Z"))).toBe("2026-W31");
  });

  it("gives every day of one ISO week the same key (Monday through Sunday)", () => {
    // 2026-07-27 is a Monday; 2026-08-02 is the Sunday that closes the same week.
    expect(isoWeekKey(new Date("2026-07-27T00:00:00Z"))).toBe("2026-W31");
    expect(isoWeekKey(new Date("2026-07-28T23:59:59Z"))).toBe("2026-W31");
    expect(isoWeekKey(new Date("2026-08-02T23:59:59Z"))).toBe("2026-W31");
  });

  it("rolls to a new key on Monday", () => {
    expect(isoWeekKey(new Date("2026-08-03T00:00:00Z"))).toBe("2026-W32");
  });

  it("assigns an early-January date to the ISO year its week belongs to", () => {
    // 2027-01-01 is a Friday, which ISO 8601 places in week 53 of 2026.
    expect(isoWeekKey(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
  });
});
