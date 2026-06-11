"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { persistCmi, type CmiSnapshot } from "@/modules/learning/services/enrollment";

export async function persistCmiAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.access");
  const courseId = String(formData.get("courseId"));
  const cmi: CmiSnapshot = {
    lessonStatus: formData.get("lessonStatus") ? String(formData.get("lessonStatus")) : null,
    scoreRaw: formData.get("scoreRaw") ? Number(formData.get("scoreRaw")) : null,
    suspendData: formData.get("suspendData") ? String(formData.get("suspendData")) : null,
    lessonLocation: formData.get("lessonLocation") ? String(formData.get("lessonLocation")) : null,
  };
  await persistCmi(person.personId, courseId, cmi);
  revalidatePath(`/learning/${courseId}`);
}
