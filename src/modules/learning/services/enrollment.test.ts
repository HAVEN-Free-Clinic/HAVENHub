import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { LearningAuthError, LearningValidationError } from "./errors";
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

/**
 * A learner with a completed course in a PRIOR term (termA), now assigned in a NEW
 * active term (termB). Used to test that per-term recurrence actually reopens a
 * course rather than latching onto the prior term's rows forever.
 */
async function seedAcrossTerms(recurrence: "ONCE" | "PER_TERM") {
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const learner = await prisma.person.create({ data: { name: "Lee", status: "ACTIVE" } });
  const termA = await prisma.term.create({
    data: { code: "SU25", name: "Prior", status: "ARCHIVED", startDate: new Date("2025-01-01"), endDate: new Date("2025-06-30") },
  });
  const termB = await prisma.term.create({
    data: { code: "SU26", name: "Current", status: "ACTIVE", startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") },
  });
  await prisma.termMembership.create({
    data: { personId: learner.id, termId: termB.id, departmentId: dept.id, status: "ACTIVE", kind: "VOLUNTEER" },
  });
  const course = await prisma.course.create({
    data: {
      title: "Intro",
      description: "d",
      scormEntryHref: "index.html",
      scormVersion: "1.2",
      recurrence,
      scormScos: [
        { id: "ITEM-A", title: "hb", href: "index.html" },
        { id: "ITEM-B", title: "ytf", href: "html/ytf.html" },
      ],
      departments: { create: [{ departmentId: dept.id }] },
    },
  });
  return { learner, dept, course, termA, termB };
}

/** Directly seeds a fully-completed CourseProgress + ScoProgress record for a term,
 *  bypassing persistScoCmi, to simulate "this course was already finished back then." */
async function seedPriorTermCompletion(personId: string, courseId: string, termId: string) {
  const completedAt = new Date("2025-03-01");
  await prisma.scoProgress.create({
    data: { personId, courseId, scoId: "ITEM-A", termId, lessonStatus: "completed", completedAt },
  });
  await prisma.scoProgress.create({
    data: { personId, courseId, scoId: "ITEM-B", termId, lessonStatus: "completed", completedAt },
  });
  await prisma.courseProgress.create({
    data: { personId, courseId, termId, status: "COMPLETE", lessonStatus: "completed", completedAt },
  });
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

it("latches completion: a SCO reverting to incomplete on review does not downgrade COMPLETE (audit #12)", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  await persistScoCmi(learner.id, course.id, "ITEM-B", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  const done = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });
  expect(done.status).toBe("COMPLETE");

  // The learner re-opens the finished course to review; the SCO now reports
  // "incomplete" (or the 30s autocommit fires mid-review).
  await persistScoCmi(learner.id, course.id, "ITEM-B", {
    lessonStatus: "incomplete", scoreRaw: null, suspendData: "b=review", lessonLocation: "2",
  });

  const after = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });
  expect(after.status).toBe("COMPLETE");
  expect(after.completedAt?.getTime()).toBe(done.completedAt?.getTime());
});

it("preserves a saved SCO score/suspend/location when a later commit omits them (#19)", async () => {
  const { learner, course } = await seed();
  // The learner passes the quiz SCO, persisting a score and resume state.
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "passed", scoreRaw: 90, suspendData: "q=done", lessonLocation: "3",
  });
  // They revisit the SCO; its SCORM API is re-seeded blank from the stale server
  // snapshot, so on leave LMSFinish fires a commit with null score/suspend/location.
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "incomplete", scoreRaw: null, suspendData: null, lessonLocation: null,
  });

  const row = await getCourseForLearner(learner.id, course.id);
  const itemA = row.scos.find((s) => s.id === "ITEM-A")!;
  expect(itemA.cmi.scoreRaw).toBe(90); // score not wiped by the absent-value commit
  expect(itemA.cmi.suspendData).toBe("q=done"); // resume state preserved
  expect(itemA.cmi.lessonLocation).toBe("3");
  // The course rollup (the score a director sees on /learning/dashboard) keeps the 90.
  const cp = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });
  expect(cp.scoreRaw).toBe(90);
});

