/**
 * Authoring a VIDEO course: its uploaded videos, its sections (a time range of
 * a video plus a quiz), the quiz questions, and the link that makes it a
 * training cycle's online makeup. Every write here that can change whether the
 * course is completable re-derives Course.videoReady in the same transaction,
 * which is what keeps a half-built course out of everyone's assignment.
 */
import type { Prisma } from "@prisma/client";
import { prisma, type TransactionClient } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { deleteObject, objectSize } from "@/platform/storage";
import { countGradedQuestions } from "@/platform/quiz/graded";
import { sectionLength } from "../engine/watch";
import { videoCourseReady } from "../engine/video-course";
import { LearningAuthError, LearningValidationError } from "./errors";

type Db = typeof prisma | TransactionClient;

/** Every stored object of a course's videos lives under this prefix. */
export function videoKeyPrefix(courseId: string): string {
  return `learning-video/${courseId}/`;
}

/** Whether `key` is a well-formed object key inside this course's namespace.
 *  Keys come back from the browser after a direct upload, so they are
 *  untrusted until this says otherwise. */
export function isCourseVideoKey(key: string, courseId: string): boolean {
  const prefix = videoKeyPrefix(courseId);
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  return /^[A-Za-z0-9._-]+$/.test(rest) && !rest.includes("..");
}

async function requireManager(actorId: string): Promise<void> {
  if (!(await can(actorId, "learning.manage_courses"))) {
    throw new LearningAuthError("You do not have permission to manage courses.");
  }
}

async function requireVideoCourse(db: Db, courseId: string) {
  const course = await db.course.findUnique({ where: { id: courseId }, select: { id: true, kind: true } });
  if (!course) throw new LearningValidationError("Course not found.");
  if (course.kind !== "VIDEO") throw new LearningValidationError("This is not a video course.");
  return course;
}

/** Re-derive Course.videoReady from the course's sections. */
export async function recomputeVideoReady(db: Db, courseId: string): Promise<boolean> {
  const sections = await db.courseSection.findMany({
    where: { courseId },
    select: {
      startSeconds: true,
      endSeconds: true,
      video: { select: { durationSeconds: true } },
      questions: { select: { correctValue: true } },
    },
  });
  const ready = videoCourseReady(
    sections.map((s) => ({
      hasVideo: s.video != null,
      length: s.video ? sectionLength(s, s.video.durationSeconds) : null,
      gradedQuestionCount: countGradedQuestions(s.questions),
    }))
  );
  await db.course.update({ where: { id: courseId }, data: { videoReady: ready } });
  return ready;
}

/** Everything the course editor renders. */
export async function getVideoCourseForEdit(courseId: string) {
  return prisma.course.findUnique({
    where: { id: courseId },
    include: {
      videos: { orderBy: { createdAt: "asc" } },
      sections: {
        orderBy: { position: "asc" },
        include: { questions: { orderBy: { position: "asc" } } },
      },
      makeupForCycle: { select: { id: true, title: true } },
    },
  });
}

/** Training cycles a course can make up: the ones designated as a term's
 *  training, newest term first. */
