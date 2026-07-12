import { describe, it, expect } from "vitest";
import { businessDaysSince, isoDateKey } from "./logic";

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

describe("fmtDate / fmtDateTime legacy shims", () => {
  it("still produce the original UTC strings", async () => {
    const { fmtDate, fmtDateTime } = await import("./index");
    expect(fmtDate(new Date("2026-06-13T12:00:00Z"))).toBe("Jun 13, 2026");
    expect(fmtDateTime(new Date("2026-06-13T09:05:00Z"))).toBe("2026-06-13 09:05 UTC");
    expect(fmtDate(null)).toBe("-");
  });
});