it("rounds a fractional SCO score to fit the Int column", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "passed", scoreRaw: 83.5, suspendData: null, lessonLocation: null,
  });
  const row = await getCourseForLearner(learner.id, course.id);
  expect(row.scos[0].cmi.scoreRaw).toBe(84);
});

it("clamps an out-of-range SCO score so the int4 column never overflows", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "passed", scoreRaw: 2147483648, suspendData: null, lessonLocation: null,
  });
  const row = await getCourseForLearner(learner.id, course.id);
  expect(row.scos[0].cmi.scoreRaw).toBe(100);
  const cp = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });
  expect(cp.scoreRaw).toBe(100);
});

it("stores a non-finite SCO score as null instead of throwing", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "passed", scoreRaw: NaN, suspendData: null, lessonLocation: null,
  });
  const row = await getCourseForLearner(learner.id, course.id);
  expect(row.scos[0].cmi.scoreRaw).toBeNull();
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

it("persistScoCmi rejects a scoId that is not in the course manifest (no orphan row written)", async () => {
  const { learner, course } = await seed();
  await expect(
    persistScoCmi(learner.id, course.id, "NOT-A-REAL-SCO", { lessonStatus: "completed", scoreRaw: null, suspendData: "x".repeat(70000), lessonLocation: null })
  ).rejects.toBeInstanceOf(LearningValidationError);
  const rows = await prisma.scoProgress.findMany({ where: { personId: learner.id, courseId: course.id } });
  expect(rows).toHaveLength(0);
});

it("caps oversized suspendData and lessonLocation before persisting", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "completed", scoreRaw: null, suspendData: "x".repeat(70000), lessonLocation: "y".repeat(2000),
  });
  const row = await getCourseForLearner(learner.id, course.id);
  expect(row.scos[0].cmi.suspendData?.length).toBe(64000);
  expect(row.scos[0].cmi.lessonLocation?.length).toBe(1000);
});

it("leaves a normal-sized suspendData untouched", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "completed", scoreRaw: null, suspendData: "a=1;b=2", lessonLocation: "page-3",
  });
  const row = await getCourseForLearner(learner.id, course.id);
  expect(row.scos[0].cmi.suspendData).toBe("a=1;b=2");
  expect(row.scos[0].cmi.lessonLocation).toBe("page-3");
});

it("excludes a DIRECTORS course from a volunteer's assigned courses", async () => {
  const { learner, dept } = await seed();
  const dirCourse = await prisma.course.create({
    data: { title: "Dir only", scormEntryHref: "index.html", audience: "DIRECTORS", departments: { create: [{ departmentId: dept.id }] } },
  });
  const ids = (await getMyCourses(learner.id)).map((r) => r.id);
  expect(ids).not.toContain(dirCourse.id);
});

it("includes a DIRECTORS course for a director in the department, alongside EVERYONE courses", async () => {
  const { dept, course } = await seed();
  const term = await prisma.term.findFirstOrThrow();
  const director = await prisma.person.create({ data: { name: "Dee", status: "ACTIVE" } });
  await prisma.termMembership.create({
    data: { personId: director.id, termId: term.id, departmentId: dept.id, status: "ACTIVE", kind: "DIRECTOR" },
  });
  const dirCourse = await prisma.course.create({
    data: { title: "Dir only", scormEntryHref: "index.html", audience: "DIRECTORS", departments: { create: [{ departmentId: dept.id }] } },
  });
  const ids = (await getMyCourses(director.id)).map((r) => r.id);
  expect(ids).toContain(dirCourse.id);
  expect(ids).toContain(course.id);
});

// --- Per-term recurrence: the write path (Task 2) ---
//
// These assert against CourseProgress/ScoProgress directly, scoped by termId,
// rather than through getMyCourses or getCourseForLearner, so they check exactly
// what persistScoCmi actually wrote, independent of the readers. getMyCourses and
// getCourseForLearner are now recurrence-aware too (Task 3, see the reader tests
// further below), but these write-path tests are left querying the tables directly
// on purpose: they must not be "fixed" by loosening them to go through a reader.

