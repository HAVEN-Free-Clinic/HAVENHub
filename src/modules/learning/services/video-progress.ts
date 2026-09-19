/**
 * A learner working through a VIDEO course: who may open it, where they stand,
 * the watch heartbeat, and the section quizzes.
 *
 * Two kinds of VIDEO course take two authorization paths. An ordinary one is
 * assigned like any course (isCourseAssignedTo) and records progress by the
 * course's recurrence, exactly like SCORM. A training cycle's makeup course is
 * assigned to no one: platform/training/standing.ts says who owes it, progress
 * is recorded against the cycle's term, three failed tries on a section lock
 * it (a director resets that from the training roster), and finishing it is
 * what credits the morning session.
 */
import type { Prisma } from "@prisma/client";
import { prisma, runSerializable, type TransactionClient } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { gradeQuiz } from "@/platform/quiz/grading";
import { captureEvent } from "@/platform/posthog/capture";
import { getMakeupAccess, lockMakeup, recomputeTrainingStanding, type MakeupAccess } from "@/platform/training/standing";
import { acceptHeartbeat, sectionLength } from "../engine/watch";
import { attemptsInWindow, sectionStates, type SectionState } from "../engine/video-course";
import { activeTermId, isCourseAssignedTo, resolveProgressTermId, type LearnerStatus } from "./enrollment";
import { LearningAuthError, LearningValidationError, MakeupLockedError, MakeupNotOwedError } from "./errors";

type Db = typeof prisma | TransactionClient;

type VideoContext = {
  courseId: string;
  termId: string;
  makeup: { cycleId: string; access: MakeupAccess } | null;
};

/**
 * Decide whether `personId` may work on this VIDEO course and which term their
 * progress belongs to. Throws LearningAuthError (MakeupNotOwedError for a
 * makeup course they do not owe) when they may not.
 */
async function resolveContext(personId: string, courseId: string): Promise<VideoContext> {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { id: true, kind: true, isActive: true, videoReady: true, recurrence: true, makeupForCycleId: true },
  });
  if (!course || course.kind !== "VIDEO") throw new LearningAuthError("This course is not assigned to you.");

  if (course.makeupForCycleId) {
    if (!course.isActive || !course.videoReady) {
      throw new LearningAuthError("The makeup course is not open yet.");
    }
    const access = await getMakeupAccess(personId, course.makeupForCycleId);
    if (access.status === "NOT_OWED") throw new MakeupNotOwedError();
    return { courseId, termId: access.termId, makeup: { cycleId: course.makeupForCycleId, access } };
  }

  // isCourseAssignedTo checks active + ready + scope + audience, the same
  // resolver the learning gate uses.
  if (!(await isCourseAssignedTo(personId, courseId))) {
    throw new LearningAuthError("This course is not assigned to you.");
  }
  const active = await activeTermId();
  if (!active) throw new LearningValidationError("No active term to record progress against.");
  const termId = await resolveProgressTermId(prisma, personId, courseId, course.recurrence, active);
  return { courseId, termId, makeup: null };
}

type LoadedSection = {
  id: string;
  title: string;
  startSeconds: number;
  endSeconds: number | null;
  passPercent: number;
  maxAttempts: number;
  video: { id: string; durationSeconds: number | null; captionsKey: string | null } | null;
  questions: { id: string; prompt: string; options: Prisma.JsonValue; correctValue: string | null }[];
};

async function loadSections(db: Db, courseId: string): Promise<LoadedSection[]> {
  return db.courseSection.findMany({
    where: { courseId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      startSeconds: true,
      endSeconds: true,
      passPercent: true,
      maxAttempts: true,
      video: { select: { id: true, durationSeconds: true, captionsKey: true } },
      questions: {
        orderBy: { position: "asc" },
        select: { id: true, prompt: true, options: true, correctValue: true },
      },
    },
  });
}

