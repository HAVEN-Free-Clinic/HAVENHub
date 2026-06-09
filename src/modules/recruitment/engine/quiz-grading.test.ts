import { describe, expect, it } from "vitest";
import { gradeQuiz, type GradedQuestion } from "./quiz-grading";

const q = (key: string, correctValue: string | null): GradedQuestion => ({ key, correctValue });

describe("gradeQuiz", () => {
  it("scores only graded questions and computes percent", () => {
    const questions = [q("a", "x"), q("b", "y"), q("c", null)]; // c is non-graded
    const r = gradeQuiz(questions, { a: "x", b: "z", c: "anything" }, 50);
    expect(r.score).toBe(1);
    expect(r.total).toBe(2);
    expect(r.percent).toBe(50);
    expect(r.passed).toBe(true); // 50 >= 50
  });

  it("passes at exactly the threshold and fails below it", () => {
    const questions = [q("a", "x"), q("b", "y"), q("c", "z"), q("d", "w")];
    const answers = { a: "x", b: "y", c: "z", d: "WRONG" }; // 3/4 = 75
    expect(gradeQuiz(questions, answers, 75).passed).toBe(true);
    expect(gradeQuiz(questions, answers, 76).passed).toBe(false);
  });

  it("treats missing answers as wrong", () => {
    const r = gradeQuiz([q("a", "x"), q("b", "y")], { a: "x" }, 80);
    expect(r.score).toBe(1);
    expect(r.total).toBe(2);
    expect(r.percent).toBe(50);
    expect(r.passed).toBe(false);
  });

  it("never passes a quiz with no graded questions", () => {
    const r = gradeQuiz([q("a", null)], { a: "x" }, 0);
    expect(r.total).toBe(0);
    expect(r.percent).toBe(0);
    expect(r.passed).toBe(false);
  });
});
