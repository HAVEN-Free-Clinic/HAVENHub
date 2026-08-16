import { describe, expect, it } from "vitest";
import { isSelectedDateToday } from "./attendance-window";

describe("isSelectedDateToday", () => {
  it("returns true when the selected date equals today's key", () => {
    expect(isSelectedDateToday("2026-08-08", "2026-08-08")).toBe(true);
  });

  it("returns false for a past date", () => {
    expect(isSelectedDateToday("2026-08-01", "2026-08-08")).toBe(false);
  });

  it("returns false for a future date", () => {
    expect(isSelectedDateToday("2026-08-15", "2026-08-08")).toBe(false);
  });

  // fullSchedule returns a null selectedDate when there is no active term or
  // the term has no clinic dates yet; the page must not treat that as "today".
  it("returns false when there is no selected date", () => {
    expect(isSelectedDateToday(null, "2026-08-08")).toBe(false);
  });
});
