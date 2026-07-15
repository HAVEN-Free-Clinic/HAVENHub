import { describe, it, expect } from "vitest";
import { parseFieldCondition, isFieldVisible, mergeDepartmentAnswer } from "./field-visibility";

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

describe("isFieldVisible", () => {
  const cond = (op: string, value?: unknown) => ({ field: "q", op, value });
  it("no condition -> visible", () => {
    expect(isFieldVisible(null, {})).toBe(true);
    expect(isFieldVisible(undefined, { q: "x" })).toBe(true);
  });
  it("is: matches single and array answers", () => {
    expect(isFieldVisible(cond("is", "yes"), { q: "yes" })).toBe(true);
    expect(isFieldVisible(cond("is", "yes"), { q: "no" })).toBe(false);
    expect(isFieldVisible(cond("is", "a"), { q: ["a", "b"] })).toBe(true);
    expect(isFieldVisible(cond("is", "z"), { q: ["a", "b"] })).toBe(false);
    expect(isFieldVisible(cond("is", "yes"), {})).toBe(false); // unanswered
  });
  it("isNot: negation", () => {
    expect(isFieldVisible(cond("isNot", "no"), { q: "yes" })).toBe(true);
    expect(isFieldVisible(cond("isNot", "no"), { q: "no" })).toBe(false);
  });
  it("isAnyOf: membership / intersection", () => {
    expect(isFieldVisible(cond("isAnyOf", ["a", "b"]), { q: "b" })).toBe(true);
    expect(isFieldVisible(cond("isAnyOf", ["a", "b"]), { q: "c" })).toBe(false);
    expect(isFieldVisible(cond("isAnyOf", ["a", "b"]), { q: ["c", "a"] })).toBe(true);
  });
  it("isAnswered: any non-empty answer", () => {
    expect(isFieldVisible(cond("isAnswered"), { q: "x" })).toBe(true);
    expect(isFieldVisible(cond("isAnswered"), { q: [] })).toBe(false);
    expect(isFieldVisible(cond("isAnswered"), { q: "" })).toBe(false);
    expect(isFieldVisible(cond("isAnswered"), {})).toBe(false);
  });
  it("malformed condition -> visible (fail open)", () => {
    expect(isFieldVisible({ nonsense: true }, {})).toBe(true);
  });
});

describe("mergeDepartmentAnswer", () => {
  it("overrides a stale department answer with the authoritative selection", () => {
    expect(mergeDepartmentAnswer({ dept: "OLD", other: "x" }, "dept", ["NEW"]))
      .toEqual({ dept: ["NEW"], other: "x" });
  });
  it("adds the department key even when answers has no prior entry for it", () => {
    // Covers navigation paths that never write to `answers` directly: an
    // applicantType switch (chooseType) or a single-department RENEWAL's
    // read-only field (no onChange at all).
    expect(mergeDepartmentAnswer({}, "dept", ["NEW"])).toEqual({ dept: ["NEW"] });
  });
  it("clears to an empty selection when the applicant has no department chosen", () => {
    expect(mergeDepartmentAnswer({ dept: "OLD" }, "dept", [])).toEqual({ dept: [] });
  });
  it("is a no-op passthrough when there is no department-choice field in the form", () => {
    expect(mergeDepartmentAnswer({ a: "b" }, undefined, ["NEW"])).toEqual({ a: "b" });
  });
  it("does not mutate the input answers object", () => {
    const answers = { dept: "OLD" };
    mergeDepartmentAnswer(answers, "dept", ["NEW"]);
    expect(answers).toEqual({ dept: "OLD" });
  });
});