async function loadProgress(db: Db, personId: string, courseId: string, termId: string) {
  return db.sectionProgress.findMany({
    where: { personId, courseId, termId },
    select: {
      id: true,
      sectionId: true,
      watchedSeconds: true,
      lastHeartbeatAt: true,
      watchedAt: true,
      passedAt: true,
      attempts: { select: { takenAt: true } },
    },
  });
}

function optionsOf(raw: Prisma.JsonValue): { value: string; label: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is { value: string; label: string } =>
      !!o && typeof o === "object" && typeof (o as { value?: unknown }).value === "string" && typeof (o as { label?: unknown }).label === "string"
  );
}

export type LearnerVideoSection = {
  id: string;
  title: string;
  videoId: string | null;
  hasCaptions: boolean;
  /** Where the section starts inside its video, in seconds. */
  startSeconds: number;
  /** The section's length in seconds (0 only for a course that is not ready). */
  length: number;
  /** The furthest point the server has credited, seconds from the start. */
  watchedSeconds: number;
  state: SectionState;
  /** Never carries the answer key: this goes straight to a client component. */
  questions: { id: string; prompt: string; options: { value: string; label: string }[] }[];
  passPercent: number;
  attemptsUsed: number;
  /** Null when attempts are unlimited (an ordinary course). */
  maxAttempts: number | null;
};

export type LearnerVideoCourse = {
  id: string;
  title: string;
  description: string | null;
  status: LearnerStatus;
  isMakeup: boolean;
  /** Every section passed: the page offers review, not work. */
  complete: boolean;
  /** Makeup only: locked after too many failed attempts. */
  locked: boolean;
  sections: LearnerVideoSection[];
};

/** The whole course as this learner sees it. */
export async function getVideoCourseForLearner(personId: string, courseId: string): Promise<LearnerVideoCourse> {
  const ctx = await resolveContext(personId, courseId);
  const [course, sections, progress, rollup] = await Promise.all([
    prisma.course.findUniqueOrThrow({ where: { id: courseId }, select: { id: true, title: true, description: true } }),
    loadSections(prisma, courseId),
    loadProgress(prisma, personId, courseId, ctx.termId),
    prisma.courseProgress.findUnique({
      where: { personId_courseId_termId: { personId, courseId, termId: ctx.termId } },
      select: { status: true },
    }),
  ]);
  const byId = new Map(progress.map((p) => [p.sectionId, p]));
  const states = sectionStates(sections, byId);
  const lockResetAt = ctx.makeup?.access.lockResetAt ?? null;
  const complete = rollup?.status === "COMPLETE" || ctx.makeup?.access.status === "DONE";

  return {
    id: course.id,
    title: course.title,
    description: course.description,
    status: complete ? "COMPLETE" : rollup ? "IN_PROGRESS" : "NOT_STARTED",
    isMakeup: ctx.makeup != null,
    complete,
    locked: ctx.makeup?.access.locked ?? false,
    sections: sections.map((s, i) => {
      const p = byId.get(s.id);
      return {
        id: s.id,
        title: s.title,
        videoId: s.video?.id ?? null,
        hasCaptions: s.video?.captionsKey != null,
        startSeconds: s.startSeconds,
        length: (s.video ? sectionLength(s, s.video.durationSeconds) : null) ?? 0,
        watchedSeconds: p?.watchedSeconds ?? 0,
        state: states[i],
        questions: s.questions.map((q) => ({ id: q.id, prompt: q.prompt, options: optionsOf(q.options) })),
        passPercent: s.passPercent,
        attemptsUsed: p ? attemptsInWindow(p.attempts, lockResetAt) : 0,
        maxAttempts: ctx.makeup ? s.maxAttempts : null,
      };
    }),
  };
}

/**
 * Credit watch time for one section. `reportedSeconds` is where the player
 * says it has reached (seconds from the section's start); the server accepts
 * only as much of it as real time allows (engine/watch.ts). Returns the
 * credited position so the player can pull its seek limit back to match.
 */
