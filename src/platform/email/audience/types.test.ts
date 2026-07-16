import { describe, expect, it } from "vitest";
import { isAudience, type Audience } from "./types";

describe("audience types", () => {
  it("accepts a well-formed PERSON audience", () => {
    const a: Audience = { recordType: "PERSON", match: "ALL", conditions: [{ field: "status", op: "eq", value: "ACTIVE" }] };
    expect(isAudience(a)).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(isAudience(null)).toBe(false);
    expect(isAudience({ recordType: "PERSON" })).toBe(false);
    expect(isAudience({ recordType: "PERSON", match: "MAYBE", conditions: [] })).toBe(false);
    expect(isAudience({ recordType: "OTHER", match: "ALL", conditions: [] })).toBe(false);
  });

  it("accepts a nested group audience (Airtable-style)", () => {
    const a: Audience = {
      recordType: "PERSON",
      match: "ANY",
      conditions: [
        { field: "status", op: "eq", value: "ACTIVE" },
        {
          match: "ALL",
          children: [
            { field: "role", op: "eq", value: "VOLUNTEER" },
            { match: "ANY", children: [{ field: "licensedRN", op: "isTrue" }] },
          ],
        },
      ],
    };
    expect(isAudience(a)).toBe(true);
  });

  it("rejects a malformed nested group", () => {
    expect(isAudience({ recordType: "PERSON", match: "ALL", conditions: [{ match: "MAYBE", children: [] }] })).toBe(false);
    expect(isAudience({ recordType: "PERSON", match: "ALL", conditions: [{ match: "ALL", children: "nope" }] })).toBe(false);
    expect(isAudience({ recordType: "PERSON", match: "ALL", conditions: [{ match: "ALL", children: [{ foo: 1 }] }] })).toBe(false);
  });
});
