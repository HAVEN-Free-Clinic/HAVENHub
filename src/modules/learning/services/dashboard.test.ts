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

  // Alice genuinely completes the quiz module (Fix 3 correctness: give her a passing attempt so
  // live derivation agrees with the COMPLETE status). The previous seed only wrote a CourseProgress
  // row without any ModuleProgress/passing attempt, so live rules would derive NOT_STARTED — wrong.
  const quiz = await prisma.courseModule.create({ data: { courseId: course.id, position: 0, title: "Quiz", kind: "QUIZ", questions: [] as object } });
  const aliceModProgress = await prisma.moduleProgress.create({ data: { personId: a.id, moduleId: quiz.id, completedAt: new Date() } });
  await prisma.courseQuizAttempt.create({ data: { moduleProgressId: aliceModProgress.id, answers: {}, score: 10, total: 10, passed: true } });
  await prisma.courseProgress.create({ data: { personId: a.id, courseId: course.id, status: "COMPLETE", completedAt: new Date() } });

  // Bob has a locked quiz module and partial module progress (IN_PROGRESS)
  const mp = await prisma.moduleProgress.create({ data: { personId: b.id, moduleId: quiz.id, locked: true } });
  return { viewer, plain, course, a, b, quiz, mp };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("requires view_progress", async () => {
  const { plain, course } = await seed();
  await expect(getCourseCompletion(course.id, plain.id)).rejects.toBeInstanceOf(LearningAuthError);
});

