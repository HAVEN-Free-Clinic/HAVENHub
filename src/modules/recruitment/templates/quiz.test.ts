import { describe, it, expect } from "vitest";
import { getQuizTemplate } from "./quiz";

describe("getQuizTemplate", () => {
  it("returns QUIZ-purpose single-select questions with options and no answer key", () => {
    const sections = getQuizTemplate("VOLUNTEER");
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((s) => s.purpose === "QUIZ")).toBe(true);
    const fields = sections.flatMap((s) => s.fields);
    expect(fields.length).toBeGreaterThanOrEqual(1);
    expect(fields.every((f) => f.type === "SINGLE_SELECT")).toBe(true);
    expect(fields.every((f) => (f.options ?? []).length >= 2)).toBe(true);
    expect(fields.every((f) => f.correctValue === undefined)).toBe(true);
  });
});
