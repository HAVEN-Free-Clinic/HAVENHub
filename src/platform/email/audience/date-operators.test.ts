import { describe, expect, it } from "vitest";
import { dateWhere } from "./operators";
import { isCalendarDay } from "./zoned-day";
import type { AudienceCondition } from "./types";

// A fixed clock. 2026-03-15T18:00Z is 14:00 in New York (EDT, UTC-4), so the
// local day boundary is 04:00Z the same date. Chosen deliberately inside
// daylight saving so a naive UTC-midnight implementation fails these tests.
const NOW = new Date("2026-03-15T18:00:00.000Z");
const CTX = { now: NOW, zone: "America/New_York" };

function cond(op: AudienceCondition["op"], value?: string | string[]): AudienceCondition {
  return { field: "expiresAt", op, value };
}

describe("dateWhere", () => {
  it("compiles `before` to a lt at the local start of that day", () => {
    const w = dateWhere("expiresAt", cond("before", "2026-03-20"), CTX);
    expect(w).toEqual({ expiresAt: { lt: new Date("2026-03-20T04:00:00.000Z") } });
  });

  it("compiles `after` to a gte at the local start of the NEXT day", () => {
    // "after March 20" must exclude every instant on March 20 itself, so the
    // boundary is the start of March 21, not the start of March 20.
    const w = dateWhere("expiresAt", cond("after", "2026-03-20"), CTX);
    expect(w).toEqual({ expiresAt: { gte: new Date("2026-03-21T04:00:00.000Z") } });
  });

  it("compiles `onOrBefore` to include the whole named day", () => {
    const w = dateWhere("expiresAt", cond("onOrBefore", "2026-03-20"), CTX);
    expect(w).toEqual({ expiresAt: { lt: new Date("2026-03-21T04:00:00.000Z") } });
  });

  it("compiles `onOrAfter` to the local start of the named day", () => {
    const w = dateWhere("expiresAt", cond("onOrAfter", "2026-03-20"), CTX);
    expect(w).toEqual({ expiresAt: { gte: new Date("2026-03-20T04:00:00.000Z") } });
  });

  it("compiles `between` as a half-open range covering both endpoint days", () => {
    const w = dateWhere("expiresAt", cond("between", ["2026-03-18", "2026-03-20"]), CTX);
    expect(w).toEqual({
      expiresAt: {
        gte: new Date("2026-03-18T04:00:00.000Z"),
        lt: new Date("2026-03-21T04:00:00.000Z"),
      },
    });
  });

  it("compiles `withinNextDays` from now to the end of the Nth day ahead", () => {
    const w = dateWhere("expiresAt", cond("withinNextDays", "5"), CTX);
    expect(w).toEqual({
      expiresAt: { gte: NOW, lt: new Date("2026-03-21T04:00:00.000Z") },
    });
  });

  it("compiles `withinLastDays` from the start of the Nth day back to now", () => {
    const w = dateWhere("expiresAt", cond("withinLastDays", "5"), CTX);
    expect(w).toEqual({
      expiresAt: { gte: new Date("2026-03-10T04:00:00.000Z"), lte: NOW },
    });
  });

  it("handles isEmpty and isNotEmpty", () => {
    expect(dateWhere("expiresAt", cond("isEmpty"), CTX)).toEqual({ expiresAt: null });
    expect(dateWhere("expiresAt", cond("isNotEmpty"), CTX)).toEqual({
      expiresAt: { not: null },
    });
  });

  // The match-nobody invariant, in every shape that can go wrong.
  it.each([
    ["a blank absolute value", cond("before", "")],
    ["a malformed date", cond("before", "not-a-date")],
    ["a partial date", cond("before", "2026-03")],
    ["a between with one endpoint", cond("between", ["2026-03-18"])],
    ["a between with a malformed endpoint", cond("between", ["2026-03-18", "nope"])],
    ["a non-numeric window", cond("withinNextDays", "soon")],
    ["a negative window", cond("withinNextDays", "-5")],
    ["a fractional window", cond("withinNextDays", "1.5")],
    ["a blank window", cond("withinLastDays", "")],
    // Digit-shaped but impossible calendar dates. Date.UTC ROLLS these forward
    // (Feb 30 -> Mar 2, month 13 -> the following January, day 00 -> the last
    // day of the previous month), so without a round-trip check each of these
    // silently compiles to a boundary on a DIFFERENT day than the one asked
    // for. See the dedicated widening test below.
    ["an impossible day of the month", cond("before", "2026-02-30")],
    ["an impossible month", cond("after", "2026-13-01")],
    ["a zero day", cond("onOrAfter", "2026-03-00")],
    ["a zero month", cond("onOrBefore", "2026-00-15")],
    ["a between with an impossible endpoint", cond("between", ["2026-02-30", "2026-03-05"])],
    ["a between with an impossible start", cond("between", ["2026-03-01", "2026-04-31"])],
  ])("matches nobody for %s", (_label, c) => {
    expect(dateWhere("expiresAt", c, CTX)).toEqual({ id: { in: [] } });
  });

  // The reason an impossible date must not merely "resolve to something": the
  // roll-forward moves a before/onOrBefore boundary OUTWARD, which WIDENS the
  // send list rather than narrowing it. A native <input type="date"> cannot
  // emit "2026-02-30", but audiences are stored as free-form JSON, so a
  // hand-edited or migrated one can.
  it("does not roll an impossible date forward into a later, wider boundary", () => {
    const rolled = new Date("2026-03-02T05:00:00.000Z"); // what Date.UTC turns Feb 30 into
    expect(dateWhere("expiresAt", cond("before", "2026-02-30"), CTX)).not.toEqual({
      expiresAt: { lt: rolled },
    });
    expect(dateWhere("expiresAt", cond("onOrBefore", "2026-02-30"), CTX)).not.toEqual({
      expiresAt: { lt: new Date("2026-03-03T05:00:00.000Z") },
    });
  });

  it("still accepts the real leap day", () => {
    // 2028 is a leap year, so Feb 29 is a real date and must NOT be rejected by
    // the round-trip check that rejects Feb 30.
    expect(dateWhere("expiresAt", cond("onOrAfter", "2028-02-29"), CTX)).toEqual({
      expiresAt: { gte: new Date("2028-02-29T05:00:00.000Z") },
    });
    // 2026 is not, so Feb 29 does not exist that year.
    expect(dateWhere("expiresAt", cond("onOrAfter", "2026-02-29"), CTX)).toEqual({
      id: { in: [] },
    });
  });

  // Defect 1.3. A reversed range is empty either way, but the REPRESENTATION
  // decides what a NONE group does with it: compileGroup renders NONE as
  // `NOT { OR: fragments }`, and Prisma compiles the MATCH_NOBODY sentinel to
  // `NOT 1=0` (everyone) while it compiles an empty gte/lt pair to
  // `NOT (col >= X AND col < Y)`, which is NULL, and therefore NOT TRUE, for a
  // NULL column. countWhere already returns the sentinel for `lo > hi`; this
  // makes the date branch agree. See date-fields.test.ts for the executed-SQL
  // proof on a nullable column.
  it.each([
    ["a reversed range", cond("between", ["2026-03-20", "2026-03-18"])],
    // gte is the start of pair[0] and lt the start of the day AFTER pair[1], so
    // a VALID single-day range has gte < lt. Reversed by exactly one day is the
    // boundary case where gte === lt.
    ["a range reversed by exactly one day", cond("between", ["2026-03-19", "2026-03-18"])],
  ])("compiles %s to the match-nobody sentinel, not an empty gte/lt pair", (_label, c) => {
    expect(dateWhere("expiresAt", c, CTX)).toEqual({ id: { in: [] } });
  });

  it("still compiles a single-day range, which is NOT reversed", () => {
    expect(dateWhere("expiresAt", cond("between", ["2026-03-18", "2026-03-18"]), CTX)).toEqual({
      expiresAt: {
        gte: new Date("2026-03-18T04:00:00.000Z"),
        lt: new Date("2026-03-19T04:00:00.000Z"),
      },
    });
  });

  it("crosses a DST boundary correctly", () => {
    // 2026-03-08 is the US spring-forward date. A window spanning it must still
    // land on real local midnights, which differ in UTC offset on either side.
    const beforeDst = { now: new Date("2026-03-05T18:00:00.000Z"), zone: "America/New_York" };
    const w = dateWhere("expiresAt", cond("onOrAfter", "2026-03-01"), beforeDst);
    // March 1 is still EST (UTC-5), so local midnight is 05:00Z.
    expect(w).toEqual({ expiresAt: { gte: new Date("2026-03-01T05:00:00.000Z") } });
  });

  it("crosses a DST fall-back boundary correctly", () => {
    // 2026-11-01 is the US fall-back date, so that LOCAL day is 25 hours long.
    // Adding 24h to its midnight lands back inside the same day, which silently
    // made `after` include a day it must exclude. Nov 1 is EDT (UTC-4) at
    // midnight; Nov 2 is EST (UTC-5), so its midnight is 05:00Z.
    const ctx = { now: new Date("2026-11-01T18:00:00.000Z"), zone: "America/New_York" };
    expect(dateWhere("expiresAt", cond("after", "2026-11-01"), ctx)).toEqual({
      expiresAt: { gte: new Date("2026-11-02T05:00:00.000Z") },
    });
    expect(dateWhere("expiresAt", cond("onOrBefore", "2026-11-01"), ctx)).toEqual({
      expiresAt: { lt: new Date("2026-11-02T05:00:00.000Z") },
    });
  });

  it("crosses a DST fall-back boundary correctly in a relative window", () => {
    // Same fall-back day, but anchored as `now` itself at local midnight, which
    // is the shape that broke the window operators: adding 24 real hours to a
    // 25-hour local day landed back on the SAME day, making `withinNextDays`
    // compile a `lt` equal to its own `gte` (an inverted, always-empty range).
    const ctx = { now: new Date("2026-11-01T04:00:00.000Z"), zone: "America/New_York" };
    const w = dateWhere("expiresAt", cond("withinNextDays", "0"), ctx);
    expect(w).toEqual({
      expiresAt: { gte: ctx.now, lt: new Date("2026-11-02T05:00:00.000Z") },
    });
  });
});

