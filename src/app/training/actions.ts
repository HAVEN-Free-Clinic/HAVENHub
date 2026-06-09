"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import {
  submitQuiz,
  TrainingStateError,
  QuizLockedError,
} from "@/modules/recruitment/services/training";

export async function submitQuizAction(formData: FormData) {
  const person = await requirePersonSession();

  const answers: Record<string, string> = {};
  for (const [name, value] of formData.entries()) {
    if (name.startsWith("q:")) answers[name.slice(2)] = String(value);
  }
  const intake = {
    subcommitteeInterest: (formData.get("subcommitteeInterest") as string) || null,
    additionalShiftAvailability: (formData.get("additionalShiftAvailability") as string) || null,
    minShiftsWanted: (formData.get("minShiftsWanted") as string) || null,
    feedback: (formData.get("feedback") as string) || null,
  };

  let result;
  try {
    result = await submitQuiz(person.personId, { answers, intake });
  } catch (err) {
    if (err instanceof QuizLockedError || err instanceof TrainingStateError) {
      redirect(`/training?err=${encodeURIComponent((err as Error).message)}`);
    }
    throw err;
  }
  redirect(
    `/training?${new URLSearchParams(
      result.passed ? { passed: "1" } : { score: String(result.percent) }
    ).toString()}`
  );
}
