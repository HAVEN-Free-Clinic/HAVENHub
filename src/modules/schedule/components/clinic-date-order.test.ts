import { describe, it, expect } from "vitest";
import { sortClinicDates, groupByMonth } from "./clinic-date-order";

/** Noon-UTC anchored calendar date, matching how the schema stores clinicDate. */
function d(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

describe("sortClinicDates", () => {
  it("returns dates in ascending order", () => {
    const out = sortClinicDates([d(2026, 9, 12), d(2026, 9, 26), d(2026, 8, 7)]);
    expect(out).toEqual([d(2026, 8, 7), d(2026, 9, 12), d(2026, 9, 26)]);
  });

  it("does not mutate the input array", () => {
    const input = [d(2026, 9, 12), d(2026, 9, 26), d(2026, 8, 7)];
    const original = [...input];
    sortClinicDates(input);
    expect(input).toEqual(original);
  });
});

describe("groupByMonth", () => {
  it("groups a real seeded-term fixture chronologically, with August before September", () => {
    // Mirrors a real Term.clinicDates array: Postgres gives no ordering
    // guarantee, and the check-in feature's seed appends today's date to the
    // end regardless of where it falls chronologically.
    const outOfOrder = [d(2026, 9, 12), d(2026, 9, 26), d(2026, 8, 7)];
    const groups = groupByMonth(outOfOrder);
    expect(groups.map((g) => g.month)).toEqual(["August 2026", "September 2026"]);
    expect(groups[0].dates).toEqual([d(2026, 8, 7)]);
    expect(groups[1].dates).toEqual([d(2026, 9, 12), d(2026, 9, 26)]);
  });

  it("never produces two groups with the same heading, even from unsorted input", () => {
    const outOfOrder = [d(2026, 9, 26), d(2026, 8, 7), d(2026, 9, 12)];
    const groups = groupByMonth(outOfOrder);
    const headings = groups.map((g) => g.month);
    expect(new Set(headings).size).toBe(headings.length);
  });

  it("never produces an out-of-order heading, even from unsorted input", () => {
    const outOfOrder = [d(2026, 9, 26), d(2026, 8, 7), d(2026, 9, 12), d(2026, 10, 3)];
    const groups = groupByMonth(outOfOrder);
    const times = groups.map((g) => g.dates[0].getTime());
    const sortedTimes = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sortedTimes);
  });

  it("keeps January 2027 and January 2028 as distinct groups across a year boundary", () => {
    const yearBoundary = [d(2028, 1, 5), d(2026, 12, 20), d(2027, 1, 10), d(2027, 1, 24)];
    const groups = groupByMonth(yearBoundary);
    expect(groups.map((g) => g.month)).toEqual(["December 2026", "January 2027", "January 2028"]);
  });

  it("does not mutate the input array", () => {
    const input = [d(2026, 9, 12), d(2026, 9, 26), d(2026, 8, 7)];
    const original = [...input];
    groupByMonth(input);
    expect(input).toEqual(original);
  });
});
