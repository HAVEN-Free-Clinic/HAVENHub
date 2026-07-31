import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getCourseCompletion, resetCourseProgress } from "./dashboard";
import { persistScoCmi } from "./enrollment";

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

it("resetCourseProgress also clears per-SCO progress so retakes start fresh", async () => {
  const { viewer, learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "sco-0", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  expect(await prisma.scoProgress.count({ where: { personId: learner.id, courseId: course.id } })).toBe(1);

  await resetCourseProgress(learner.id, course.id, viewer.id);

  expect(await prisma.scoProgress.count({ where: { personId: learner.id, courseId: course.id } })).toBe(0);
  const rows = await getCourseCompletion(course.id, viewer.id);
  expect(rows[0].status).toBe("NOT_STARTED");
});

it("getCourseCompletion shows the score rolled up from per-SCO progress", async () => {
  const { viewer, learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "sco-0", {
    lessonStatus: "passed", scoreRaw: 88, suspendData: null, lessonLocation: null,
  });
  const rows = await getCourseCompletion(course.id, viewer.id);
  expect(rows[0]).toMatchObject({ status: "COMPLETE", scoreRaw: 88 });
});

it("getCourseCompletion returns [] for a non-existent course id (no throw)", async () => {
  const { viewer } = await seed();
  await expect(getCourseCompletion("course-that-does-not-exist", viewer.id)).resolves.toEqual([]);
});

it("scopes a PER_TERM course's roster to the active term (a prior-term completion does not count)", async () => {
  const { viewer, learner, dept } = await seed();
  const termA = await prisma.term.create({
    data: { code: "SU25", name: "Prior", status: "ARCHIVED", startDate: new Date("2025-01-01"), endDate: new Date("2025-06-30") },
  });
  const course = await prisma.course.create({
    data: { title: "Retrain", recurrence: "PER_TERM", scormEntryHref: "index.html", departments: { create: [{ departmentId: dept.id }] } },
  });
  await prisma.courseProgress.create({
    data: { personId: learner.id, courseId: course.id, termId: termA.id, status: "COMPLETE", lessonStatus: "completed", completedAt: new Date() },
  });

  const rows = await getCourseCompletion(course.id, viewer.id);
  expect(rows[0]).toMatchObject({ personId: learner.id, status: "NOT_STARTED" });

  // Sanity: the prior term's completion is untouched, just not counted for this roster.
  const priorRow = await prisma.courseProgress.findUniqueOrThrow({
    where: { personId_courseId_termId: { personId: learner.id, courseId: course.id, termId: termA.id } },
  });
  expect(priorRow.status).toBe("COMPLETE");
});

it("resetCourseProgress on a PER_TERM course clears only the active term's rows, preserving a prior term's completion", async () => {
  const { viewer, learner, dept } = await seed();
  const termA = await prisma.term.create({
    data: { code: "SU25", name: "Prior", status: "ARCHIVED", startDate: new Date("2025-01-01"), endDate: new Date("2025-06-30") },
  });
  const term = await prisma.term.findFirstOrThrow({ where: { status: "ACTIVE" } });
  const course = await prisma.course.create({
    data: { title: "Retrain", recurrence: "PER_TERM", scormEntryHref: "index.html", departments: { create: [{ departmentId: dept.id }] } },
  });
  await prisma.courseProgress.create({
    data: { personId: learner.id, courseId: course.id, termId: termA.id, status: "COMPLETE", lessonStatus: "completed", completedAt: new Date() },
  });
  await prisma.courseProgress.create({
    data: { personId: learner.id, courseId: course.id, termId: term.id, status: "COMPLETE", lessonStatus: "completed", completedAt: new Date() },
  });

  await resetCourseProgress(learner.id, course.id, viewer.id);

  const remaining = await prisma.courseProgress.findMany({ where: { personId: learner.id, courseId: course.id } });
  expect(remaining).toHaveLength(1);
  expect(remaining[0].termId).toBe(termA.id);
  expect(remaining[0].status).toBe("COMPLETE");
});

it("resetCourseProgress on a ONCE course still clears the (unscoped) row, matching today's behavior", async () => {
  // Regression bar: a ONCE course's single row can carry an older term's id (it is
  // never re-keyed), so this must NOT silently no-op once resets are term-aware.
  const { viewer, learner, course } = await seed(); // seed()'s course defaults to ONCE
  const termA = await prisma.term.create({
    data: { code: "SU25", name: "Prior", status: "ARCHIVED", startDate: new Date("2025-01-01"), endDate: new Date("2025-06-30") },
  });
  await prisma.courseProgress.create({
    data: { personId: learner.id, courseId: course.id, termId: termA.id, status: "COMPLETE", lessonStatus: "completed", completedAt: new Date() },
  });

  await resetCourseProgress(learner.id, course.id, viewer.id);

  expect(await prisma.courseProgress.count({ where: { personId: learner.id, courseId: course.id } })).toBe(0);
});

it("a DIRECTORS course lists directors of the assigned department and excludes volunteers", async () => {
  const { viewer, learner, dept } = await seed();
  const term = await prisma.term.findFirstOrThrow();
  const director = await prisma.person.create({ data: { name: "Dee", status: "ACTIVE" } });
  await prisma.termMembership.create({
    data: { personId: director.id, termId: term.id, departmentId: dept.id, status: "ACTIVE", kind: "DIRECTOR" },
  });
  const dirCourse = await prisma.course.create({
    data: { title: "Dir only", scormEntryHref: "index.html", audience: "DIRECTORS", departments: { create: [{ departmentId: dept.id }] } },
  });
  const ids = (await getCourseCompletion(dirCourse.id, viewer.id)).map((r) => r.personId);
  expect(ids).toContain(director.id);
  expect(ids).not.toContain(learner.id);
});