export async function recordSectionHeartbeat(
  personId: string,
  courseId: string,
  sectionId: string,
  reportedSeconds: number
): Promise<{ watchedSeconds: number; complete: boolean }> {
  const ctx = await resolveContext(personId, courseId);
  const sections = await loadSections(prisma, courseId);
  const section = sections.find((s) => s.id === sectionId);
  if (!section?.video) throw new LearningValidationError("This section is not part of the course.");
  const length = sectionLength(section, section.video.durationSeconds);
  if (length == null) throw new LearningValidationError("This section is not ready yet.");

  return runSerializable(async (tx) => {
    const progress = await loadProgress(tx, personId, courseId, ctx.termId);
    const byId = new Map(progress.map((p) => [p.sectionId, p]));
    const state = sectionStates(sections, byId).find((s) => s.id === sectionId);
    if (!state?.unlocked) throw new LearningValidationError("Finish the earlier sections first.");

    const row = byId.get(sectionId);
    const now = new Date();
    const result = acceptHeartbeat({
      storedSeconds: row?.watchedSeconds ?? 0,
      lastHeartbeatAt: row?.lastHeartbeatAt ?? null,
      reportedSeconds,
      now,
      length,
    });
    // watchedAt latches: a section once watched stays watched.
    const watchedAt = row?.watchedAt ?? (result.complete ? now : null);
    const data = { watchedSeconds: result.watchedSeconds, lastHeartbeatAt: now, watchedAt };
    await tx.sectionProgress.upsert({
      where: { personId_sectionId_termId: { personId, sectionId, termId: ctx.termId } },
      create: { personId, courseId, sectionId, termId: ctx.termId, ...data },
      update: data,
    });
    // The course rollup exists from the first heartbeat, so the dashboard and
    // "My courses" read the course as started.
    await tx.courseProgress.upsert({
      where: { personId_courseId_termId: { personId, courseId, termId: ctx.termId } },
      create: { personId, courseId, termId: ctx.termId, status: "IN_PROGRESS", lessonStatus: "incomplete" },
      update: {},
    });
    return { watchedSeconds: result.watchedSeconds, complete: watchedAt != null };
  });
}

export type SectionQuizResult = {
  score: number;
  total: number;
  percent: number;
  passed: boolean;
  attemptsUsed: number;
  maxAttempts: number | null;
  locked: boolean;
  /** Graded question id -> whether the answer was right. Never the answer. */
  verdictByKey: Record<string, "correct" | "wrong">;
  courseComplete: boolean;
};

/** Grade one attempt at a section's quiz. */
export async function submitSectionQuiz(
  personId: string,
  courseId: string,
  sectionId: string,
  rawAnswers: Record<string, unknown>
): Promise<SectionQuizResult> {
  const ctx = await resolveContext(personId, courseId);
  if (ctx.makeup?.access.status === "DONE") throw new LearningValidationError("You have already finished this course.");
  if (ctx.makeup?.access.locked) throw new MakeupLockedError();

  const sections = await loadSections(prisma, courseId);
  const section = sections.find((s) => s.id === sectionId);
  if (!section) throw new LearningValidationError("This section is not part of the course.");

  // Keep only this section's questions, and only string answers.
  const answers: Record<string, string> = {};
  for (const q of section.questions) {
    const a = rawAnswers[q.id];
    if (typeof a === "string") answers[q.id] = a;
  }
  const graded = section.questions.map((q) => ({ key: q.id, correctValue: q.correctValue }));
  const makeup = ctx.makeup;

  const outcome = await runSerializable(async (tx) => {
    const progress = await loadProgress(tx, personId, courseId, ctx.termId);
    const byId = new Map(progress.map((p) => [p.sectionId, p]));
    const state = sectionStates(sections, byId).find((s) => s.id === sectionId);
    if (!state?.unlocked) throw new LearningValidationError("Finish the earlier sections first.");
    if (state.passed) throw new LearningValidationError("You have already passed this section.");
    const row = byId.get(sectionId);
    if (!state.watched || !row) throw new LearningValidationError("Watch the whole video before taking the quiz.");

    const result = gradeQuiz(graded, answers, section.passPercent);
    const now = new Date();
    await tx.sectionQuizAttempt.create({
      data: { progressId: row.id, answers, score: result.score, total: result.total, passed: result.passed, takenAt: now },
    });
    const attemptsUsed = attemptsInWindow([...row.attempts, { takenAt: now }], makeup?.access.lockResetAt ?? null);

    let locked = false;
    let courseComplete = false;
    if (result.passed) {
      await tx.sectionProgress.update({ where: { id: row.id }, data: { passedAt: now } });
      byId.set(sectionId, { ...row, passedAt: now });
      courseComplete = sectionStates(sections, byId).every((s) => s.passed);
      if (courseComplete) {
        await completeCourse(tx, personId, courseId, ctx.termId);
        if (makeup) {
          await recomputeTrainingStanding(tx, { personId, termId: ctx.termId, track: makeup.access.track });
        }
      }
    } else if (makeup && attemptsUsed >= section.maxAttempts) {
      await lockMakeup(tx, personId, makeup.cycleId);
      locked = true;
    }

    const verdictByKey = Object.fromEntries(
      graded
        .filter((q) => q.correctValue !== null)
        .map((q) => [q.key, answers[q.key] === q.correctValue ? "correct" : "wrong"] as const)
    );
    return {
      score: result.score,
      total: result.total,
      percent: result.percent,
      passed: result.passed,
      attemptsUsed,
      maxAttempts: makeup ? section.maxAttempts : null,
      locked,
      verdictByKey,
      courseComplete,
    };
  });

  if (outcome.courseComplete) {
    await captureEvent({
      event: "course_completed",
      distinctId: personId,
      properties: { course_id: courseId, course_kind: "VIDEO", makeup: makeup != null },
    }).catch(() => undefined);
  }
  return outcome;
}

