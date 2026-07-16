import { describe, it, expect } from "vitest";
import {
  formatDateTime, formatDateOnly, formatTimeOnly, formatCalendarDate,
  zoneAbbrev, parseZonedInput, formatForDateTimeInput,
} from "./format";

const ET = "America/New_York";

describe("formatDateTime (instant, zoned)", () => {
  it("renders EDT in summer", () => {
    // 2026-06-13T13:05Z == 09:05 EDT
    expect(formatDateTime(new Date("2026-06-13T13:05:00Z"), ET)).toBe("Jun 13, 2026, 9:05 AM EDT");
  });
  it("renders EST in winter", () => {
    // 2026-01-05T14:05Z == 09:05 EST
    expect(formatDateTime(new Date("2026-01-05T14:05:00Z"), ET)).toBe("Jan 5, 2026, 9:05 AM EST");
  });
  it("returns the fallback for null", () => {
    expect(formatDateTime(null, ET)).toBe("-");
    expect(formatDateTime(undefined, ET, undefined, "n/a")).toBe("n/a");
  });
});

describe("formatDateOnly / formatTimeOnly (instant, zoned)", () => {
  it("date-only uses the zone's calendar day (late-evening UTC rolls back)", () => {
    // 2026-06-13T01:00Z == 2026-06-12 21:00 EDT -> previous day in ET
    expect(formatDateOnly(new Date("2026-06-13T01:00:00Z"), ET)).toBe("Jun 12, 2026");
  });
  it("time-only carries the abbreviation", () => {
    expect(formatTimeOnly(new Date("2026-06-13T13:05:00Z"), ET)).toBe("9:05 AM EDT");
  });
});

describe("formatCalendarDate (UTC marker)", () => {
  it("noon-UTC anchor renders its stored day", () => {
    expect(formatCalendarDate(new Date("2026-06-13T12:00:00Z"))).toBe("Jun 13, 2026");
  });
  it("midnight-UTC anchor renders its stored day (no ET rollback)", () => {
    expect(formatCalendarDate(new Date("2026-06-13T00:00:00Z"))).toBe("Jun 13, 2026");
  });
  it("honours an opts override", () => {
    expect(formatCalendarDate(new Date("2026-06-13T12:00:00Z"), { weekday: "long", month: "long", day: "numeric" }))
      .toBe("Saturday, June 13");
  });
});

describe("zoneAbbrev", () => {
  it("flips with DST", () => {
    expect(zoneAbbrev(new Date("2026-06-13T13:00:00Z"), ET)).toBe("EDT");
    expect(zoneAbbrev(new Date("2026-01-05T14:00:00Z"), ET)).toBe("EST");
  });
});

describe("parseZonedInput <-> formatForDateTimeInput round-trip", () => {
  it("interprets a summer wall clock as EDT", () => {
    // 09:05 wall in ET (EDT, -4) == 13:05Z
    expect(parseZonedInput("2026-06-13T09:05", ET)!.toISOString()).toBe("2026-06-13T13:05:00.000Z");
  });
  it("interprets a winter wall clock as EST", () => {
    // 09:05 wall in ET (EST, -5) == 14:05Z
    expect(parseZonedInput("2026-01-05T09:05", ET)!.toISOString()).toBe("2026-01-05T14:05:00.000Z");
  });
  it("round-trips an instant through the input formatter", () => {
    const iso = "2026-06-13T13:05:00.000Z";
    const wall = formatForDateTimeInput(new Date(iso), ET); // "2026-06-13T09:05"
    expect(wall).toBe("2026-06-13T09:05");
    expect(parseZonedInput(wall, ET)!.toISOString()).toBe(iso);
  });
  it("handles the spring-forward gap without crashing", () => {
    // 2026-03-08 02:30 ET does not exist (clocks jump 02:00 -> 03:00).
    const r = parseZonedInput("2026-03-08T02:30", ET);
    expect(r).toBeInstanceOf(Date);
    expect(Number.isNaN(r!.getTime())).toBe(false);
  });
  it("returns null for a malformed string", () => {
    expect(parseZonedInput("not-a-date", ET)).toBeNull();
  });
});
