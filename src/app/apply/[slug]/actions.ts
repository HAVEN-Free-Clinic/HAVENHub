"use server";
import {
  submitApplication, CycleNotOpenError, DuplicateApplicationError, SubmissionValidationError,
  type UploadedFile,
} from "@/modules/recruitment/services/submissions";
import type { ApplicantType } from "@/modules/recruitment/engine/visibility";

export type SubmitResult =
  | { ok: true }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

export async function submitPublicApplication(slug: string, formData: FormData): Promise<SubmitResult> {
  const applicantType = (String(formData.get("__applicantType") ?? "NEW") as ApplicantType);
  const renewalDepartment = String(formData.get("__renewalDepartment") ?? "") || undefined;

  const answers: Record<string, unknown> = {};
  const files: Record<string, UploadedFile> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("__")) continue;
    if (value instanceof File) {
      if (value.size > 0) files[key] = { fileName: value.name, mimeType: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
    } else {
      if (key in answers) {
        const prev = answers[key];
        answers[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
      } else {
        answers[key] = value;
      }
    }
  }

  try {
    await submitApplication(slug, { applicantType, renewalDepartment, answers, files });
    return { ok: true };
  } catch (err) {
    if (err instanceof SubmissionValidationError) return { ok: false, message: err.message, fieldErrors: err.fieldErrors };
    if (err instanceof DuplicateApplicationError) return { ok: false, message: err.message };
    if (err instanceof CycleNotOpenError) return { ok: false, message: err.message };
    throw err;
  }
}
