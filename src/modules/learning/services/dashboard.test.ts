import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getCourseCompletion, resetCourseProgress } from "./dashboard";

async function seed() {
  const viewer = await prisma.person.create({ data: { name: "Viewer", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: {
      name: "Learning Viewer",
      grants: { create: [{ permission: "learning.view_progress" }, { permission: "learning.manage_courses" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { personId: viewer.id, roleId: role.id } });

  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const learner = await prisma.person.create({ data: { name: "Lee", status: "ACTIVE" } });
  const term = await prisma.term.create({
    data: { code: "SU26", name: "T1", status: "ACTIVE", startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") },
  });
  await prisma.termMembership.create({
    data: { personId: learner.id, termId: term.id, departmentId: dept.id, status: "ACTIVE", kind: "VOLUNTEER" },
  });
  const course = await prisma.course.create({
    data: { title: "Intro", scormEntryHref: "index.html", departments: { create: [{ departmentId: dept.id }] } },
  });
  return { viewer, learner, dept, course };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("lists assigned members as NOT_STARTED with no progress", async () => {
  const { viewer, learner, course } = await seed();
  const rows = await getCourseCompletion(course.id, viewer.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ personId: learner.id, status: "NOT_STARTED", scoreRaw: null });
});

it("derives COMPLETE + score from a passed CourseProgress", async () => {
  const { viewer, learner, course } = await seed();
  await prisma.courseProgress.create({
    data: { personId: learner.id, courseId: course.id, status: "COMPLETE", lessonStatus: "passed", scoreRaw: 88, completedAt: new Date() },
  });
  const rows = await getCourseCompletion(course.id, viewer.id);
  expect(rows[0]).toMatchObject({ status: "COMPLETE", scoreRaw: 88 });
  expect(rows[0].completedAt).not.toBeNull();
});

it("resetCourseProgress clears a learner's row", async () => {
  const { viewer, learner, course } = await seed();
  await prisma.courseProgress.create({
    data: { personId: learner.id, courseId: course.id, status: "COMPLETE", lessonStatus: "passed", completedAt: new Date() },
  });
  await resetCourseProgress(learner.id, course.id, viewer.id);
  const rows = await getCourseCompletion(course.id, viewer.id);
  expect(rows[0].status).toBe("NOT_STARTED");
});
