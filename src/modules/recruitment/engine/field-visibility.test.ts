import { describe, it, expect } from "vitest";
import { parseFieldCondition } from "./field-visibility";

describe("parseFieldCondition", () => {
  it("parses a valid is-condition", () => {
    expect(parseFieldCondition({ field: "other_languages", op: "is", value: "yes" }))
      .toEqual({ field: "other_languages", op: "is", value: "yes" });
  });
  it("parses isAnswered without a value", () => {
    expect(parseFieldCondition({ field: "x", op: "isAnswered" }))
      .toEqual({ field: "x", op: "isAnswered" });
  });
  it("parses isAnyOf with an array value", () => {
    expect(parseFieldCondition({ field: "a", op: "isAnyOf", value: ["other_yale", "staff"] }))
      .toEqual({ field: "a", op: "isAnyOf", value: ["other_yale", "staff"] });
  });
  it("returns null for null / malformed / unknown op / missing value", () => {
    expect(parseFieldCondition(null)).toBeNull();
    expect(parseFieldCondition({})).toBeNull();
    expect(parseFieldCondition({ field: "a", op: "bogus", value: "x" })).toBeNull();
    expect(parseFieldCondition({ field: "a", op: "is" })).toBeNull(); // is needs a value
  });
});
