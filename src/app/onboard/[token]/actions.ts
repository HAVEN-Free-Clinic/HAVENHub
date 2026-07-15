"use server";
import { submitContract, ContractError, ContractValidationError, type ContractSubmission } from "@/modules/recruitment/services/onboarding";
import { collectSignatureInputs } from "@/modules/recruitment/contract/signatures";

export type SubmitResult = { ok: true } | { ok: false; message: string; fieldErrors?: Record<string, string> };

export async function submitOnboarding(token: string, formData: FormData): Promise<SubmitResult> {
  const str = (k: string) => String(formData.get(k) ?? "").trim();
  const bool = (k: string) => formData.get(k) === "on";
  const dob = str("dateOfBirth");
  const hipaaAt = str("hipaaCompletedAt");
  const file = formData.get("hipaaFile");
  // Custom-question answers are dynamic (their names come from the frozen
  // layout), so harvest them by prefix. MULTI_SELECT and SUBCOMMITTEE_RANK submit
  // the same name repeatedly -> collect those to an array.
  const customAnswers: Record<string, string | string[]> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("custom__")) {
      const key = k.slice(8);
      const val = String(v);
      if (key in customAnswers) customAnswers[key] = [...[customAnswers[key]].flat(), val];
      else customAnswers[key] = val;
    }
  }
  // Signatures (agreements + initials) arrive as sig__<id> data URLs with __method
  // / __name companions; group them by block id. FormData values can be File for
  // the HIPAA input, so coerce to string first.
  const signatures = collectSignatureInputs(
    [...formData.entries()].filter(([, v]) => typeof v === "string") as [string, string][],
  );
  const input: ContractSubmission = {
    firstName: str("firstName"), lastName: str("lastName"), email: str("email"), netId: str("netId") || undefined, phone: str("phone") || undefined,
    dateOfBirth: dob || undefined, dietaryRestrictions: str("dietaryRestrictions") || undefined,
    yaleAffiliation: str("yaleAffiliation") || undefined, gradYear: str("gradYear") || undefined,
    signatures, customAnswers,
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
