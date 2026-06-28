"use server";
import { submitContract, ContractError, ContractValidationError, type ContractSubmission } from "@/modules/recruitment/services/onboarding";

export type SubmitResult = { ok: true } | { ok: false; message: string; fieldErrors?: Record<string, string> };

export async function submitOnboarding(token: string, formData: FormData): Promise<SubmitResult> {
  const str = (k: string) => String(formData.get(k) ?? "").trim();
  const bool = (k: string) => formData.get(k) === "on";
  const dob = str("dateOfBirth");
  const hipaaAt = str("hipaaCompletedAt");
  const file = formData.get("hipaaFile");
  const input: ContractSubmission = {
    firstName: str("firstName"), lastName: str("lastName"), email: str("email"), netId: str("netId") || undefined, phone: str("phone") || undefined,
    dateOfBirth: dob ? new Date(dob) : undefined, dietaryRestrictions: str("dietaryRestrictions") || undefined,
    yaleAffiliation: str("yaleAffiliation") || undefined, gradYear: str("gradYear") || undefined,
    agreementSignature: str("agreementSignature"), professionalismSignature: str("professionalismSignature"),
    trainingSignature: str("trainingSignature"), initials: str("initials"),
    epicNeeded: bool("epicNeeded"), hasEpic: bool("hasEpic"), existingEpicId: str("existingEpicId") || undefined,
    epicAccessType: str("epicAccessType") || undefined, worksWithYnhh: bool("worksWithYnhh"),
    spanishSelfReported: bool("spanishSelfReported"), licensedRN: bool("licensedRN"),
    hipaaCompletedAt: hipaaAt ? new Date(hipaaAt) : undefined,
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
