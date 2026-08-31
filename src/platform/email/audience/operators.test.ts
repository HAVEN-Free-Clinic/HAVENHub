import { describe, expect, it } from "vitest";
import {
  MATCH_NOBODY,
  asArray,
  enumWhere,
  parseTextList,
  stringSetFilter,
  textWhere,
  yearWhere,
} from "./operators";
import type { AudienceCondition } from "./types";

const cond = (op: AudienceCondition["op"], value?: string | string[]): AudienceCondition => ({
  field: "f",
  op,
  value,
});

describe("parseTextList", () => {
  it("splits on newlines and commas, trimming blanks", () => {
    expect(parseTextList("a, b\nc\n\n , d ")).toEqual(["a", "b", "c", "d"]);
  });

  it("passes an array through, trimming and dropping blanks", () => {
    expect(parseTextList([" a ", "", "b"])).toEqual(["a", "b"]);
  });

  it("is empty for undefined", () => {
    expect(parseTextList(undefined)).toEqual([]);
  });
});

describe("asArray", () => {
  it("wraps a non-empty string", () => {
    expect(asArray("a")).toEqual(["a"]);
  });
  it("is empty for a blank string or undefined", () => {
    expect(asArray("")).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
  });
});

describe("stringSetFilter", () => {
  it("builds an `in` filter for a positive op", () => {
    expect(stringSetFilter(cond("in", ["a", "b"]))).toEqual({ in: ["a", "b"] });
  });

  it("builds a `notIn` filter for a negative op", () => {
    expect(stringSetFilter(cond("notIn", ["a"]))).toEqual({ notIn: ["a"] });
  });

  // The whole point of the null return: an empty NEGATIVE set would otherwise
  // compile to `notIn: []`, which is true for every row in the table.
  it("returns null for an empty set, positive or negative", () => {
    expect(stringSetFilter(cond("in", []))).toBeNull();
    expect(stringSetFilter(cond("notIn", []))).toBeNull();
    expect(stringSetFilter(cond("notIn", undefined))).toBeNull();
  });
});

describe("textWhere", () => {
  it("matches case-insensitively for contains", () => {
    expect(textWhere("name", cond("contains", "ann"), false)).toEqual({
      name: { contains: "ann", mode: "insensitive" },
    });
  });

  it("expands `in` to an OR of equals (Postgres ignores mode on `in`)", () => {
    expect(textWhere("netId", cond("in", "ab123\ncd456"), true)).toEqual({
      OR: [
        { netId: { equals: "ab123", mode: "insensitive" } },
        { netId: { equals: "cd456", mode: "insensitive" } },
      ],
    });
  });

  it("keeps null rows on a negative op over a nullable column", () => {
    // "epicId is not X" must include people with NO Epic ID. Prisma's `not` and
    // `NOT` both drop NULL rows, so the null half has to be explicit.
    expect(textWhere("epicId", cond("notEq", "X"), true)).toEqual({
      OR: [{ epicId: null }, { epicId: { not: "X", mode: "insensitive" } }],
    });
  });

  it("omits the null half on a negative op over a NOT NULL column", () => {
    // Prisma rejects a null filter on a required column with a validation error.
    expect(textWhere("name", cond("notEq", "X"), false)).toEqual({
      name: { not: "X", mode: "insensitive" },
    });
  });

  it("negates contains through NOT, keeping null rows", () => {
    expect(textWhere("epicId", cond("notContains", "X"), true)).toEqual({
      OR: [{ epicId: null }, { NOT: { epicId: { contains: "X", mode: "insensitive" } } }],
    });
  });

  it("expands `notIn` to a NOT over the OR-of-equals", () => {
    expect(textWhere("netId", cond("notIn", "a\nb"), true)).toEqual({
      OR: [
        { netId: null },
        {
          NOT: {
            OR: [
              { netId: { equals: "a", mode: "insensitive" } },
              { netId: { equals: "b", mode: "insensitive" } },
            ],
          },
        },
      ],
    });
  });

  it("treats an empty column as null OR empty string when nullable", () => {
    expect(textWhere("phone", cond("isEmpty"), true)).toEqual({
      OR: [{ phone: null }, { phone: "" }],
    });
  });

  // The safety invariant, stated once per operator family.
  it.each(["contains", "eq", "startsWith", "endsWith", "notEq", "notContains"] as const)(
    "matches nobody when %s has a blank value",
    (op) => {
      expect(textWhere("netId", cond(op, "   "), true)).toEqual(MATCH_NOBODY);
    },
  );

  it.each(["in", "notIn"] as const)("matches nobody when %s has an empty list", (op) => {
    expect(textWhere("netId", cond(op, ""), true)).toEqual(MATCH_NOBODY);
  });
});

