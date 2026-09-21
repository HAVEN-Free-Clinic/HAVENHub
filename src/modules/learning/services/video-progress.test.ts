import { afterEach, beforeEach, expect, it, vi } from "vitest";

const standing = vi.hoisted(() => ({
  getMakeupAccess: vi.fn(),
  lockMakeup: vi.fn(async () => undefined),
  recomputeTrainingStanding: vi.fn(async () => undefined),
}));
vi.mock("@/platform/training/standing", () => standing);

import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { putObject } from "@/platform/storage";
import { LearningAuthError, LearningValidationError, MakeupLockedError, MakeupNotOwedError } from "./errors";
import { createCourse } from "./courses";
import { addQuestion, createSection, registerCourseVideo, setMakeupCycle, updateSection } from "./video-courses";
import { authorizeVideoFile, getVideoCourseForLearner, recordSectionHeartbeat, submitSectionQuiz } from "./video-progress";

/** A ready two-section makeup course over one 3600 s recording, linked to the
 *  FA26 training cycle, and a learner who owes it. */
async function seed() {
  const manager = await prisma.person.create({ data: { name: "Mgr", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Learning Admin", grants: { create: [{ permission: "learning.manage_courses" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: manager.id, roleId: role.id } });
  const learner = await prisma.person.create({ data: { name: "Lee", status: "ACTIVE" } });
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", status: "PLANNING", startDate: new Date("2026-10-01"), endDate: new Date("2026-12-31") },
  });
  const cycle = await prisma.recruitmentCycle.create({
    data: { title: "Volunteer Fall 2026", track: "VOLUNTEER", termId: term.id, publicSlug: "fa26", isTermTraining: true, createdById: manager.id },
  });
  const course = await createCourse({ title: "Makeup", kind: "VIDEO" }, manager.id);
  const key = `learning-video/${course.id}/rec.mp4`;
  await putObject(key, Buffer.from("mp4"), "video/mp4");
  const video = await registerCourseVideo(course.id, { key, fileName: "rec.mp4", contentType: "video/mp4", durationSeconds: 3600 }, manager.id);
  const part1 = await createSection(course.id, "Part 1", manager.id);
  await updateSection(part1.id, { title: "Part 1", videoId: video.id, startSeconds: 0, endSeconds: 1800, passPercent: 100, maxAttempts: 3 }, manager.id);
  await addQuestion(part1.id, { prompt: "Q1", options: ["Right", "Wrong"], correctIndex: 0 }, manager.id);
  const part2 = await createSection(course.id, "HIPAA", manager.id);
  await updateSection(part2.id, { title: "HIPAA", videoId: video.id, startSeconds: 1800, endSeconds: null, passPercent: 100, maxAttempts: 3 }, manager.id);
  await addQuestion(part2.id, { prompt: "Q2", options: ["Yes", "No"], correctIndex: 0 }, manager.id);
  await setMakeupCycle(course.id, cycle.id, manager.id);
  const [q1] = await prisma.courseQuestion.findMany({ where: { sectionId: part1.id } });
  const [q2] = await prisma.courseQuestion.findMany({ where: { sectionId: part2.id } });
  return { manager, learner, term, cycle, course, video, part1, part2, q1, q2 };
}

function owes(termId: string, extra: Partial<{ status: string; locked: boolean; lockResetAt: Date | null }> = {}) {
  standing.getMakeupAccess.mockResolvedValue({
    status: "OWED",
    termId,
    track: "VOLUNTEER",
    locked: false,
    lockResetAt: null,
    ...extra,
  });
}

/** Pretend the learner has been watching: push the last heartbeat back in time. */
async function rewindHeartbeat(personId: string, sectionId: string, seconds: number) {
  const row = await prisma.sectionProgress.findFirstOrThrow({ where: { personId, sectionId } });
  await prisma.sectionProgress.update({
    where: { id: row.id },
    data: { lastHeartbeatAt: new Date((row.lastHeartbeatAt ?? new Date()).getTime() - seconds * 1000) },
  });
}

/** Watch a whole section honestly: heartbeats spaced by 100 s of simulated time. */
async function watchAll(personId: string, courseId: string, sectionId: string, length: number) {
  let reached = 0;
  await recordSectionHeartbeat(personId, courseId, sectionId, 0);
  while (reached < length) {
    await rewindHeartbeat(personId, sectionId, 100);
    reached = Math.min(length, reached + 100);
    await recordSectionHeartbeat(personId, courseId, sectionId, reached);
  }
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});
afterEach(async () => { await resetDb(); });

