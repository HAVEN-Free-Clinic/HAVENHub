import { describe, it, expect } from "vitest";
import { sectionStates, videoCourseReady, attemptsInWindow } from "./video-course";

const s = (id: string) => ({ id });

describe("sectionStates", () => {
  it("opens only the first section for a new learner", () => {
    const out = sectionStates([s("a"), s("b")], new Map());
    expect(out).toEqual([
      { id: "a", unlocked: true, watched: false, passed: false, quizOpen: false },
      { id: "b", unlocked: false, watched: false, passed: false, quizOpen: false },
    ]);
  });

  it("opens the quiz once the section is watched", () => {
    const out = sectionStates([s("a"), s("b")], new Map([["a", { watchedAt: new Date(), passedAt: null }]]));
    expect(out[0]).toMatchObject({ unlocked: true, watched: true, passed: false, quizOpen: true });
    expect(out[1].unlocked).toBe(false);
  });

  it("opens the next section only after the previous quiz is passed", () => {
    const now = new Date();
    const out = sectionStates([s("a"), s("b"), s("c")], new Map([["a", { watchedAt: now, passedAt: now }]]));
    expect(out.map((x) => x.unlocked)).toEqual([true, true, false]);
    expect(out[0].quizOpen).toBe(false);
  });

  it("keeps a later section locked even if it somehow has progress, until the earlier one passes", () => {
    const now = new Date();
    const out = sectionStates([s("a"), s("b")], new Map([["b", { watchedAt: now, passedAt: now }]]));
    expect(out[1]).toMatchObject({ unlocked: false, quizOpen: false });
  });
});

describe("videoCourseReady", () => {
  const good = { hasVideo: true, length: 600, gradedQuestionCount: 3 };
  it("needs at least one section", () => {
    expect(videoCourseReady([])).toBe(false);
  });
  it("is ready when every section has a video, a length, and a keyed question", () => {
    expect(videoCourseReady([good, good])).toBe(true);
  });
  it("is not ready when any section lacks a video, a length, or a keyed question", () => {
    expect(videoCourseReady([good, { ...good, hasVideo: false }])).toBe(false);
    expect(videoCourseReady([good, { ...good, length: null }])).toBe(false);
    expect(videoCourseReady([good, { ...good, gradedQuestionCount: 0 }])).toBe(false);
  });
});

describe("attemptsInWindow", () => {
  const reset = new Date("2026-09-20T12:00:00Z");
  const before = new Date("2026-09-20T11:00:00Z");
  const afterReset = new Date("2026-09-20T13:00:00Z");
  it("counts every attempt when there has been no reset", () => {
    expect(attemptsInWindow([{ takenAt: before }, { takenAt: afterReset }], null)).toBe(2);
  });
  it("counts only attempts at or after the reset", () => {
    expect(attemptsInWindow([{ takenAt: before }, { takenAt: reset }, { takenAt: afterReset }], reset)).toBe(2);
  });
});