// The shared gate both startOfDay and startOfNextDay run their input through.
// Tested directly as well as through dateWhere above, because it is the single
// place that decides whether an impossible date resolves to match-nobody or to
// a silently different day.
describe("isCalendarDay", () => {
  it.each([
    "2026-03-20",
    "2026-01-01",
    "2026-12-31",
    "2028-02-29", // a real leap day
  ])("accepts the real date %s", (day) => {
    expect(isCalendarDay(day)).toBe(true);
  });

  it.each([
    ["the wrong shape", "2026-3-20"],
    ["a partial date", "2026-03"],
    ["free text", "not-a-date"],
    ["a trailing time part", "2026-03-20T00:00"],
    ["an empty string", ""],
    ["Feb 30", "2026-02-30"],
    ["Feb 29 in a non-leap year", "2026-02-29"],
    ["April 31", "2026-04-31"],
    ["month 13", "2026-13-01"],
    ["month 00", "2026-00-15"],
    ["day 00", "2026-03-00"],
    ["day 32", "2026-03-32"],
    // Date.UTC maps years 0-99 onto 1900+, so "0026" would rebuild as 1926 and
    // fail the round trip. Rejecting it is the right answer: no real audience
    // names year 26, and the alternative is resolving it nineteen centuries
    // away from what was written.
    ["a year Date.UTC remaps", "0026-02-03"],
  ])("rejects %s", (_label, day) => {
    expect(isCalendarDay(day)).toBe(false);
  });
});