export async function listMakeupCycleOptions(): Promise<{ id: string; title: string; termName: string }[]> {
  const cycles = await prisma.recruitmentCycle.findMany({
    where: { isTermTraining: true },
    orderBy: [{ term: { startDate: "desc" } }, { title: "asc" }],
    select: { id: true, title: true, term: { select: { name: true } } },
  });
  return cycles.map((c) => ({ id: c.id, title: c.title, termName: c.term.name }));
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

export type RegisterVideoInput = {
  key: string;
  fileName: string;
  contentType: string;
  durationSeconds: number | null;
};

const VIDEO_CONTENT_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

/**
 * Record a video the browser already uploaded straight to storage. The stored
 * size is read from storage, not trusted from the client, and the object must
 * actually exist: a key for an upload that failed half way must not become a
 * section's video.
 */
export async function registerCourseVideo(courseId: string, input: RegisterVideoInput, actorId: string) {
  await requireManager(actorId);
  await requireVideoCourse(prisma, courseId);
  if (!isCourseVideoKey(input.key, courseId)) throw new LearningValidationError("Invalid upload reference.");
  if (!VIDEO_CONTENT_TYPES.has(input.contentType)) {
    throw new LearningValidationError("Upload an MP4 video.");
  }
  const size = await objectSize(input.key);
  if (size == null) throw new LearningValidationError("The upload did not reach storage. Try again.");
  const duration =
    input.durationSeconds != null && Number.isFinite(input.durationSeconds) && input.durationSeconds > 0
      ? input.durationSeconds
      : null;
  const video = await prisma.courseVideo.create({
    data: {
      courseId,
      storageKey: input.key,
      fileName: input.fileName.slice(0, 200) || "video.mp4",
      contentType: input.contentType,
      sizeBytes: BigInt(size),
      durationSeconds: duration,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.video_upload",
    entityType: "Course",
    entityId: courseId,
    after: { videoId: video.id, fileName: video.fileName, sizeBytes: size, durationSeconds: duration },
  });
  return video;
}

/** Attach (or replace) a video's WebVTT captions, uploaded straight to storage. */
export async function setVideoCaptions(
  videoId: string,
  input: { key: string; fileName: string },
  actorId: string
): Promise<void> {
  await requireManager(actorId);
  const video = await prisma.courseVideo.findUnique({ where: { id: videoId } });
  if (!video) throw new LearningValidationError("Video not found.");
  if (!isCourseVideoKey(input.key, video.courseId)) throw new LearningValidationError("Invalid upload reference.");
  if ((await objectSize(input.key)) == null) {
    throw new LearningValidationError("The upload did not reach storage. Try again.");
  }
  await prisma.courseVideo.update({
    where: { id: videoId },
    data: { captionsKey: input.key, captionsFileName: input.fileName.slice(0, 200) || "captions.vtt" },
  });
  if (video.captionsKey && video.captionsKey !== input.key) {
    await deleteObject(video.captionsKey).catch(() => undefined);
  }
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.video_captions",
    entityType: "Course",
    entityId: video.courseId,
    after: { videoId, fileName: input.fileName },
  });
}

/** Remove a video's captions. */
export async function clearVideoCaptions(videoId: string, actorId: string): Promise<void> {
  await requireManager(actorId);
  const video = await prisma.courseVideo.findUnique({ where: { id: videoId } });
  if (!video) throw new LearningValidationError("Video not found.");
  await prisma.courseVideo.update({ where: { id: videoId }, data: { captionsKey: null, captionsFileName: null } });
  if (video.captionsKey) await deleteObject(video.captionsKey).catch(() => undefined);
}

/**
 * Delete a video and its stored files. Sections that used it stay, pointing at
 * nothing, so the course drops out of assignment until an admin picks another
 * video rather than losing its questions.
 */
export async function deleteCourseVideo(videoId: string, actorId: string): Promise<void> {
  await requireManager(actorId);
  const video = await prisma.courseVideo.findUnique({ where: { id: videoId } });
  if (!video) return;
  await prisma.$transaction(async (tx) => {
    await tx.courseVideo.delete({ where: { id: videoId } });
    await recomputeVideoReady(tx, video.courseId);
  });
  await deleteObject(video.storageKey).catch(() => undefined);
  if (video.captionsKey) await deleteObject(video.captionsKey).catch(() => undefined);
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.video_delete",
    entityType: "Course",
    entityId: video.courseId,
    after: { videoId, fileName: video.fileName },
  });
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export async function createSection(courseId: string, title: string, actorId: string) {
  await requireManager(actorId);
  const clean = title.trim();
  if (!clean) throw new LearningValidationError("Section title is required.");
  return prisma.$transaction(async (tx) => {
    await requireVideoCourse(tx, courseId);
    const max = await tx.courseSection.aggregate({ where: { courseId }, _max: { position: true } });
    // Default to the course's only video, the common case (one Zoom recording).
    const videos = await tx.courseVideo.findMany({ where: { courseId }, select: { id: true }, take: 2 });
    const section = await tx.courseSection.create({
      data: {
        courseId,
        title: clean,
        position: (max._max.position ?? -1) + 1,
        videoId: videos.length === 1 ? videos[0].id : null,
      },
    });
    await recomputeVideoReady(tx, courseId);
    return section;
  });
}

