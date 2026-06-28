import { describe, expect, it } from "vitest";
import { PERSON_FIELDS, PERSON_FIELD_VIEWS, personFieldWhere, parseTextList } from "./person-fields";

const ctx = { activeTermId: "term1" };

describe("person fields", () => {
  it("exposes a whitelist with options", () => {
    const keys = PERSON_FIELDS.map((f) => f.key);
    expect(keys).toEqual([
      "name", "netId", "contactEmail", "epicId", "phone", "yaleAffiliation", "gradYear",
      "status", "role", "department", "complianceStatus", "hasEpicId",
      "spanishVerified", "spanishSelfReported", "licensedRN", "hasOpenEpicRequest", "hasDisciplinaryAction",
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

  it("in (is any of) -> case-insensitive OR of equals from a comma/newline list", () => {
    expect(personFieldWhere({ field: "netId", op: "in", value: "abc123, def456\nghi789" }, ctx)).toEqual({
      OR: [
        { netId: { equals: "abc123", mode: "insensitive" } },
        { netId: { equals: "def456", mode: "insensitive" } },
        { netId: { equals: "ghi789", mode: "insensitive" } },
      ],
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

describe("booleans and relations", () => {
  it("spanishVerified / spanishSelfReported / licensedRN -> direct boolean", () => {
    expect(personFieldWhere({ field: "spanishVerified", op: "isTrue" }, ctx)).toEqual({ spanishVerified: true });
    expect(personFieldWhere({ field: "spanishVerified", op: "isFalse" }, ctx)).toEqual({ spanishVerified: false });
    expect(personFieldWhere({ field: "spanishSelfReported", op: "isTrue" }, ctx)).toEqual({ spanishSelfReported: true });
    expect(personFieldWhere({ field: "spanishSelfReported", op: "isFalse" }, ctx)).toEqual({ spanishSelfReported: false });
    expect(personFieldWhere({ field: "licensedRN", op: "isTrue" }, ctx)).toEqual({ licensedRN: true });
    expect(personFieldWhere({ field: "licensedRN", op: "isFalse" }, ctx)).toEqual({ licensedRN: false });
  });

  it("hasOpenEpicRequest -> some/none PENDING epic request", () => {
    expect(personFieldWhere({ field: "hasOpenEpicRequest", op: "isTrue" }, ctx)).toEqual({
      epicRequests: { some: { status: "PENDING" } },
    });
    expect(personFieldWhere({ field: "hasOpenEpicRequest", op: "isFalse" }, ctx)).toEqual({
      epicRequests: { none: { status: "PENDING" } },
    });
  });

  it("hasDisciplinaryAction -> some/none disciplinary action", () => {
    expect(personFieldWhere({ field: "hasDisciplinaryAction", op: "isTrue" }, ctx)).toEqual({
      disciplinaryActions: { some: {} },
    });
    expect(personFieldWhere({ field: "hasDisciplinaryAction", op: "isFalse" }, ctx)).toEqual({
      disciplinaryActions: { none: {} },
    });
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

describe("PERSON_FIELD_VIEWS (RSC-serializable)", () => {
  it("mirrors PERSON_FIELDS by key, in order", () => {
    expect(PERSON_FIELD_VIEWS.map((v) => v.key)).toEqual(PERSON_FIELDS.map((f) => f.key));
  });

  it("contains no functions so it can cross the server/client boundary", () => {
    for (const view of PERSON_FIELD_VIEWS) {
      expect("compile" in view).toBe(false);
      for (const value of Object.values(view)) {
        expect(typeof value).not.toBe("function");
      }
    }
    expect(() => JSON.stringify(PERSON_FIELD_VIEWS)).not.toThrow();
  });
});
