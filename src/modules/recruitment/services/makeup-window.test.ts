import { expect, it } from "vitest";
import { makeupIsOpen, makeupOpensOn } from "./makeup-window";
import { isoDateKey } from "@/platform/dates";

const ET = "America/New_York";
// Training day: 2026-08-15 (stored noon UTC).
const trainingDate = new Date(Date.UTC(2026, 7, 15, 12, 0, 0));

it("is open when no date is set (no gate)", () => {
  expect(makeupIsOpen(null, new Date(), ET)).toBe(true);
});

it("is closed before and on the training day, open the day after (ET)", () => {
  // Day before, ET afternoon.
  expect(makeupIsOpen(trainingDate, new Date(Date.UTC(2026, 7, 14, 20, 0, 0)), ET)).toBe(false);
  // The training day itself, late ET evening (still 2026-08-15 in ET; 03:00Z next day).
  expect(makeupIsOpen(trainingDate, new Date(Date.UTC(2026, 7, 16, 3, 0, 0)), ET)).toBe(false);
  // The day after, ET morning.
  expect(makeupIsOpen(trainingDate, new Date(Date.UTC(2026, 7, 16, 14, 0, 0)), ET)).toBe(true);
});

it("makeupOpensOn returns the calendar day after the training date", () => {
  expect(isoDateKey(makeupOpensOn(trainingDate))).toBe("2026-08-16");
});