export type SectionInput = {
  title: string;
  videoId: string | null;
  startSeconds: number;
  endSeconds: number | null;
  passPercent: number;
  maxAttempts: number;
};

export async function updateSection(sectionId: string, input: SectionInput, actorId: string): Promise<void> {
  await requireManager(actorId);
  const title = input.title.trim();
  if (!title) throw new LearningValidationError("Section title is required.");
  if (!Number.isFinite(input.startSeconds) || input.startSeconds < 0) {
    throw new LearningValidationError("Start time must be zero or later.");
  }
  if (input.endSeconds != null && (!Number.isFinite(input.endSeconds) || input.endSeconds <= input.startSeconds)) {
    throw new LearningValidationError("End time must be after the start time.");
  }
  if (!Number.isInteger(input.passPercent) || input.passPercent < 1 || input.passPercent > 100) {
    throw new LearningValidationError("Pass percent must be between 1 and 100.");
  }
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 20) {
    throw new LearningValidationError("Attempts must be between 1 and 20.");
  }
  const section = await prisma.courseSection.findUnique({ where: { id: sectionId }, select: { courseId: true } });
  if (!section) throw new LearningValidationError("Section not found.");
  await prisma.$transaction(async (tx) => {
    if (input.videoId) {
      const video = await tx.courseVideo.findUnique({ where: { id: input.videoId }, select: { courseId: true, durationSeconds: true } });
      if (!video || video.courseId !== section.courseId) throw new LearningValidationError("Choose one of this course's videos.");
      if (video.durationSeconds != null && input.startSeconds >= video.durationSeconds) {
        throw new LearningValidationError("Start time is past the end of the video.");
      }
    }
    await tx.courseSection.update({
      where: { id: sectionId },
      data: {
        title,
        videoId: input.videoId,
        startSeconds: input.startSeconds,
        endSeconds: input.endSeconds,
        passPercent: input.passPercent,
        maxAttempts: input.maxAttempts,
      },
    });
    await recomputeVideoReady(tx, section.courseId);
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.section_update",
    entityType: "Course",
    entityId: section.courseId,
    after: { sectionId, ...input },
  });
}

export async function deleteSection(sectionId: string, actorId: string): Promise<void> {
  await requireManager(actorId);
  const section = await prisma.courseSection.findUnique({ where: { id: sectionId }, select: { courseId: true, title: true } });
  if (!section) return;
  await prisma.$transaction(async (tx) => {
    await tx.courseSection.delete({ where: { id: sectionId } });
    await recomputeVideoReady(tx, section.courseId);
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.section_delete",
    entityType: "Course",
    entityId: section.courseId,
    after: { sectionId, title: section.title },
  });
}

/** Swap a section with its neighbour. Positions are renumbered 0..n-1 so gaps
 *  left by deletes never make a move look like a no-op. */
