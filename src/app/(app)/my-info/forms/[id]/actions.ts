"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireModuleAccess } from "@/platform/auth/session";
import { submitResponse, FormError } from "@/modules/forms/service";
import type { Answers } from "@/modules/forms/layout";

export type SubmitState = { problems: string[] } | null;

/**
 * Submits the signed-in person's answers. Returns problems instead of
 * redirecting so a refused submission keeps everything they typed on screen.
 * The respondent is always the session's person, never a form value.
 */
export async function submitFormAction(formId: string, _prev: SubmitState, formData: FormData): Promise<SubmitState> {
  const person = await requireModuleAccess("my-info");
  let raw: Answers;
  try {
    const parsed = JSON.parse(String(formData.get("answers") ?? "{}"));
    raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { problems: ["Your answers could not be read. Reload and try again."] };
  }
  try {
    await submitResponse(person.personId, formId, raw);
  } catch (err) {
    if (err instanceof FormError) return { problems: err.problems };
    throw err;
  }
  revalidatePath(`/my-info/forms/${formId}`);
  revalidatePath("/my-info/forms");
  revalidatePath("/");
  redirect(`/my-info/forms/${formId}?submitted=1`);
}
