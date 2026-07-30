import { describe, it, expect } from "vitest";
import { formatTrainingDate, formatTrainingLocation } from "./training-date";

describe("formatTrainingDate", () => {
  it("formats a date-only string in the display zone, with no time of day", () => {
    // inPersonTrainingDate is written as noon UTC (see actions.ts), which is
    // 8:00 AM in America/New_York -- same calendar day, and there is no
    // meaningful time-of-day stored, so only the date should render.
    expect(formatTrainingDate(new Date("2026-05-03T12:00:00Z"), "America/New_York"))
      .toBe("Sunday, May 3");
  });
  it("falls back to a neutral phrase when unset", () => {
    expect(formatTrainingDate(null, "America/New_York")).toBe("the scheduled training date");
  });
});

describe("formatTrainingLocation", () => {
  it("prefixes a location with a space", () => {
    expect(formatTrainingLocation("in person")).toBe(" in person");
  });
  it("trims surrounding whitespace before prefixing", () => {
    expect(formatTrainingLocation("  on Zoom at 10:00 AM  ")).toBe(" on Zoom at 10:00 AM");
  });
  it("returns an empty string when unset, so the sentence still reads", () => {
    expect(formatTrainingLocation(null)).toBe("");
  });
  it("returns an empty string for a blank string", () => {
    expect(formatTrainingLocation("   ")).toBe("");
  });
});
