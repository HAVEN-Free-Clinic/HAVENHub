import { expect, it } from "vitest";
import { isCourseComplete, progressCounts, type ModuleState } from "./completion";

const done = (kind: ModuleState["kind"]): ModuleState =>
  kind === "QUIZ" ? { kind, completed: false, quizPassed: true } : { kind, completed: true, quizPassed: false };
const notDone = (kind: ModuleState["kind"]): ModuleState => ({ kind, completed: false, quizPassed: false });

it("a video/document module is done when completed", () => {
  expect(isCourseComplete([done("VIDEO"), done("DOCUMENT")])).toBe(true);
});

it("a quiz module is done only when passed (completed flag is ignored for quizzes)", () => {
  expect(isCourseComplete([{ kind: "QUIZ", completed: true, quizPassed: false }])).toBe(false);
  expect(isCourseComplete([{ kind: "QUIZ", completed: false, quizPassed: true }])).toBe(true);
});

it("course is incomplete if any module is not done", () => {
  expect(isCourseComplete([done("VIDEO"), notDone("QUIZ")])).toBe(false);
});

it("an empty course is not complete", () => {
  expect(isCourseComplete([])).toBe(false);
});

it("progressCounts reports done / total", () => {
  expect(progressCounts([done("VIDEO"), notDone("DOCUMENT"), done("QUIZ")])).toEqual({ done: 2, total: 3 });
});
