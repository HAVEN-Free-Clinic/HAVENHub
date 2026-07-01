"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { markEhsComplete, unmarkEhsComplete } from "@/platform/ehs/services/completion";
import { setAddedToEhs } from "@/platform/ehs/services/flag";

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

export async function toggleAddedToEhsAction(formData: FormData): Promise<void> {
  const person = await requirePermission("volunteers.manage_compliance");
  const personId = String(formData.get("personId"));
  const value = formData.get("value") === "1";
  await setAddedToEhs(personId, value, person.personId);
  revalidatePath("/volunteers/ehs");
}
