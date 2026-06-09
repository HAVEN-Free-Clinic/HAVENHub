import { describe, expect, it } from "vitest";
import { PERSON_FIELDS, personFieldWhere } from "./person-fields";

const ctx = { activeTermId: "term1" };

describe("person fields", () => {
  it("exposes a whitelist with options", () => {
    const keys = PERSON_FIELDS.map((f) => f.key);
    expect(keys).toEqual(["status", "role", "department", "complianceStatus", "hasEpicId"]);
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
