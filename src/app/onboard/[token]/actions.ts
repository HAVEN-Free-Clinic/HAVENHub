"use server";
import { submitContract, ContractError, ContractValidationError, type ContractSubmission } from "@/modules/recruitment/services/onboarding";

export type SubmitResult = { ok: true } | { ok: false; message: string; fieldErrors?: Record<string, string> };

export async function submitOnboarding(token: string, formData: FormData): Promise<SubmitResult> {
  const str = (k: string) => String(formData.get(k) ?? "").trim();
  const bool = (k: string) => formData.get(k) === "on";
  const dob = str("dateOfBirth");
  const hipaaAt = str("hipaaCompletedAt");
  const file = formData.get("hipaaFile");
  // Agreement signatures + custom-question answers are dynamic (their names come
  // from the frozen layout), so harvest them by prefix. MULTI_SELECT and
  // SUBCOMMITTEE_RANK submit the same name repeatedly -> collect those to an array.
  const signatures: Record<string, string> = {};
  const customAnswers: Record<string, string | string[]> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("sig__")) {
      signatures[k.slice(5)] = String(v).trim();
    } else if (k.startsWith("custom__")) {
      const key = k.slice(8);
      const val = String(v);
      if (key in customAnswers) customAnswers[key] = [...[customAnswers[key]].flat(), val];
      else customAnswers[key] = val;
    }
  }
  const input: ContractSubmission = {
    firstName: str("firstName"), lastName: str("lastName"), email: str("email"), netId: str("netId") || undefined, phone: str("phone") || undefined,
    dateOfBirth: dob || undefined, dietaryRestrictions: str("dietaryRestrictions") || undefined,
    yaleAffiliation: str("yaleAffiliation") || undefined, gradYear: str("gradYear") || undefined,
    initials: str("initials"), signatures, customAnswers,
    epicNeeded: bool("epicNeeded"), hasEpic: bool("hasEpic"), existingEpicId: str("existingEpicId") || undefined,
    epicAccessType: str("epicAccessType") || undefined, worksWithYnhh: bool("worksWithYnhh"),
    spanishSelfReported: bool("spanishSelfReported"), licensedRN: bool("licensedRN"),
    hipaaCompletedAt: hipaaAt || undefined,
    hipaaFile: file instanceof File && file.size > 0 ? { fileName: file.name, mimeType: file.type, bytes: Buffer.from(await file.arrayBuffer()) } : undefined,
  };
  try {
    await submitContract(token, input);
    return { ok: true };
  } catch (err) {
    if (err instanceof ContractValidationError) return { ok: false, message: err.message, fieldErrors: err.fieldErrors };
    if (err instanceof ContractError) return { ok: false, message: err.message };
    throw err;
  }
}