// Fix 3: live derivation — Alice passes the quiz so she is genuinely COMPLETE (not just persisted);
// Bob has a locked ModuleProgress row (no completedAt, no passing attempt). Under the old rule
// (completed || quizPassed) he was NOT_STARTED, but a locked row proves real engagement, so the
// corrected rule (any ModuleProgress row => IN_PROGRESS) makes him IN_PROGRESS.
it("reports complete vs outstanding learners for a course (live derivation)", async () => {
  const { viewer, course, a, b } = await seed();
  const rows = await getCourseCompletion(course.id, viewer.id);
  const alice = rows.find((r) => r.personId === a.id)!;
  const bob = rows.find((r) => r.personId === b.id)!;
  expect(alice.status).toBe("COMPLETE");
  // Bob has a locked ModuleProgress row — he has engaged with the course, so he is IN_PROGRESS
  // (changed from NOT_STARTED: a locked learner has clearly started, "not started" + "locked" is contradictory).
  expect(bob.status).toBe("IN_PROGRESS");
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

// Fix 1: lockedQuizModuleIds is populated for a member with a locked quiz
it("surfaces lockedQuizModuleIds for a member with a locked quiz", async () => {
  const { viewer, course, b, quiz } = await seed();
  const rows = await getCourseCompletion(course.id, viewer.id);
  const bob = rows.find((r) => r.personId === b.id)!;
  expect(bob.lockedQuizModuleIds).toContain(quiz.id);
  expect(bob.lockedQuizModuleIds).toHaveLength(1);
});

// Fix 1: member without any locked modules has empty lockedQuizModuleIds
it("returns empty lockedQuizModuleIds for members with no locked quiz", async () => {
  const { viewer, course, a } = await seed();
  const rows = await getCourseCompletion(course.id, viewer.id);
  const alice = rows.find((r) => r.personId === a.id)!;
  expect(alice.lockedQuizModuleIds).toHaveLength(0);
});

// Fix 3: partial progress shows IN_PROGRESS; no progress shows NOT_STARTED
it("shows IN_PROGRESS for partial progress and NOT_STARTED for no progress", async () => {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const dept = await prisma.department.create({ data: { code: "EDUC", name: "EDUC" } });
  const viewerRole = await prisma.role.create({ data: { name: "V2", grants: { create: [{ permission: "learning.view_progress" }] } } });
  const viewer = await prisma.person.create({ data: { name: "Viewer2", status: "ACTIVE" } });
  await prisma.roleAssignment.create({ data: { personId: viewer.id, roleId: viewerRole.id } });

  const carol = await prisma.person.create({ data: { name: "Carol", status: "ACTIVE" } });
  const dan = await prisma.person.create({ data: { name: "Dan", status: "ACTIVE" } });
  for (const p of [carol, dan]) {
    await prisma.termMembership.create({ data: { personId: p.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  }

  const course = await prisma.course.create({ data: { title: "Two-module", isActive: true } });
  await prisma.courseDepartment.create({ data: { courseId: course.id, departmentId: dept.id } });
  const video = await prisma.courseModule.create({ data: { courseId: course.id, position: 0, title: "Video", kind: "VIDEO", questions: [] as object } });
  const quiz2 = await prisma.courseModule.create({ data: { courseId: course.id, position: 1, title: "Quiz", kind: "QUIZ", questions: [] as object } });

  // Carol has completed only the video (partial = IN_PROGRESS)
  await prisma.moduleProgress.create({ data: { personId: carol.id, moduleId: video.id, completedAt: new Date() } });
  // Dan has no progress at all

  const rows = await getCourseCompletion(course.id, viewer.id);
  const carolRow = rows.find((r) => r.personId === carol.id)!;
  const danRow = rows.find((r) => r.personId === dan.id)!;
  expect(carolRow.status).toBe("IN_PROGRESS");
  expect(danRow.status).toBe("NOT_STARTED");
  void quiz2; // suppress unused warning
});

// Fix 2: DIRECTOR-kind active member of an assigned department appears in dashboard rows
it("includes DIRECTOR-kind members in dashboard rows (not just VOLUNTEER)", async () => {
  const term = await prisma.term.create({ data: { code: "SP27", name: "Spring", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const dept = await prisma.department.create({ data: { code: "LABR", name: "Lab" } });
  const viewerRole = await prisma.role.create({ data: { name: "V3", grants: { create: [{ permission: "learning.view_progress" }] } } });
  const viewer = await prisma.person.create({ data: { name: "Viewer3", status: "ACTIVE" } });
  await prisma.roleAssignment.create({ data: { personId: viewer.id, roleId: viewerRole.id } });

  const director = await prisma.person.create({ data: { name: "Eve Director", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });

  const course = await prisma.course.create({ data: { title: "Dir course", isActive: true } });
  await prisma.courseDepartment.create({ data: { courseId: course.id, departmentId: dept.id } });
  await prisma.courseModule.create({ data: { courseId: course.id, position: 0, title: "Video", kind: "VIDEO", questions: [] as object } });

  const rows = await getCourseCompletion(course.id, viewer.id);
  const eveRow = rows.find((r) => r.personId === director.id);
  expect(eveRow).toBeDefined();
  expect(eveRow!.status).toBe("NOT_STARTED");
});

// Fix 3: adding a second incomplete module after completion makes live status IN_PROGRESS
it("reports IN_PROGRESS when a new module is added after a learner completed the course", async () => {
  const term = await prisma.term.create({ data: { code: "WI27", name: "Winter", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const dept = await prisma.department.create({ data: { code: "PHAM", name: "Pharmacy" } });
  const viewerRole = await prisma.role.create({ data: { name: "V4", grants: { create: [{ permission: "learning.view_progress" }] } } });
  const viewer = await prisma.person.create({ data: { name: "Viewer4", status: "ACTIVE" } });
  await prisma.roleAssignment.create({ data: { personId: viewer.id, roleId: viewerRole.id } });

  const frank = await prisma.person.create({ data: { name: "Frank", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: frank.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });

  const course = await prisma.course.create({ data: { title: "Single then double", isActive: true } });
  await prisma.courseDepartment.create({ data: { courseId: course.id, departmentId: dept.id } });
  const quiz3 = await prisma.courseModule.create({ data: { courseId: course.id, position: 0, title: "Quiz", kind: "QUIZ", questions: [] as object } });

  // Frank passes the quiz and gets a COMPLETE CourseProgress row (simulating Task 8 recompute)
  const frankMp = await prisma.moduleProgress.create({ data: { personId: frank.id, moduleId: quiz3.id, completedAt: new Date() } });
  await prisma.courseQuizAttempt.create({ data: { moduleProgressId: frankMp.id, answers: {}, score: 5, total: 5, passed: true } });
  await prisma.courseProgress.create({ data: { personId: frank.id, courseId: course.id, status: "COMPLETE", completedAt: new Date() } });

  // Manager adds a second module (Frank has NOT completed it)
  await prisma.courseModule.create({ data: { courseId: course.id, position: 1, title: "New Video", kind: "VIDEO", questions: [] as object } });

  const rows = await getCourseCompletion(course.id, viewer.id);
  const frankRow = rows.find((r) => r.personId === frank.id)!;
  // Live derivation: quiz done, video NOT done => IN_PROGRESS (not COMPLETE from stale persisted row)
  expect(frankRow.status).toBe("IN_PROGRESS");
  expect(frankRow.completedAt).toBeNull(); // completedAt only shown when live status is COMPLETE
});