it("a PER_TERM course whose ScoProgress rows are all complete from a prior term does not auto-complete in the new term", async () => {
  const { learner, course, termA, termB } = await seedAcrossTerms("PER_TERM");
  await seedPriorTermCompletion(learner.id, course.id, termA.id);

  // The learner starts the course over this term and finishes only the first SCO.
  // If the rollup here pulled in the prior term's stale "completed" ITEM-B row (the
  // ScoProgress trap), this would wrongly roll up COMPLETE on the very first commit.
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });

  const thisTerm = await prisma.courseProgress.findUnique({
    where: { personId_courseId_termId: { personId: learner.id, courseId: course.id, termId: termB.id } },
  });
  expect(thisTerm?.status).toBe("IN_PROGRESS");
  expect(thisTerm?.completedAt).toBeNull();

  // The prior term's completed record is untouched, not overwritten or deleted.
  const priorTerm = await prisma.courseProgress.findUniqueOrThrow({
    where: { personId_courseId_termId: { personId: learner.id, courseId: course.id, termId: termA.id } },
  });
  expect(priorTerm.status).toBe("COMPLETE");
});

it("a PER_TERM course completed in a prior term reads NOT COMPLETE in the new term", async () => {
  const { learner, course, termA, termB } = await seedAcrossTerms("PER_TERM");
  await seedPriorTermCompletion(learner.id, course.id, termA.id);

  // Nothing has been committed yet this term: there is no row scoped to termB at all,
  // so this term's status is NOT_STARTED/NOT COMPLETE, regardless of the prior term's
  // COMPLETE record.
  const thisTerm = await prisma.courseProgress.findUnique({
    where: { personId_courseId_termId: { personId: learner.id, courseId: course.id, termId: termB.id } },
  });
  expect(thisTerm).toBeNull();
});

it("a ONCE course completed in a prior term still reads COMPLETE (today's behavior)", async () => {
  const { learner, course, termA } = await seedAcrossTerms("ONCE");
  await seedPriorTermCompletion(learner.id, course.id, termA.id);

  // getCourseForLearner's rollup lookup is a single unscoped row match today (see its
  // comment); with exactly one CourseProgress row in existence (ONCE never creates a
  // second), it deterministically finds the prior term's COMPLETE record.
  const row = await getCourseForLearner(learner.id, course.id);
  expect(row.status).toBe("COMPLETE");
});

it("a ONCE course's later-term commit reuses the original row instead of fragmenting across terms", async () => {
  const { learner, course, termA } = await seedAcrossTerms("ONCE");
  await seedPriorTermCompletion(learner.id, course.id, termA.id);

  // The 30s autocommit (or a stray re-open) fires again next term. Because the
  // course is ONCE, the write path must keep updating the SAME row it already has,
  // not start a second one keyed to the new active term.
  await persistScoCmi(learner.id, course.id, "ITEM-B", {
    lessonStatus: "completed", scoreRaw: 88, suspendData: null, lessonLocation: null,
  });

  const rows = await prisma.courseProgress.findMany({ where: { personId: learner.id, courseId: course.id } });
  expect(rows).toHaveLength(1);
  expect(rows[0].termId).toBe(termA.id);
  expect(rows[0].status).toBe("COMPLETE");
});

it("committing an attempt writes rows carrying the current term", async () => {
  const { learner, course } = await seed();
  const term = await prisma.term.findFirstOrThrow();

  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });

  const cp = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });
  expect(cp.termId).toBe(term.id);
  const sp = await prisma.scoProgress.findFirstOrThrow({
    where: { personId: learner.id, courseId: course.id, scoId: "ITEM-A" },
  });
  expect(sp.termId).toBe(term.id);
});

// --- Per-term recurrence: the readers (Task 3) ---
//
// Unlike the write-path tests above, these go THROUGH getMyCourses/getCourseForLearner,
// because the point of this task is that the readers themselves now apply the
// PER_TERM-scoped / ONCE-unscoped rule, not just the tables underneath them.

it("getMyCourses reads NOT_STARTED for a PER_TERM course completed only in a prior term", async () => {
  const { learner, course, termA } = await seedAcrossTerms("PER_TERM");
  await seedPriorTermCompletion(learner.id, course.id, termA.id);

  const rows = await getMyCourses(learner.id);
  expect(rows.find((r) => r.id === course.id)?.status).toBe("NOT_STARTED");
});

