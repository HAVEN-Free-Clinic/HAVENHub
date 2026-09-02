import { describe, expect, it } from "vitest";
import { mappedDateWhere } from "./operators";
import type { AudienceCondition } from "./types";

// Same fixed clock as date-operators.test.ts: 2026-03-15T18:00Z is 14:00 in
// New York (EDT, UTC-4), so the local day boundary is 04:00Z the same date.
const NOW = new Date("2026-03-15T18:00:00.000Z");
const CTX = { now: NOW, zone: "America/New_York" };

function cond(op: AudienceCondition["op"], value?: string | string[]): AudienceCondition {
  return { field: "hipaaExpiresAt", op, value };
}

/** mappedDateWhere returns { id: { in: [...] } }; compare as a sorted set. */
function ids(w: ReturnType<typeof mappedDateWhere>): string[] {
  const inList = (w as { id?: { in?: string[] } }).id?.in ?? [];
  return [...inList].sort();
}

const VALUES = new Map<string, Date | null>([
  ["inside", new Date("2026-03-20T12:00:00.000Z")], // 5 days out
  ["outside", new Date("2026-05-01T12:00:00.000Z")], // ~47 days out
  ["past", new Date("2026-01-01T12:00:00.000Z")], // in the past
  ["none", null], // no computable date at all
]);

describe("mappedDateWhere", () => {
  it("withinNextDays matches a value inside the window and excludes one outside it", () => {
    expect(ids(mappedDateWhere(VALUES, cond("withinNextDays", "30"), CTX))).toEqual(["inside"]);
  });

  it("withinLastDays matches a value inside the trailing window", () => {
    expect(ids(mappedDateWhere(VALUES, cond("withinLastDays", "90"), CTX))).toEqual(["past"]);
  });

  it("a null value never satisfies a comparison operator", () => {
    expect(ids(mappedDateWhere(VALUES, cond("before", "2026-12-31"), CTX))).not.toContain("none");
    expect(ids(mappedDateWhere(VALUES, cond("after", "2020-01-01"), CTX))).not.toContain("none");
  });

  it("isEmpty matches only the null entries", () => {
    expect(ids(mappedDateWhere(VALUES, cond("isEmpty"), CTX))).toEqual(["none"]);
  });

  it("isNotEmpty matches every non-null entry", () => {
    expect(ids(mappedDateWhere(VALUES, cond("isNotEmpty"), CTX))).toEqual(["inside", "outside", "past"]);
  });

  it("before/after/onOrBefore/onOrAfter compile the same boundaries dateWhere does", () => {
    expect(ids(mappedDateWhere(VALUES, cond("before", "2026-03-16"), CTX))).toEqual(["past"]);
    expect(ids(mappedDateWhere(VALUES, cond("after", "2026-04-01"), CTX)).sort()).toEqual(["outside"]);
    expect(ids(mappedDateWhere(VALUES, cond("onOrAfter", "2026-03-20"), CTX)).sort()).toEqual([
      "inside",
      "outside",
    ]);
  });

  it("between is a half-open range covering both endpoint days", () => {
    expect(
      ids(mappedDateWhere(VALUES, cond("between", ["2026-03-18", "2026-03-22"]), CTX)),
    ).toEqual(["inside"]);
  });

  it.each([
    ["a blank absolute value", cond("before", "")],
    ["a malformed date", cond("before", "not-a-date")],
    ["a non-numeric window", cond("withinNextDays", "soon")],
    ["a negative window", cond("withinNextDays", "-5")],
  ])("matches nobody for %s", (_label, c) => {
    expect(mappedDateWhere(VALUES, c, CTX)).toEqual({ id: { in: [] } });
  });

  it("matches nobody when the map is empty", () => {
    expect(mappedDateWhere(new Map(), cond("isNotEmpty"), CTX)).toEqual({ id: { in: [] } });
  });
});
