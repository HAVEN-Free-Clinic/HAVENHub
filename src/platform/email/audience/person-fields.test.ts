import { describe, expect, it } from "vitest";
import { PERSON_FIELDS, personFieldWhere, parseTextList } from "./person-fields";

const ctx = { activeTermId: "term1" };

describe("person fields", () => {
  it("exposes a whitelist with options", () => {
    const keys = PERSON_FIELDS.map((f) => f.key);
    expect(keys).toEqual([
      "name", "netId", "contactEmail", "epicId", "phone", "yaleAffiliation", "gradYear",
      "status", "role", "department", "complianceStatus", "hasEpicId",
    ]);
  });

  it("status -> direct equality", () => {
    expect(personFieldWhere({ field: "status", op: "eq", value: "ACTIVE" }, ctx)).toEqual({ status: "ACTIVE" });
  });

  it("role -> active-term membership of that kind", () => {
    expect(personFieldWhere({ field: "role", op: "eq", value: "DIRECTOR" }, ctx)).toEqual({
      memberships: { some: { termId: "term1", status: "ACTIVE", kind: "DIRECTOR" } },
    });
  });

  it("department -> active-term membership in those department codes", () => {
    expect(personFieldWhere({ field: "department", op: "in", value: ["CARDIO", "PEDS"] }, ctx)).toEqual({
      memberships: { some: { termId: "term1", status: "ACTIVE", department: { code: { in: ["CARDIO", "PEDS"] } } } },
    });
  });

  it("complianceStatus -> ComplianceReminder.lastStatus in values", () => {
    expect(personFieldWhere({ field: "complianceStatus", op: "in", value: ["EXPIRED"] }, ctx)).toEqual({
      complianceReminder: { lastStatus: { in: ["EXPIRED"] } },
    });
  });

  it("hasEpicId true/false", () => {
    expect(personFieldWhere({ field: "hasEpicId", op: "isTrue" }, ctx)).toEqual({ epicId: { not: null } });
    expect(personFieldWhere({ field: "hasEpicId", op: "isFalse" }, ctx)).toEqual({ epicId: null });
  });

  it("throws on an unknown field", () => {
    expect(() => personFieldWhere({ field: "bogus", op: "eq", value: "x" }, ctx)).toThrow(/Unknown audience field/);
  });
});

describe("text operators", () => {
  it("contains -> case-insensitive contains", () => {
    expect(personFieldWhere({ field: "name", op: "contains", value: "jane" }, ctx)).toEqual({
      name: { contains: "jane", mode: "insensitive" },
    });
  });

  it("eq -> case-insensitive equals", () => {
    expect(personFieldWhere({ field: "name", op: "eq", value: "Jane Doe" }, ctx)).toEqual({
      name: { equals: "Jane Doe", mode: "insensitive" },
    });
  });

  it("startsWith / endsWith -> case-insensitive", () => {
    expect(personFieldWhere({ field: "contactEmail", op: "endsWith", value: "@yale.edu" }, ctx)).toEqual({
      contactEmail: { endsWith: "@yale.edu", mode: "insensitive" },
    });
    expect(personFieldWhere({ field: "netId", op: "startsWith", value: "abc" }, ctx)).toEqual({
      netId: { startsWith: "abc", mode: "insensitive" },
    });
  });

  it("in (is any of) -> parses a comma/newline list, exact match", () => {
    expect(personFieldWhere({ field: "netId", op: "in", value: "abc123, def456\nghi789" }, ctx)).toEqual({
      netId: { in: ["abc123", "def456", "ghi789"] },
    });
  });

  it("isEmpty / isNotEmpty -> null-or-blank checks", () => {
    expect(personFieldWhere({ field: "epicId", op: "isEmpty" }, ctx)).toEqual({
      OR: [{ epicId: null }, { epicId: "" }],
    });
    expect(personFieldWhere({ field: "epicId", op: "isNotEmpty" }, ctx)).toEqual({
      AND: [{ epicId: { not: null } }, { epicId: { not: "" } }],
    });
  });

  it("safety: a blank value operator matches nobody", () => {
    expect(personFieldWhere({ field: "name", op: "contains", value: "" }, ctx)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "name", op: "contains", value: "   " }, ctx)).toEqual({ id: { in: [] } });
  });

  it("safety: an empty 'is any of' list matches nobody", () => {
    expect(personFieldWhere({ field: "netId", op: "in", value: "  , \n " }, ctx)).toEqual({ id: { in: [] } });
  });
});

describe("parseTextList", () => {
  it("splits on commas and newlines, trims, drops blanks", () => {
    expect(parseTextList("a, b\nc ,, \n d")).toEqual(["a", "b", "c", "d"]);
  });
  it("passes through an array, trimming and dropping blanks", () => {
    expect(parseTextList(["a", " b ", ""])).toEqual(["a", "b"]);
  });
  it("returns [] for undefined", () => {
    expect(parseTextList(undefined)).toEqual([]);
  });
});
