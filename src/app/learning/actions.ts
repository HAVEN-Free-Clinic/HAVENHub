"use server";
import { requirePermission } from "@/platform/auth/session";
import { persistCmi, type CmiSnapshot } from "@/modules/learning/services/enrollment";

/** Called from the SCORM player (client) on each commit/finish. */
export async function persistCmiAction(courseId: string, cmi: CmiSnapshot): Promise<void> {
  const person = await requirePermission("learning.access");
  await persistCmi(person.personId, courseId, cmi);
}
