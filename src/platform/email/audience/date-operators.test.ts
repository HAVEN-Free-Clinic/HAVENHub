import { describe, expect, it } from "vitest";
import { dateWhere } from "./operators";
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
  ])("matches nobody for %s", (_label, c) => {
    expect(dateWhere("expiresAt", c, CTX)).toEqual({ id: { in: [] } });
  });

  it("crosses a DST boundary correctly", () => {
    // 2026-03-08 is the US spring-forward date. A window spanning it must still
    // land on real local midnights, which differ in UTC offset on either side.
    const beforeDst = { now: new Date("2026-03-05T18:00:00.000Z"), zone: "America/New_York" };
    const w = dateWhere("expiresAt", cond("onOrAfter", "2026-03-01"), beforeDst);
    // March 1 is still EST (UTC-5), so local midnight is 05:00Z.
    expect(w).toEqual({ expiresAt: { gte: new Date("2026-03-01T05:00:00.000Z") } });
  });
});