/**
 * Write the course rollup COMPLETE for the term, latching completedAt. The
 * score is the average of each section's best passing percentage, which is
 * what a director reading the dashboard would expect "score" to mean.
 */
async function completeCourse(tx: TransactionClient, personId: string, courseId: string, termId: string): Promise<void> {
  const passes = await tx.sectionQuizAttempt.findMany({
    where: { passed: true, progress: { personId, courseId, termId } },
    select: { progressId: true, score: true, total: true },
  });
  const best = new Map<string, number>();
  for (const a of passes) {
    const pct = a.total > 0 ? (100 * a.score) / a.total : 0;
    best.set(a.progressId, Math.max(best.get(a.progressId) ?? 0, pct));
  }
  const scores = [...best.values()];
  const scoreRaw = scores.length ? Math.round(scores.reduce((sum, v) => sum + v, 0) / scores.length) : null;
  const existing = await tx.courseProgress.findUnique({
    where: { personId_courseId_termId: { personId, courseId, termId } },
    select: { completedAt: true },
  });
  const data = {
    status: "COMPLETE" as const,
    completedAt: existing?.completedAt ?? new Date(),
    lessonStatus: "completed",
    scoreRaw,
  };
  await tx.courseProgress.upsert({
    where: { personId_courseId_termId: { personId, courseId, termId } },
    create: { personId, courseId, termId, ...data },
    update: data,
  });
}

/**
 * The stored object behind a video (or its captions) if `personId` may see it:
 * a course manager, or a learner the course is open to. Null otherwise. The
 * serving routes use this so a video URL is never a way around the course's
 * own authorization.
 */
export async function authorizeVideoFile(
  personId: string,
  videoId: string
): Promise<{ storageKey: string; contentType: string; captionsKey: string | null } | null> {
  const video = await prisma.courseVideo.findUnique({
    where: { id: videoId },
    select: { courseId: true, storageKey: true, contentType: true, captionsKey: true },
  });
  if (!video) return null;
  const file = { storageKey: video.storageKey, contentType: video.contentType, captionsKey: video.captionsKey };
  if (await can(personId, "learning.manage_courses")) return file;
  try {
    await resolveContext(personId, video.courseId);
    return file;
  } catch (err) {
    if (err instanceof LearningAuthError || err instanceof LearningValidationError) return null;
    throw err;
  }
}