it("refuses a makeup course to someone who does not owe it, with its own error", async () => {
  const { learner, course, term } = await seed();
  standing.getMakeupAccess.mockResolvedValue({ status: "NOT_OWED", termId: term.id, track: "VOLUNTEER", locked: false, lockResetAt: null });
  await expect(getVideoCourseForLearner(learner.id, course.id)).rejects.toBeInstanceOf(MakeupNotOwedError);
  await expect(recordSectionHeartbeat(learner.id, course.id, "x", 0)).rejects.toBeInstanceOf(LearningAuthError);
});

it("shows the course without ever sending an answer key", async () => {
  const { learner, course, term } = await seed();
  owes(term.id);
  const view = await getVideoCourseForLearner(learner.id, course.id);
  expect(view.isMakeup).toBe(true);
  expect(view.sections.map((s) => s.length)).toEqual([1800, 1800]);
  expect(view.sections.map((s) => s.state.unlocked)).toEqual([true, false]);
  expect(view.sections[0].maxAttempts).toBe(3);
  expect(JSON.stringify(view)).not.toContain("correctValue");
});

it("credits honest watching and records it against the cycle's term, not the active one", async () => {
  const { learner, course, term, part1 } = await seed();
  owes(term.id);
  await recordSectionHeartbeat(learner.id, course.id, part1.id, 0);
  await rewindHeartbeat(learner.id, part1.id, 10);
  const r = await recordSectionHeartbeat(learner.id, course.id, part1.id, 10);
  expect(r.watchedSeconds).toBe(10);
  const row = await prisma.sectionProgress.findFirstOrThrow({ where: { personId: learner.id, sectionId: part1.id } });
  expect(row.termId).toBe(term.id);
  expect(await prisma.courseProgress.count({ where: { personId: learner.id, courseId: course.id, termId: term.id } })).toBe(1);
});

it("a forged jump to the end is clamped to real time", async () => {
  const { learner, course, term, part1 } = await seed();
  owes(term.id);
  await recordSectionHeartbeat(learner.id, course.id, part1.id, 0);
  const r = await recordSectionHeartbeat(learner.id, course.id, part1.id, 1800);
  expect(r.complete).toBe(false);
  expect(r.watchedSeconds).toBeLessThan(10);
});

it("writes nothing for a heartbeat on a section already watched, so a burst of them cannot abort the quiz", async () => {
  // A player parked at a section's end once sent heartbeats in a tight loop.
  // Each was a Serializable write to the row the quiz transaction reads, so the
  // quiz lost every retry (2026-09-21). Tabs still running that player keep
  // looping until they reload, so the server must shrug these off.
  const { learner, course, term, part1, q1 } = await seed();
  owes(term.id);
  await watchAll(learner.id, course.id, part1.id, 1800);
  const before = await prisma.sectionProgress.findFirstOrThrow({ where: { personId: learner.id, sectionId: part1.id } });

  const [quiz, ...beats] = await Promise.all([
    submitSectionQuiz(learner.id, course.id, part1.id, { [q1.id]: "opt-1" }),
    ...Array.from({ length: 10 }, () => recordSectionHeartbeat(learner.id, course.id, part1.id, 1800)),
  ]);

  expect(quiz.passed).toBe(true);
  expect(beats).toEqual(Array.from({ length: 10 }, () => ({ watchedSeconds: 1800, complete: true })));
  const after = await prisma.sectionProgress.findFirstOrThrow({ where: { personId: learner.id, sectionId: part1.id } });
  expect(after.lastHeartbeatAt).toEqual(before.lastHeartbeatAt);
});

