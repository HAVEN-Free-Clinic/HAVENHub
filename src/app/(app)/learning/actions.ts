"use server";
import { requirePermission, requirePersonSession } from "@/platform/auth/session";
import { persistScoCmi, type CmiSnapshot } from "@/modules/learning/services/enrollment";
import { submitSectionQuiz, type SectionQuizResult } from "@/modules/learning/services/video-progress";
import { LearningAuthError, LearningValidationError, MakeupLockedError } from "@/modules/learning/services/errors";

/** Called from the SCORM player (client) on each commit/finish, per SCO. */
export async function persistCmiAction(courseId: string, scoId: string, cmi: CmiSnapshot): Promise<void> {
  const person = await requirePermission("learning.access");
  await persistScoCmi(person.personId, courseId, scoId, cmi);
}

/**
 * Grade one attempt at a video section's quiz.
 *
 * requirePersonSession, not requirePermission("learning.access"): a training
 * makeup course is a training requirement rather than an assigned course, and
 * the service authorizes it through platform/training/standing.ts. Thrown
 * Server Action errors are redacted in production, so domain failures come
 * back as a message instead.
 */
export async function submitSectionQuizAction(input: {
  courseId: string;
  sectionId: string;
  answers: Record<string, string>;
}): Promise<SectionQuizResult | { error: string }> {
  const person = await requirePersonSession();
  try {
    return await submitSectionQuiz(person.personId, input.courseId, input.sectionId, input.answers);
  } catch (err) {
    if (err instanceof MakeupLockedError || err instanceof LearningValidationError || err instanceof LearningAuthError) {
      return { error: err.message };
    }
    throw err;
  }
}
