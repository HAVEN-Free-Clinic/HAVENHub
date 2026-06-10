"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { markModuleComplete, submitCourseQuiz } from "@/modules/learning/services/enrollment";

export async function markModuleCompleteAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.access");
  const moduleId = String(formData.get("moduleId"));
  const courseId = String(formData.get("courseId"));
  await markModuleComplete(person.personId, moduleId);
  revalidatePath(`/learning/${courseId}`);
}

export async function submitCourseQuizAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.access");
  const moduleId = String(formData.get("moduleId"));
  const courseId = String(formData.get("courseId"));
  const answers: Record<string, string> = {};
  for (const [name, value] of formData.entries()) {
    if (name.startsWith("q:")) answers[name.slice(2)] = String(value);
  }
  await submitCourseQuiz(person.personId, moduleId, answers);
  revalidatePath(`/learning/${courseId}`);
}
