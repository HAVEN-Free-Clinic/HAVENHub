"use server";
import { requirePermission } from "@/platform/auth/session";
import { runAction } from "@/platform/actions";
import { LearningValidationError } from "@/modules/learning/services/errors";
import {
  addQuestion,
  clearVideoCaptions,
  createSection,
  deleteCourseVideo,
  deleteQuestion,
  deleteSection,
  moveSection,
  parseOptionsText,
  registerCourseVideo,
  setMakeupCycle,
  setVideoCaptions,
  updateQuestion,
  updateSection,
} from "@/modules/learning/services/video-courses";
import { parseTimestamp } from "@/modules/learning/engine/watch";

/** Where every form on the course editor returns to. */
function editPath(courseId: string, saved: string): string {
  return `/learning/manage/${courseId}?saved=${saved}`;
}

function errorPath(courseId: string): (m: string) => string {
  return (m) => `/learning/manage/${courseId}?error=${encodeURIComponent(m)}`;
}

/** Read a timestamp field, turning a malformed entry into a domain error. */
function timestampField(formData: FormData, name: string, label: string): number | null {
  const parsed = parseTimestamp(String(formData.get(name) ?? ""));
  if (parsed === undefined) {
    throw new LearningValidationError(`${label} must look like 90, 1:30, or 1:02:03.`);
  }
  return parsed;
}

function intField(formData: FormData, name: string, fallback: number): number {
  const raw = Number(formData.get(name));
  return Number.isFinite(raw) ? Math.round(raw) : fallback;
}

/** Register a video the browser uploaded straight to storage. */
export async function registerVideoAction(input: {
  courseId: string;
  key: string;
  fileName: string;
  contentType: string;
  durationSeconds: number | null;
}): Promise<{ error: string } | null> {
  const person = await requirePermission("learning.manage_courses");
  try {
    await registerCourseVideo(input.courseId, input, person.personId);
  } catch (err) {
    if (err instanceof LearningValidationError) return { error: err.message };
    throw err;
  }
  return null;
}

/** Attach captions the browser uploaded straight to storage. */
export async function setCaptionsAction(input: {
  videoId: string;
  key: string;
  fileName: string;
}): Promise<{ error: string } | null> {
  const person = await requirePermission("learning.manage_courses");
  try {
    await setVideoCaptions(input.videoId, { key: input.key, fileName: input.fileName }, person.personId);
  } catch (err) {
    if (err instanceof LearningValidationError) return { error: err.message };
    throw err;
  }
  return null;
}

export async function clearCaptionsAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  await runAction({
    work: () => clearVideoCaptions(String(formData.get("videoId")), person.personId),
    domainErrors: [LearningValidationError],
    errorRedirect: errorPath(courseId),
    successRedirect: editPath(courseId, "captions"),
  });
}

export async function deleteVideoAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  await runAction({
    work: () => deleteCourseVideo(String(formData.get("videoId")), person.personId),
    domainErrors: [LearningValidationError],
    errorRedirect: errorPath(courseId),
    successRedirect: editPath(courseId, "video"),
  });
}

export async function createSectionAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  await runAction({
    work: async () => {
      await createSection(courseId, String(formData.get("title") ?? ""), person.personId);
    },
    domainErrors: [LearningValidationError],
    errorRedirect: errorPath(courseId),
    successRedirect: editPath(courseId, "section"),
  });
}

export async function updateSectionAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  await runAction({
    work: async () => {
      const start = timestampField(formData, "startSeconds", "Start time") ?? 0;
      const end = timestampField(formData, "endSeconds", "End time");
      await updateSection(
        String(formData.get("sectionId")),
        {
          title: String(formData.get("title") ?? ""),
          videoId: String(formData.get("videoId") ?? "") || null,
          startSeconds: start,
          endSeconds: end,
          passPercent: intField(formData, "passPercent", 80),
          maxAttempts: intField(formData, "maxAttempts", 3),
        },
        person.personId
      );
    },
    domainErrors: [LearningValidationError],
    errorRedirect: errorPath(courseId),
    successRedirect: editPath(courseId, "section"),
  });
}

export async function deleteSectionAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  await runAction({
    work: () => deleteSection(String(formData.get("sectionId")), person.personId),
    domainErrors: [LearningValidationError],
    errorRedirect: errorPath(courseId),
    successRedirect: editPath(courseId, "section"),
  });
}

export async function moveSectionAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  const direction = formData.get("direction") === "up" ? "up" : "down";
  await runAction({
    work: () => moveSection(String(formData.get("sectionId")), direction, person.personId),
    domainErrors: [LearningValidationError],
    errorRedirect: errorPath(courseId),
    successRedirect: editPath(courseId, "section"),
  });
}

/** Add or edit one question. Choices come in as one per line, the right answer
 *  marked with a leading "*" (see parseOptionsText). */
export async function saveQuestionAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  const questionId = String(formData.get("questionId") ?? "");
  await runAction({
    work: async () => {
      const parsed = parseOptionsText(String(formData.get("options") ?? ""));
      if (parsed.starred > 1) {
        throw new LearningValidationError("Mark exactly one choice with * as the right answer.");
      }
      const input = {
        prompt: String(formData.get("prompt") ?? ""),
        options: parsed.options,
        correctIndex: parsed.correctIndex,
      };
      if (questionId) await updateQuestion(questionId, input, person.personId);
      else await addQuestion(String(formData.get("sectionId")), input, person.personId);
    },
    domainErrors: [LearningValidationError],
    errorRedirect: errorPath(courseId),
    successRedirect: editPath(courseId, "question"),
  });
}

export async function deleteQuestionAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  await runAction({
    work: () => deleteQuestion(String(formData.get("questionId")), person.personId),
    domainErrors: [LearningValidationError],
    errorRedirect: errorPath(courseId),
    successRedirect: editPath(courseId, "question"),
  });
}

export async function setMakeupCycleAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  const cycleId = String(formData.get("cycleId") ?? "") || null;
  await runAction({
    work: () => setMakeupCycle(courseId, cycleId, person.personId),
    domainErrors: [LearningValidationError],
    errorRedirect: errorPath(courseId),
    successRedirect: editPath(courseId, "makeup"),
  });
}
