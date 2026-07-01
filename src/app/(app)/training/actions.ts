"use server";
import type { Track } from "@prisma/client";
import { requirePersonSession } from "@/platform/auth/session";
import {
  submitQuiz,
  type TrainingIntake,
  TrainingStateError,
  QuizLockedError,
} from "@/modules/recruitment/services/training";

/** Serializable result the client quiz awaits — graded in place, no redirect. */
export type QuizActionResult =
  | {
      status: "graded";
      passed: boolean;
      percent: number;
      attemptsUsed: number;
      locked: boolean;
      /** Graded question key -> correct option value, for review highlighting. */
      correctByKey: Record<string, string>;
    }
  | { status: "error"; message: string };

/** Grade the signed-in member's quiz attempt and save their intake answers.
 *  Returns the result for in-place rendering; the page refreshes itself when the
 *  attempt is terminal (passed or locked) to re-render the clearance state. */
export async function gradeQuizAction(input: {
  track: Track;
  answers: Record<string, string>;
  intake: TrainingIntake;
}): Promise<QuizActionResult> {
  const person = await requirePersonSession();
  try {
    const result = await submitQuiz(person.personId, {
      track: input.track,
      answers: input.answers,
      intake: input.intake,
    });
    return {
      status: "graded",
      passed: result.passed,
      percent: result.percent,
      attemptsUsed: result.attemptsUsed,
      locked: result.locked,
      correctByKey: result.correctByKey,
    };
  } catch (err) {
    if (err instanceof QuizLockedError || err instanceof TrainingStateError) {
      return { status: "error", message: (err as Error).message };
    }
    throw err;
  }
}
