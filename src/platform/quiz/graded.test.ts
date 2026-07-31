import { describe, expect, it } from "vitest";
import { countGradedQuestions } from "./graded";

describe("countGradedQuestions", () => {
  it("counts only questions with an answer key", () => {
    expect(countGradedQuestions([{ correctValue: "a" }, { correctValue: null }])).toBe(1);
  });
  it("is zero for an empty list and for an all-unkeyed list", () => {
    expect(countGradedQuestions([])).toBe(0);
    expect(countGradedQuestions([{ correctValue: null }, { correctValue: null }])).toBe(0);
  });
});
