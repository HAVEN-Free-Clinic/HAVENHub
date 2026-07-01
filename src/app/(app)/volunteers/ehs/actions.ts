"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { markEhsComplete, unmarkEhsComplete } from "@/modules/ehs/services/completion";

export async function toggleEhsCompletionAction(formData: FormData): Promise<void> {
  const person = await requirePermission("volunteers.manage_compliance");
  const personId = String(formData.get("personId"));
  const trainingId = String(formData.get("trainingId"));
  const nowComplete = formData.get("complete") === "1";
  if (nowComplete) {
    await markEhsComplete(personId, trainingId, person.personId);
  } else {
    await unmarkEhsComplete(personId, trainingId, person.personId);
  }
  revalidatePath("/volunteers/ehs");
}