it("getMyCourses still reads COMPLETE for a ONCE course completed in a prior term (regression bar)", async () => {
  const { learner, course, termA } = await seedAcrossTerms("ONCE");
  await seedPriorTermCompletion(learner.id, course.id, termA.id);

  const rows = await getMyCourses(learner.id);
  expect(rows.find((r) => r.id === course.id)?.status).toBe("COMPLETE");
});

it("getCourseForLearner's rollup reads NOT_STARTED for a PER_TERM course completed only in a prior term", async () => {
  const { learner, course, termA } = await seedAcrossTerms("PER_TERM");
  await seedPriorTermCompletion(learner.id, course.id, termA.id);

  const row = await getCourseForLearner(learner.id, course.id);
  expect(row.status).toBe("NOT_STARTED");
});

it("getCourseForLearner does not resurface a prior term's completed SCO cmi for a reopened PER_TERM course", async () => {
  const { learner, course, termA } = await seedAcrossTerms("PER_TERM");
  await seedPriorTermCompletion(learner.id, course.id, termA.id);

  // If this leaked the prior term's ScoProgress rows, the player would seed its
  // SCORM API as already "completed" the instant it mounts, showing the completion
  // banner and re-latching on the next autocommit before the learner does anything.
  const row = await getCourseForLearner(learner.id, course.id);
  for (const sco of row.scos) {
    expect(sco.cmi.lessonStatus).toBeNull();
    expect(sco.cmi.suspendData).toBeNull();
  }
});

// --- A next (PLANNING) term: what is even satisfiable there (audit 14, L1) ---
//
// The read side takes a termId so a member's next-term checklist and the schedule
// builder's banner agree. The write side does not, and cannot: a SCORM commit is a
// bare CMI snapshot with no term in it, so persistScoCmi always records against the
// ACTIVE term. A PER_TERM course therefore has no way to ever be completed FOR a
// next term, and listing it there asserted an outstanding item nobody could clear.

/** A learner who belongs to both the ACTIVE term and a future PLANNING term. */
async function seedNextTerm(recurrence: "ONCE" | "PER_TERM") {
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const learner = await prisma.person.create({ data: { name: "Lee", status: "ACTIVE" } });
  const active = await prisma.term.create({
    data: { code: "SU26", name: "Current", status: "ACTIVE", startDate: new Date("2026-01-01"), endDate: new Date("2026-06-30") },
  });
  const next = await prisma.term.create({
    data: { code: "FA26", name: "Next", status: "PLANNING", startDate: new Date("2026-09-01"), endDate: new Date("2026-12-31") },
  });
  for (const termId of [active.id, next.id]) {
    await prisma.termMembership.create({
      data: { personId: learner.id, termId, departmentId: dept.id, status: "ACTIVE", kind: "VOLUNTEER" },
    });
  }
  const course = await prisma.course.create({
    data: {
      title: "Intro",
      scormEntryHref: "index.html",
      scormVersion: "1.2",
      recurrence,
      scormScos: [{ id: "ITEM-A", title: "hb", href: "index.html" }],
      departments: { create: [{ departmentId: dept.id }] },
    },
  });
  return { learner, course, active, next };
}

it("getMyCourses omits a PER_TERM course for a next term, which no commit could ever complete", async () => {
  const { learner, course, active, next } = await seedNextTerm("PER_TERM");

  // Finish it for the term the learner is actually in. That is the ONLY term a
  // SCORM commit can land in, so it is the best any member can possibly do.
  await persistScoCmi(learner.id, course.id, "ITEM-A", { lessonStatus: "completed", scoreRaw: 90, suspendData: null, lessonLocation: null });
  expect((await getMyCourses(learner.id, active.id)).find((r) => r.id === course.id)?.status).toBe("COMPLETE");

  // Before the fix this row came back NOT_STARTED for the next term, permanently:
  // read at termId = next, written at termId = active.
  expect((await getMyCourses(learner.id, next.id)).find((r) => r.id === course.id)).toBeUndefined();
});

it("getMyCourses still lists a ONCE course for a next term, where a completion does carry over", async () => {
  const { learner, course, next } = await seedNextTerm("ONCE");
  const rows = await getMyCourses(learner.id, next.id);
  expect(rows.find((r) => r.id === course.id)?.status).toBe("NOT_STARTED");
});
