"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { resetCourseQuiz } from "@/modules/learning/services/dashboard";

export async function resetCourseQuizAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  await resetCourseQuiz(String(formData.get("personId")), String(formData.get("moduleId")), person.personId);
  revalidatePath("/learning/dashboard");
}
