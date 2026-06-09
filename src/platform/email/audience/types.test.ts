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
});
