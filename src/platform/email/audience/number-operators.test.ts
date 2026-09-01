import { describe, expect, it } from "vitest";
import { countWhere } from "./operators";
import type { AudienceCondition } from "./types";

const COUNTS = new Map<string, number>([
  ["p-zero", 0],
  ["p-one", 1],
  ["p-three", 3],
  ["p-ten", 10],
]);

function cond(op: AudienceCondition["op"], value?: string | string[]): AudienceCondition {
  return { field: "shiftCount", op, value };
}

/** countWhere returns { id: { in: [...] } }; compare as a sorted set. */
function ids(w: ReturnType<typeof countWhere>): string[] {
  const inList = (w as { id?: { in?: string[] } }).id?.in ?? [];
  return [...inList].sort();
}

describe("countWhere", () => {
  it("eq selects exactly that count", () => {
    expect(ids(countWhere(COUNTS, cond("eq", "3")))).toEqual(["p-three"]);
  });

  it("notEq selects everyone else IN THE MAP, including zero", () => {
    // The map is the universe here: a person with no rows must still appear
    // with a count of 0, or "fewer than 3 shifts" would silently exclude
    // everyone who has never signed up, which is the opposite of the intent.
    expect(ids(countWhere(COUNTS, cond("notEq", "3")))).toEqual(["p-one", "p-ten", "p-zero"]);
  });

  it("lt, lte, gt, gte compare numerically", () => {
    expect(ids(countWhere(COUNTS, cond("lt", "3")))).toEqual(["p-one", "p-zero"]);
    expect(ids(countWhere(COUNTS, cond("lte", "3")))).toEqual(["p-one", "p-three", "p-zero"]);
    expect(ids(countWhere(COUNTS, cond("gt", "3")))).toEqual(["p-ten"]);
    expect(ids(countWhere(COUNTS, cond("gte", "3")))).toEqual(["p-ten", "p-three"]);
  });

  it("between is inclusive on both ends", () => {
    expect(ids(countWhere(COUNTS, cond("between", ["1", "3"])))).toEqual(["p-one", "p-three"]);
  });

  it.each([
    ["a blank value", cond("eq", "")],
    ["a non-numeric value", cond("eq", "three")],
    ["a negative value", cond("gte", "-1")],
    ["a fractional value", cond("eq", "1.5")],
    ["a between with one endpoint", cond("between", ["1"])],
    ["a between with a bad endpoint", cond("between", ["1", "x"])],
    ["an inverted between", cond("between", ["5", "2"])],
  ])("matches nobody for %s", (_label, c) => {
    expect(countWhere(COUNTS, c)).toEqual({ id: { in: [] } });
  });

  it("matches nobody when the map is empty", () => {
    expect(countWhere(new Map(), cond("gte", "1"))).toEqual({ id: { in: [] } });
  });
});