it("refuses a heartbeat for a section that is not open yet", async () => {
  const { learner, course, term, part2 } = await seed();
  owes(term.id);
  await expect(recordSectionHeartbeat(learner.id, course.id, part2.id, 0)).rejects.toThrow(/earlier sections/);
});

it("will not grade a quiz before the video has been watched", async () => {
  const { learner, course, term, part1, q1 } = await seed();
  owes(term.id);
  await recordSectionHeartbeat(learner.id, course.id, part1.id, 0);
  await expect(submitSectionQuiz(learner.id, course.id, part1.id, { [q1.id]: "opt-1" })).rejects.toThrow(/Watch the whole video/);
});

it("passes section by section, completes the course, and credits the morning", async () => {
  const { learner, course, term, part1, part2, q1, q2 } = await seed();
  owes(term.id);
  await watchAll(learner.id, course.id, part1.id, 1800);
  const first = await submitSectionQuiz(learner.id, course.id, part1.id, { [q1.id]: "opt-1" });
  expect(first).toMatchObject({ passed: true, courseComplete: false, verdictByKey: { [q1.id]: "correct" } });
  expect(standing.recomputeTrainingStanding).not.toHaveBeenCalled();

  await watchAll(learner.id, course.id, part2.id, 1800);
  const second = await submitSectionQuiz(learner.id, course.id, part2.id, { [q2.id]: "opt-1" });
  expect(second).toMatchObject({ passed: true, courseComplete: true });

  const rollup = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });
  expect(rollup).toMatchObject({ status: "COMPLETE", lessonStatus: "completed", termId: term.id, scoreRaw: 100 });
  expect(standing.recomputeTrainingStanding).toHaveBeenCalledTimes(1);
  expect(standing.recomputeTrainingStanding).toHaveBeenCalledWith(expect.anything(), {
    personId: learner.id,
    termId: term.id,
    track: "VOLUNTEER",
  });
});

it("locks the makeup on the third failed attempt at a section, and refuses while locked", async () => {
  const { learner, course, term, part1, q1 } = await seed();
  owes(term.id);
  await watchAll(learner.id, course.id, part1.id, 1800);
  const a1 = await submitSectionQuiz(learner.id, course.id, part1.id, { [q1.id]: "opt-2" });
  expect(a1).toMatchObject({ passed: false, attemptsUsed: 1, locked: false, verdictByKey: { [q1.id]: "wrong" } });
  await submitSectionQuiz(learner.id, course.id, part1.id, { [q1.id]: "opt-2" });
  const a3 = await submitSectionQuiz(learner.id, course.id, part1.id, { [q1.id]: "opt-2" });
  expect(a3).toMatchObject({ attemptsUsed: 3, locked: true });
  expect(standing.lockMakeup).toHaveBeenCalledWith(expect.anything(), learner.id, expect.any(String));

  owes(term.id, { locked: true });
  await expect(submitSectionQuiz(learner.id, course.id, part1.id, { [q1.id]: "opt-1" })).rejects.toBeInstanceOf(MakeupLockedError);
});

it("counts only attempts after a director's reset", async () => {
  const { learner, course, term, part1, q1 } = await seed();
  owes(term.id);
  await watchAll(learner.id, course.id, part1.id, 1800);
  await submitSectionQuiz(learner.id, course.id, part1.id, { [q1.id]: "opt-2" });
  await submitSectionQuiz(learner.id, course.id, part1.id, { [q1.id]: "opt-2" });
  owes(term.id, { lockResetAt: new Date(Date.now() + 1000) });
  await new Promise((r) => setTimeout(r, 1100));
  const next = await submitSectionQuiz(learner.id, course.id, part1.id, { [q1.id]: "opt-2" });
  expect(next).toMatchObject({ attemptsUsed: 1, locked: false });
});

it("refuses more work once the makeup is done, but still shows it", async () => {
  const { learner, course, term, part1, q1 } = await seed();
  owes(term.id, { status: "DONE" });
  const view = await getVideoCourseForLearner(learner.id, course.id);
  expect(view.complete).toBe(true);
  await expect(submitSectionQuiz(learner.id, course.id, part1.id, { [q1.id]: "opt-1" })).rejects.toBeInstanceOf(LearningValidationError);
});

