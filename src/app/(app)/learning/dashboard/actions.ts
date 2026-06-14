"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { resetCourseProgress } from "@/modules/learning/services/dashboard";

export async function resetCourseProgressAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  await resetCourseProgress(String(formData.get("personId")), String(formData.get("courseId")), person.personId);
  revalidatePath("/learning/dashboard");
}
