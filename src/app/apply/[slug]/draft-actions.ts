// src/app/apply/[slug]/draft-actions.ts
"use server";
import { getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";
import { saveDraft, uploadDraftFile, DraftError } from "@/modules/recruitment/services/drafts";
import type { ApplicantType } from "@/modules/recruitment/engine/visibility";

export async function saveDraftAction(
  slug: string,
  payload: { answers: Record<string, unknown>; applicantType?: ApplicantType; renewalDepartment?: string | null },
): Promise<{ ok: boolean }> {
  const identity = await getApplicantIdentity();
  if (!identity) return { ok: false };
  try {
    await saveDraft(slug, identity, payload);
    return { ok: true };
  } catch (err) {
    if (err instanceof DraftError) return { ok: false };
    throw err;
  }
}

export async function uploadDraftFileAction(
  slug: string,
  fieldKey: string,
  formData: FormData,
): Promise<{ ok: boolean; fileName?: string; error?: string }> {
  const identity = await getApplicantIdentity();
  if (!identity) return { ok: false, error: "Please sign in again." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "No file." };
  try {
    const res = await uploadDraftFile(slug, identity, fieldKey, { fileName: file.name, mimeType: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
    return { ok: true, fileName: res.fileName };
  } catch (err) {
    if (err instanceof DraftError) return { ok: false, error: err.message };
    throw err;
  }
}