export async function moveSection(sectionId: string, direction: "up" | "down", actorId: string): Promise<void> {
  await requireManager(actorId);
  const section = await prisma.courseSection.findUnique({ where: { id: sectionId }, select: { courseId: true } });
  if (!section) return;
  await prisma.$transaction(async (tx) => {
    const ordered = await tx.courseSection.findMany({
      where: { courseId: section.courseId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    const ids = ordered.map((s) => s.id);
    const i = ids.indexOf(sectionId);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    for (const [position, id] of ids.entries()) {
      await tx.courseSection.update({ where: { id }, data: { position } });
    }
  });
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export type QuestionInput = {
  prompt: string;
  /** Answer choices in display order. */
  options: string[];
  /** Index into options of the right answer, or null for an ungraded question. */
  correctIndex: number | null;
};

/**
 * Parse the editor's one-textarea question format: one choice per line, the
 * right answer marked with a leading "*". Blank lines are ignored.
 */
export function parseOptionsText(text: string): { options: string[]; correctIndex: number | null; starred: number } {
  const options: string[] = [];
  let correctIndex: number | null = null;
  let starred = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("*")) {
      starred += 1;
      correctIndex = options.length;
      options.push(line.slice(1).trim());
    } else {
      options.push(line);
    }
  }
  return { options, correctIndex: starred === 1 ? correctIndex : null, starred };
}

function questionData(input: QuestionInput): { prompt: string; options: Prisma.InputJsonValue; correctValue: string | null } {
  const prompt = input.prompt.trim();
  if (!prompt) throw new LearningValidationError("Question text is required.");
  const labels = input.options.map((o) => o.trim()).filter(Boolean);
  if (labels.length < 2) throw new LearningValidationError("Give at least two answer choices.");
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) {
    throw new LearningValidationError("Answer choices must be different from each other.");
  }
  if (input.correctIndex != null && (input.correctIndex < 0 || input.correctIndex >= labels.length)) {
    throw new LearningValidationError("Mark one of the choices as the right answer.");
  }
  // Values are positional ("opt-1", "opt-2", ...) and rewritten with the labels
  // on every save, so a reworded choice keeps its answer key without an id per
  // choice. Past attempts keep what they recorded; they are history, not re-graded.
  const options = labels.map((label, i) => ({ value: `opt-${i + 1}`, label }));
  return {
    prompt,
    options,
    correctValue: input.correctIndex != null ? options[input.correctIndex].value : null,
  };
}

export async function addQuestion(sectionId: string, input: QuestionInput, actorId: string): Promise<void> {
  await requireManager(actorId);
  const data = questionData(input);
  const section = await prisma.courseSection.findUnique({ where: { id: sectionId }, select: { courseId: true } });
  if (!section) throw new LearningValidationError("Section not found.");
  await prisma.$transaction(async (tx) => {
    const max = await tx.courseQuestion.aggregate({ where: { sectionId }, _max: { position: true } });
    await tx.courseQuestion.create({ data: { sectionId, position: (max._max.position ?? -1) + 1, ...data } });
    await recomputeVideoReady(tx, section.courseId);
  });
}

export async function updateQuestion(questionId: string, input: QuestionInput, actorId: string): Promise<void> {
  await requireManager(actorId);
  const data = questionData(input);
  const question = await prisma.courseQuestion.findUnique({
    where: { id: questionId },
    select: { section: { select: { courseId: true } } },
  });
  if (!question) throw new LearningValidationError("Question not found.");
  await prisma.$transaction(async (tx) => {
    await tx.courseQuestion.update({ where: { id: questionId }, data });
    await recomputeVideoReady(tx, question.section.courseId);
  });
}

export async function deleteQuestion(questionId: string, actorId: string): Promise<void> {
  await requireManager(actorId);
  const question = await prisma.courseQuestion.findUnique({
    where: { id: questionId },
    select: { section: { select: { courseId: true } } },
  });
  if (!question) return;
  await prisma.$transaction(async (tx) => {
    await tx.courseQuestion.delete({ where: { id: questionId } });
    await recomputeVideoReady(tx, question.section.courseId);
  });
}

// ---------------------------------------------------------------------------
// Makeup link
// ---------------------------------------------------------------------------

/**
 * Make this course a training cycle's online makeup (or unlink it with null).
 * Only a VIDEO course can be one: the no-skip player and the makeup access
 * check live on the video path. One course per cycle (unique column).
 */
export async function setMakeupCycle(courseId: string, cycleId: string | null, actorId: string): Promise<void> {
  await requireManager(actorId);
  await requireVideoCourse(prisma, courseId);
  if (cycleId) {
    const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { isTermTraining: true } });
    if (!cycle?.isTermTraining) throw new LearningValidationError("Choose a cycle that is its term's training.");
    const taken = await prisma.course.findUnique({ where: { makeupForCycleId: cycleId }, select: { id: true, title: true } });
    if (taken && taken.id !== courseId) {
      throw new LearningValidationError(`"${taken.title}" is already that cycle's makeup course.`);
    }
  }
  await prisma.course.update({ where: { id: courseId }, data: { makeupForCycleId: cycleId } });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.makeup_link",
    entityType: "Course",
    entityId: courseId,
    after: { makeupForCycleId: cycleId },
  });
}
