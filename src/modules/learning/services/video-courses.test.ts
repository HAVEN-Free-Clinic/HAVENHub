import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { putObject } from "@/platform/storage";
import { LearningAuthError, LearningValidationError } from "./errors";
import { createCourse, listCourses } from "./courses";
import {
  addQuestion,
  createSection,
  deleteCourseVideo,
  isCourseVideoKey,
  parseOptionsText,
  registerCourseVideo,
  setMakeupCycle,
  updateSection,
} from "./video-courses";
import { getMyCourses } from "./enrollment";

async function seed() {
  const manager = await prisma.person.create({ data: { name: "Mgr", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Learning Admin", grants: { create: [{ permission: "learning.manage_courses" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: manager.id, roleId: role.id } });
  const plain = await prisma.person.create({ data: { name: "Plain", status: "ACTIVE" } });
  const course = await createCourse({ title: "Makeup", kind: "VIDEO" }, manager.id);
  return { manager, plain, course };
}

async function uploadVideo(courseId: string, managerId: string, durationSeconds: number | null = 3600) {
  const key = `learning-video/${courseId}/abc-training.mp4`;
  await putObject(key, Buffer.from("fake mp4 bytes"), "video/mp4");
  return registerCourseVideo(courseId, { key, fileName: "training.mp4", contentType: "video/mp4", durationSeconds }, managerId);
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("isCourseVideoKey accepts only this course's namespace", () => {
  expect(isCourseVideoKey("learning-video/c1/x-a.mp4", "c1")).toBe(true);
  expect(isCourseVideoKey("learning-video/c2/x-a.mp4", "c1")).toBe(false);
  expect(isCourseVideoKey("learning-video/c1/../c2/a.mp4", "c1")).toBe(false);
  expect(isCourseVideoKey("learning-video/c1/sub/a.mp4", "c1")).toBe(false);
  expect(isCourseVideoKey("scorm/c1/a.mp4", "c1")).toBe(false);
});

it("parseOptionsText reads one choice per line with the answer starred", () => {
  expect(parseOptionsText("*Yes\nNo\n\n Maybe ")).toEqual({ options: ["Yes", "No", "Maybe"], correctIndex: 0, starred: 1 });
  expect(parseOptionsText("A\nB")).toEqual({ options: ["A", "B"], correctIndex: null, starred: 0 });
  expect(parseOptionsText("*A\n*B").correctIndex).toBeNull();
});

it("refuses to register a video for someone without the manage permission", async () => {
  const { plain, course } = await seed();
  await expect(
    registerCourseVideo(course.id, { key: `learning-video/${course.id}/a.mp4`, fileName: "a.mp4", contentType: "video/mp4", durationSeconds: 10 }, plain.id)
  ).rejects.toBeInstanceOf(LearningAuthError);
});

it("refuses a key outside the course's namespace, or an upload that never reached storage", async () => {
  const { manager, course } = await seed();
  await expect(
    registerCourseVideo(course.id, { key: "learning-video/other/a.mp4", fileName: "a.mp4", contentType: "video/mp4", durationSeconds: 10 }, manager.id)
  ).rejects.toBeInstanceOf(LearningValidationError);
  await expect(
    registerCourseVideo(course.id, { key: `learning-video/${course.id}/missing.mp4`, fileName: "a.mp4", contentType: "video/mp4", durationSeconds: 10 }, manager.id)
  ).rejects.toThrow(/did not reach storage/);
});

it("records the stored size, not a client claim", async () => {
  const { manager, course } = await seed();
  const video = await uploadVideo(course.id, manager.id);
  expect(Number(video.sizeBytes)).toBe(Buffer.from("fake mp4 bytes").length);
});

it("a course becomes ready only when every section has a video, a length, and a keyed question", async () => {
  const { manager, course } = await seed();
  const ready = async () => (await prisma.course.findUniqueOrThrow({ where: { id: course.id } })).videoReady;

  const video = await uploadVideo(course.id, manager.id);
  const s1 = await createSection(course.id, "Part 1", manager.id);
  // One video in the course: the new section picks it up by default.
  expect(s1.videoId).toBe(video.id);
  expect(await ready()).toBe(false);

  await addQuestion(s1.id, { prompt: "Q?", options: ["A", "B"], correctIndex: null }, manager.id);
  expect(await ready()).toBe(false); // ungraded only

  await addQuestion(s1.id, { prompt: "Q2?", options: ["A", "B"], correctIndex: 1 }, manager.id);
  expect(await ready()).toBe(true);

  const s2 = await createSection(course.id, "HIPAA", manager.id);
  expect(await ready()).toBe(false);
  await updateSection(s2.id, { title: "HIPAA", videoId: video.id, startSeconds: 1800, endSeconds: null, passPercent: 80, maxAttempts: 3 }, manager.id);
  await addQuestion(s2.id, { prompt: "PHI?", options: ["Yes", "No"], correctIndex: 0 }, manager.id);
  expect(await ready()).toBe(true);

  // Deleting the video strands both sections: not ready, questions kept.
  await deleteCourseVideo(video.id, manager.id);
  expect(await ready()).toBe(false);
  expect(await prisma.courseQuestion.count({ where: { section: { courseId: course.id } } })).toBe(3);
});

it("a section on a video with no known duration needs an explicit end", async () => {
  const { manager, course } = await seed();
  const video = await uploadVideo(course.id, manager.id, null);
  const s1 = await createSection(course.id, "Part 1", manager.id);
  await addQuestion(s1.id, { prompt: "Q?", options: ["A", "B"], correctIndex: 0 }, manager.id);
  expect((await prisma.course.findUniqueOrThrow({ where: { id: course.id } })).videoReady).toBe(false);
  await updateSection(s1.id, { title: "Part 1", videoId: video.id, startSeconds: 0, endSeconds: 600, passPercent: 80, maxAttempts: 3 }, manager.id);
  expect((await prisma.course.findUniqueOrThrow({ where: { id: course.id } })).videoReady).toBe(true);
});

it("rejects an end before the start and a video from another course", async () => {
  const { manager, course } = await seed();
  const other = await createCourse({ title: "Other", kind: "VIDEO" }, manager.id);
  const foreign = await uploadVideo(other.id, manager.id);
  const s1 = await createSection(course.id, "Part 1", manager.id);
  await expect(
    updateSection(s1.id, { title: "P", videoId: null, startSeconds: 100, endSeconds: 50, passPercent: 80, maxAttempts: 3 }, manager.id)
  ).rejects.toThrow(/after the start/);
  await expect(
    updateSection(s1.id, { title: "P", videoId: foreign.id, startSeconds: 0, endSeconds: null, passPercent: 80, maxAttempts: 3 }, manager.id)
  ).rejects.toThrow(/this course's videos/);
});

it("links a course as a training cycle's makeup, one course per cycle", async () => {
  const { manager, course } = await seed();
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", status: "ACTIVE", startDate: new Date("2026-09-01"), endDate: new Date("2026-12-31") },
  });
  const cycle = await prisma.recruitmentCycle.create({
    data: { title: "Volunteer Fall 2026", track: "VOLUNTEER", termId: term.id, publicSlug: "fa26", isTermTraining: true, createdById: manager.id },
  });
  const notTraining = await prisma.recruitmentCycle.create({
    data: { title: "Directors", track: "DIRECTOR", termId: term.id, publicSlug: "fa26d", createdById: manager.id },
  });
  await expect(setMakeupCycle(course.id, notTraining.id, manager.id)).rejects.toThrow(/term's training/);
  await setMakeupCycle(course.id, cycle.id, manager.id);
  expect((await prisma.course.findUniqueOrThrow({ where: { id: course.id } })).makeupForCycleId).toBe(cycle.id);

  const second = await createCourse({ title: "Second", kind: "VIDEO" }, manager.id);
  await expect(setMakeupCycle(second.id, cycle.id, manager.id)).rejects.toThrow(/already that cycle's makeup/);

  const scorm = await createCourse({ title: "Scorm" }, manager.id);
  await expect(setMakeupCycle(scorm.id, cycle.id, manager.id)).rejects.toThrow(/not a video course/);

  const list = await listCourses();
  expect(list.find((c) => c.id === course.id)?.makeupForCycleTitle).toBe("Volunteer Fall 2026");
});

it("never lists a ready makeup course on anyone's own course list, even assigned to everyone", async () => {
  const { manager, course } = await seed();
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", status: "ACTIVE", startDate: new Date("2026-09-01"), endDate: new Date("2026-12-31") },
  });
  const dept = await prisma.department.create({ data: { code: "PNLC", name: "PNLC" } });
  const learner = await prisma.person.create({ data: { name: "Lee", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: learner.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: { title: "Volunteer Fall 2026", track: "VOLUNTEER", termId: term.id, publicSlug: "fa26", isTermTraining: true, createdById: manager.id },
  });
  await uploadVideo(course.id, manager.id);
  const s1 = await createSection(course.id, "Part 1", manager.id);
  await addQuestion(s1.id, { prompt: "Q?", options: ["A", "B"], correctIndex: 0 }, manager.id);
  await prisma.course.update({ where: { id: course.id }, data: { assignToAll: true } });

  // Ready and assigned to everyone: an ordinary VIDEO course is listed.
  expect((await getMyCourses(learner.id)).map((c) => c.id)).toEqual([course.id]);

  await setMakeupCycle(course.id, cycle.id, manager.id);
  expect(await getMyCourses(learner.id)).toEqual([]);
});