describe("enumWhere", () => {
  it("compiles eq to a bare equality", () => {
    expect(enumWhere("status", cond("eq", "ACTIVE"), false)).toEqual({ status: "ACTIVE" });
  });

  it("compiles in to a set filter", () => {
    expect(enumWhere("status", cond("in", ["ACTIVE", "OFFBOARDED"]), false)).toEqual({
      status: { in: ["ACTIVE", "OFFBOARDED"] },
    });
  });

  it("keeps null rows on notEq over a nullable column", () => {
    expect(enumWhere("yaleAffiliation", cond("notEq", "ysm_md"), true)).toEqual({
      OR: [{ yaleAffiliation: null }, { yaleAffiliation: { not: "ysm_md" } }],
    });
  });

  it("keeps null rows on notIn over a nullable column", () => {
    expect(enumWhere("yaleAffiliation", cond("notIn", ["a", "b"]), true)).toEqual({
      OR: [{ yaleAffiliation: null }, { yaleAffiliation: { notIn: ["a", "b"] } }],
    });
  });

  it.each(["eq", "notEq"] as const)("matches nobody when %s has a blank value", (op) => {
    expect(enumWhere("status", cond(op, ""), false)).toEqual(MATCH_NOBODY);
  });

  it.each(["in", "notIn"] as const)("matches nobody when %s has an empty list", (op) => {
    expect(enumWhere("status", cond(op, []), false)).toEqual(MATCH_NOBODY);
  });

  it("matches nobody when a value is outside the allowed set", () => {
    // A stored audience naming a value the enum no longer has must not compile to
    // an invalid Prisma enum (a 500) nor be silently dropped (matching everyone).
    expect(enumWhere("status", cond("eq", "RETIRED"), false, ["ACTIVE", "OFFBOARDED"])).toEqual(
      MATCH_NOBODY,
    );
  });

  it("filters unknown values out of a set rather than failing the whole condition", () => {
    expect(
      enumWhere("status", cond("in", ["ACTIVE", "RETIRED"]), false, ["ACTIVE", "OFFBOARDED"]),
    ).toEqual({ status: { in: ["ACTIVE"] } });
  });
});

describe("yearWhere", () => {
  // gradYear is a String? column, so comparison is lexicographic. That is exactly
  // numeric order for equal-length 4-digit years, which is all we accept.
  it("compiles lt to a string comparison", () => {
    expect(yearWhere("gradYear", cond("lt", "2026"))).toEqual({
      gradYear: { lt: "2026" },
    });
  });

  it("compiles gt to a string comparison", () => {
    expect(yearWhere("gradYear", cond("gt", "2024"))).toEqual({
      gradYear: { gt: "2024" },
    });
  });

  it("matches nobody for a non-4-digit year", () => {
    // "'26", "2026 (expected)" and other dirty values would compare wrong, so an
    // ordered operator only accepts a clean 4-digit year.
    expect(yearWhere("gradYear", cond("lt", "26"))).toEqual(MATCH_NOBODY);
    expect(yearWhere("gradYear", cond("gt", "twenty"))).toEqual(MATCH_NOBODY);
    expect(yearWhere("gradYear", cond("lt", ""))).toEqual(MATCH_NOBODY);
  });

  it("delegates every non-ordered operator to the text compiler", () => {
    expect(yearWhere("gradYear", cond("eq", "2026"))).toEqual({
      gradYear: { equals: "2026", mode: "insensitive" },
    });
    expect(yearWhere("gradYear", cond("isEmpty"))).toEqual({
      OR: [{ gradYear: null }, { gradYear: "" }],
    });
  });
});
