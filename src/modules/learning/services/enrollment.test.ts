import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { LearningAuthError } from "./errors";
import { getMyCourses, getCourseForLearner, persistCmi, isCourseAssignedTo } from "./enrollment";

/** A learner assigned to one active, department-scoped course with a package. */
async function seed() {
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const other = await prisma.department.create({ data: { code: "MED", name: "Medical" } });
  const learner = await prisma.person.create({ data: { name: "Lee", status: "ACTIVE" } });
  const term = await prisma.term.create({
    data: { code: "SU26", name: "T1", status: "ACTIVE", startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") },
  });
  await prisma.termMembership.create({
    data: { personId: learner.id, termId: term.id, departmentId: dept.id, status: "ACTIVE", kind: "VOLUNTEER" },
  });
  const course = await prisma.course.create({
    data: {
      title: "Intro",
      description: "d",
      scormEntryHref: "index.html",
      scormVersion: "1.2",
      departments: { create: [{ departmentId: dept.id }] },
    },
  });
  const unassigned = await prisma.course.create({
    data: { title: "Other", scormEntryHref: "index.html", departments: { create: [{ departmentId: other.id }] } },
  });
  return { learner, dept, course, unassigned };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("lists assigned courses as NOT_STARTED before any progress", async () => {
  const { learner, course } = await seed();
  const rows = await getMyCourses(learner.id);
  expect(rows.map((r) => r.id)).toEqual([course.id]);
  expect(rows[0].status).toBe("NOT_STARTED");
});

it("isCourseAssignedTo reflects department assignment", async () => {
  const { learner, course, unassigned } = await seed();
  expect(await isCourseAssignedTo(learner.id, course.id)).toBe(true);
  expect(await isCourseAssignedTo(learner.id, unassigned.id)).toBe(false);
});

it("getCourseForLearner refuses an unassigned course", async () => {
  const { learner, unassigned } = await seed();
  await expect(getCourseForLearner(learner.id, unassigned.id)).rejects.toBeInstanceOf(LearningAuthError);
});

it("persistCmi records status and stamps completedAt once on completion", async () => {
  const { learner, course } = await seed();
  await persistCmi(learner.id, course.id, {
    lessonStatus: "incomplete", scoreRaw: null, suspendData: "page=1", lessonLocation: "1",
  });
  let row = await getCourseForLearner(learner.id, course.id);
  expect(row.status).toBe("IN_PROGRESS");
  expect(row.cmi.suspendData).toBe("page=1");

  await persistCmi(learner.id, course.id, {
    lessonStatus: "passed", scoreRaw: 90, suspendData: "page=9", lessonLocation: "9",
  });
  row = await getCourseForLearner(learner.id, course.id);
  expect(row.status).toBe("COMPLETE");
  expect(row.cmi.scoreRaw).toBe(90);

  const first = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });
  const firstCompletedAt = first.completedAt;

  await persistCmi(learner.id, course.id, {
    lessonStatus: "completed", scoreRaw: 95, suspendData: "page=9", lessonLocation: "9",
  });
  const again = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });
  expect(again.completedAt?.getTime()).toBe(firstCompletedAt?.getTime());
});

it("persistCmi refuses an unassigned course", async () => {
  const { learner, unassigned } = await seed();
  await expect(
    persistCmi(learner.id, unassigned.id, { lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null })
  ).rejects.toBeInstanceOf(LearningAuthError);
});
