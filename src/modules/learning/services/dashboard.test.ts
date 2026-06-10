import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { LearningAuthError } from "./errors";
import { getCourseCompletion, resetCourseQuiz } from "./dashboard";

async function seed() {
  const term = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const viewer = await prisma.person.create({ data: { name: "Viewer", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Learning Lead", grants: { create: [{ permission: "learning.view_progress" }, { permission: "learning.manage_courses" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: viewer.id, roleId: role.id } });
  const plain = await prisma.person.create({ data: { name: "Plain", status: "ACTIVE" } });

  const a = await prisma.person.create({ data: { name: "Alice", status: "ACTIVE" } });
  const b = await prisma.person.create({ data: { name: "Bob", status: "ACTIVE" } });
  for (const p of [a, b]) {
    await prisma.termMembership.create({ data: { personId: p.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  }
  const course = await prisma.course.create({ data: { title: "Intro", isActive: true } });
  await prisma.courseDepartment.create({ data: { courseId: course.id, departmentId: dept.id } });
  await prisma.courseProgress.create({ data: { personId: a.id, courseId: course.id, status: "COMPLETE", completedAt: new Date() } });
  const quiz = await prisma.courseModule.create({ data: { courseId: course.id, position: 0, title: "Quiz", kind: "QUIZ", questions: [] as object } });
  const mp = await prisma.moduleProgress.create({ data: { personId: b.id, moduleId: quiz.id, locked: true } });
  return { viewer, plain, course, a, b, quiz, mp };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("requires view_progress", async () => {
  const { plain, course } = await seed();
  await expect(getCourseCompletion(course.id, plain.id)).rejects.toBeInstanceOf(LearningAuthError);
});

it("reports complete vs outstanding learners for a course", async () => {
  const { viewer, course, a, b } = await seed();
  const rows = await getCourseCompletion(course.id, viewer.id);
  const alice = rows.find((r) => r.personId === a.id)!;
  const bob = rows.find((r) => r.personId === b.id)!;
  expect(alice.status).toBe("COMPLETE");
  expect(bob.status).toBe("NOT_STARTED");
});

it("resets a locked quiz and opens a fresh window", async () => {
  const { viewer, b, quiz } = await seed();
  await resetCourseQuiz(b.id, quiz.id, viewer.id);
  const mp = await prisma.moduleProgress.findUniqueOrThrow({ where: { personId_moduleId: { personId: b.id, moduleId: quiz.id } } });
  expect(mp.locked).toBe(false);
  expect(mp.lockResetAt).not.toBeNull();
});

it("blocks quiz reset without manage permission", async () => {
  const { plain, b, quiz } = await seed();
  await expect(resetCourseQuiz(b.id, quiz.id, plain.id)).rejects.toBeInstanceOf(LearningAuthError);
});
