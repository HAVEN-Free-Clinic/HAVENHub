import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { LearningAuthError, LearningValidationError } from "./errors";
import { getMyCourses, getCourseForLearner, markModuleComplete, submitCourseQuiz } from "./enrollment";
import type { QuizQuestion } from "./types";

const QUESTIONS: QuizQuestion[] = [
  { key: "q1", label: "2+2?", options: [{ value: "4", label: "4" }, { value: "5", label: "5" }], correctValue: "4" },
];

async function seed() {
  const term = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const other = await prisma.department.create({ data: { code: "PHARM", name: "Pharmacy" } });
  const person = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });

  const course = await prisma.course.create({ data: { title: "Intro", isActive: true } });
  await prisma.courseDepartment.create({ data: { courseId: course.id, departmentId: dept.id } });
  const video = await prisma.courseModule.create({ data: { courseId: course.id, position: 0, title: "Watch", kind: "VIDEO", url: "https://v" } });
  const quiz = await prisma.courseModule.create({ data: { courseId: course.id, position: 1, title: "Quiz", kind: "QUIZ", questions: QUESTIONS as object, passPercent: 100, maxAttempts: 2 } });

  // A course assigned to a department the person is NOT in.
  const hidden = await prisma.course.create({ data: { title: "Hidden", isActive: true } });
  await prisma.courseDepartment.create({ data: { courseId: hidden.id, departmentId: other.id } });

  return { person, course, video, quiz, hidden };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("lists only assigned courses with progress counts", async () => {
  const { person, course, hidden } = await seed();
  const mine = await getMyCourses(person.id);
  const ids = mine.map((c) => c.id);
  expect(ids).toContain(course.id);
  expect(ids).not.toContain(hidden.id);
  const intro = mine.find((c) => c.id === course.id)!;
  expect(intro).toMatchObject({ done: 0, total: 2, status: "IN_PROGRESS" });
});

it("blocks reading a course that is not assigned to the learner", async () => {
  const { person, hidden } = await seed();
  await expect(getCourseForLearner(person.id, hidden.id)).rejects.toBeInstanceOf(LearningAuthError);
});

it("marks a video module complete", async () => {
  const { person, video } = await seed();
  await markModuleComplete(person.id, video.id);
  const detail = await getCourseForLearner(person.id, (await prisma.courseModule.findUniqueOrThrow({ where: { id: video.id } })).courseId);
  expect(detail.modules.find((m) => m.id === video.id)!.completed).toBe(true);
});

it("refuses to mark a quiz module complete via markModuleComplete", async () => {
  const { person, quiz } = await seed();
  await expect(markModuleComplete(person.id, quiz.id)).rejects.toBeInstanceOf(LearningValidationError);
});

it("passing the quiz after completing the video completes the course", async () => {
  const { person, course, video, quiz } = await seed();
  await markModuleComplete(person.id, video.id);
  const res = await submitCourseQuiz(person.id, quiz.id, { q1: "4" });
  expect(res.passed).toBe(true);
  const progress = await prisma.courseProgress.findUniqueOrThrow({ where: { personId_courseId: { personId: person.id, courseId: course.id } } });
  expect(progress.status).toBe("COMPLETE");
});

it("locks the quiz after the attempt cap without a pass", async () => {
  const { person, quiz } = await seed();
  await submitCourseQuiz(person.id, quiz.id, { q1: "5" }); // attempt 1 (cap 2)
  await submitCourseQuiz(person.id, quiz.id, { q1: "5" }); // attempt 2 -> lock
  const mp = await prisma.moduleProgress.findUniqueOrThrow({ where: { personId_moduleId: { personId: person.id, moduleId: quiz.id } } });
  expect(mp.locked).toBe(true);
  await expect(submitCourseQuiz(person.id, quiz.id, { q1: "4" })).rejects.toBeInstanceOf(LearningValidationError);
});

it("completedAt is preserved when course is re-marked after completion", async () => {
  const { person, course, video, quiz } = await seed();
  await markModuleComplete(person.id, video.id);
  await submitCourseQuiz(person.id, quiz.id, { q1: "4" }); // course becomes COMPLETE
  const first = await prisma.courseProgress.findUniqueOrThrow({
    where: { personId_courseId: { personId: person.id, courseId: course.id } },
    select: { completedAt: true },
  });
  expect(first.completedAt).not.toBeNull();
  // Small pause so that a re-stamp would produce a measurably different timestamp.
  await new Promise((r) => setTimeout(r, 5));
  await markModuleComplete(person.id, video.id); // re-mark — recompute runs again
  const second = await prisma.courseProgress.findUniqueOrThrow({
    where: { personId_courseId: { personId: person.id, courseId: course.id } },
    select: { completedAt: true },
  });
  expect(second.completedAt).toEqual(first.completedAt); // original timestamp must be unchanged
});

it("submitting an already-passed quiz throws LearningValidationError", async () => {
  const { person, video, quiz } = await seed();
  await markModuleComplete(person.id, video.id);
  await submitCourseQuiz(person.id, quiz.id, { q1: "4" }); // pass once
  await expect(submitCourseQuiz(person.id, quiz.id, { q1: "4" })).rejects.toBeInstanceOf(LearningValidationError);
});