it("authorizes the video file for a manager and an owing learner only", async () => {
  const { manager, learner, course, term, video } = await seed();
  const stranger = await prisma.person.create({ data: { name: "Stranger", status: "ACTIVE" } });
  expect(await authorizeVideoFile(manager.id, video.id)).toMatchObject({ contentType: "video/mp4" });
  owes(term.id);
  expect(await authorizeVideoFile(learner.id, video.id)).not.toBeNull();
  standing.getMakeupAccess.mockResolvedValue({ status: "NOT_OWED", termId: term.id, track: "VOLUNTEER", locked: false, lockResetAt: null });
  expect(await authorizeVideoFile(stranger.id, video.id)).toBeNull();
  void course;
});

// ---------------------------------------------------------------------------
// Manager preview: a course that is not theirs to take.

it("lets a course manager open every section and quiz without watching, and records nothing", async () => {
  const { manager, course, term, part1, q1 } = await seed();
  // A manager does not owe the makeup, which is what would normally refuse them.
  standing.getMakeupAccess.mockResolvedValue({ status: "NOT_OWED", termId: term.id, track: "VOLUNTEER", locked: false, lockResetAt: null });

  const view = await getVideoCourseForLearner(manager.id, course.id);

  expect(view.preview).toBe(true);
  expect(view.sections.map((s) => s.state.quizOpen)).toEqual([true, true]);
  expect(view.sections.map((s) => s.state.unlocked)).toEqual([true, true]);

  // The quiz grades and answers back, exactly as a learner would see.
  const result = await submitSectionQuiz(manager.id, course.id, part1.id, { [q1!.id]: q1!.correctValue! });
  expect(result).toMatchObject({ passed: true, score: 1, total: 1, courseComplete: false, attemptsUsed: 0 });

  // ...and nothing was written: no attempt, no progress, no completion, and no
  // training credit. This is what makes it safe to hand to every manager.
  expect(await prisma.sectionQuizAttempt.count()).toBe(0);
  expect(await prisma.sectionProgress.count()).toBe(0);
  expect(await prisma.courseProgress.count()).toBe(0);
  expect(standing.recomputeTrainingStanding).not.toHaveBeenCalled();

  // A heartbeat in preview credits nothing either.
  const beat = await recordSectionHeartbeat(manager.id, course.id, part1.id, 900);
  expect(beat.watchedSeconds).toBe(900);
  expect(await prisma.sectionProgress.count()).toBe(0);
});

it("treats a manager who actually owes the makeup as a learner, not a previewer", async () => {
  const { manager, course, term, part1, q1 } = await seed();
  owes(term.id);

  const view = await getVideoCourseForLearner(manager.id, course.id);

  expect(view.preview).toBe(false);
  // The watch gate still applies to them.
  expect(view.sections[0]!.state.quizOpen).toBe(false);
  await expect(
    submitSectionQuiz(manager.id, course.id, part1.id, { [q1!.id]: q1!.correctValue! })
  ).rejects.toBeInstanceOf(LearningValidationError);
});

it("lets a manager preview a makeup course that is not released or ready yet", async () => {
  const { manager, course, term } = await seed();
  await prisma.course.update({ where: { id: course.id }, data: { videoReady: false } });
  standing.getMakeupAccess.mockResolvedValue({ status: "NOT_OWED", termId: term.id, track: "VOLUNTEER", locked: false, lockResetAt: null });

  const view = await getVideoCourseForLearner(manager.id, course.id);
  expect(view.preview).toBe(true);
});

it("still refuses a learner who does not manage courses", async () => {
  const { learner, course, term } = await seed();
  standing.getMakeupAccess.mockResolvedValue({ status: "NOT_OWED", termId: term.id, track: "VOLUNTEER", locked: false, lockResetAt: null });
  await expect(getVideoCourseForLearner(learner.id, course.id)).rejects.toBeInstanceOf(MakeupNotOwedError);
});
