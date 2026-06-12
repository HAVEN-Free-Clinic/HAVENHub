"use server";
import { requirePermission } from "@/platform/auth/session";
import { persistScoCmi, type CmiSnapshot } from "@/modules/learning/services/enrollment";

/** Called from the SCORM player (client) on each commit/finish, per SCO. */
export async function persistCmiAction(courseId: string, scoId: string, cmi: CmiSnapshot): Promise<void> {
  const person = await requirePermission("learning.access");
  await persistScoCmi(person.personId, courseId, scoId, cmi);
}
