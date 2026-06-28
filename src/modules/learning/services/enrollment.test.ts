import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { LearningAuthError } from "./errors";
import { getMyCourses, getCourseForLearner, persistScoCmi, isCourseAssignedTo } from "./enrollment";

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
      scormScos: [
        { id: "ITEM-A", title: "hb", href: "index.html" },
        { id: "ITEM-B", title: "ytf", href: "html/ytf.html" },
      ],
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

it("excludes an assigned course with no uploaded SCORM package (cannot block the gate)", async () => {
  const { learner, dept } = await seed();
  // Mirrors the admin flow: create + assign a course, upload the package later.
  const packageless = await prisma.course.create({
    data: { title: "No package yet", departments: { create: [{ departmentId: dept.id }] } },
  });
  const rows = await getMyCourses(learner.id);
  expect(rows.map((r) => r.id)).not.toContain(packageless.id);
  expect(await isCourseAssignedTo(learner.id, packageless.id)).toBe(false);
});

it("getCourseForLearner refuses an unassigned course", async () => {
  const { learner, unassigned } = await seed();
  await expect(getCourseForLearner(learner.id, unassigned.id)).rejects.toBeInstanceOf(LearningAuthError);
});

it("getCourseForLearner returns every SCO with its own resume state", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "completed", scoreRaw: null, suspendData: "a=1", lessonLocation: "1",
  });
  const row = await getCourseForLearner(learner.id, course.id);
  expect(row.scos.map((s) => s.id)).toEqual(["ITEM-A", "ITEM-B"]);
  expect(row.scos[0].cmi.suspendData).toBe("a=1");
  expect(row.scos[1].cmi.lessonStatus).toBeNull();
});

it("course is IN_PROGRESS until every SCO completes, then COMPLETE", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  expect((await getCourseForLearner(learner.id, course.id)).status).toBe("IN_PROGRESS");

  await persistScoCmi(learner.id, course.id, "ITEM-B", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  expect((await getCourseForLearner(learner.id, course.id)).status).toBe("COMPLETE");
});

it("stamps course completedAt once and preserves it across later commits", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  await persistScoCmi(learner.id, course.id, "ITEM-B", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  const first = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });

  await persistScoCmi(learner.id, course.id, "ITEM-B", {
    lessonStatus: "completed", scoreRaw: 95, suspendData: "b=9", lessonLocation: "9",
  });
  const again = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });
  expect(again.completedAt?.getTime()).toBe(first.completedAt?.getTime());
});

it("rounds a fractional SCO score to fit the Int column", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "passed", scoreRaw: 83.5, suspendData: null, lessonLocation: null,
  });
  const row = await getCourseForLearner(learner.id, course.id);
  expect(row.scos[0].cmi.scoreRaw).toBe(84);
});

it("getMyCourses reports COMPLETE only after the rollup completes", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  expect((await getMyCourses(learner.id))[0].status).toBe("IN_PROGRESS");
  await persistScoCmi(learner.id, course.id, "ITEM-B", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  expect((await getMyCourses(learner.id))[0].status).toBe("COMPLETE");
});

it("supports a legacy single-SCO course (scormScos null) via sco-0", async () => {
  const { learner, dept } = await seed();
  const legacy = await prisma.course.create({
    data: {
      title: "Legacy",
      scormEntryHref: "index.html",
      scormVersion: "1.2",
      departments: { create: [{ departmentId: dept.id }] },
    },
  });
  const before = await getCourseForLearner(learner.id, legacy.id);
  expect(before.scos.map((s) => s.id)).toEqual(["sco-0"]);
  expect(before.status).toBe("NOT_STARTED");

  await persistScoCmi(learner.id, legacy.id, "sco-0", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  const after = await getCourseForLearner(learner.id, legacy.id);
  expect(after.status).toBe("COMPLETE");
});

it("rolls up the highest SCO score onto CourseProgress", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "passed", scoreRaw: 90, suspendData: null, lessonLocation: null,
  });
  await persistScoCmi(learner.id, course.id, "ITEM-B", {
    lessonStatus: "passed", scoreRaw: 80, suspendData: null, lessonLocation: null,
  });
  const cp = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });
  expect(cp.scoreRaw).toBe(90);
});

it("persistScoCmi refuses an unassigned course", async () => {
  const { learner, unassigned } = await seed();
  await expect(
    persistScoCmi(learner.id, unassigned.id, "ITEM-A", { lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null })
  ).rejects.toBeInstanceOf(LearningAuthError);
});
