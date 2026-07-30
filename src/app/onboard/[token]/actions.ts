"use server";
import { submitContract, lookupStoredEpicId, ContractError, ContractValidationError, type ContractSubmission } from "@/modules/recruitment/services/onboarding";
import { collectSignatureInputs } from "@/modules/recruitment/contract/signatures";
import { buildOnboardingNextSteps, type OnboardingNextSteps } from "@/modules/recruitment/onboarding-next-steps";
import { formatTrainingDate, formatTrainingLocation } from "./training-date";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { prisma } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import { captureEvent } from "@/platform/posthog/capture";
import { activeTermGroup } from "@/platform/posthog/groups";

export type SubmitResult =
  | { ok: true; nextSteps: OnboardingNextSteps }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

/**
 * Resolve the "what happens next" content for a contract that just submitted.
 * epicNeeded/hasEpic come straight off the row submitContract just persisted
 * (resolveEpicNeeded already ran server-side there, so this never re-derives
 * it from the client's answers), and storedEpicId is looked up fresh the same
 * way the onboarding page and submitContract itself do. trainingDate/Location
 * are not columns on the contract (they live on the cycle), so they're
 * re-resolved here from the same acceptance -> application -> cycle chain the
 * page walks at render time; that chain cannot have changed in the moments
 * between page render and this submit.
 *
 * By the time this runs, submitContract has already durably flipped the
 * contract to SUBMITTED, so a failure anywhere in this function -- the three
 * lookups below OR building the content from their results -- must never
 * surface as a failed submission (same isolation saveCertificate uses for its
 * manager alerts: catch, log, continue). The try therefore encloses the
 * buildOnboardingNextSteps call too, not just the lookups: an earlier version
 * left that call outside the try, which was harmless only because every
 * field it touches happens to be non-optional today (contract.email is a
 * required column; trainingDate/trainingLocation/storedEpicId all had
 * defaults assigned before the call) -- a future nullable field or a throwing
 * change to buildOnboardingNextSteps would otherwise have escaped uncaught,
 * re-thrown past the ContractError/ContractValidationError checks in
 * submitOnboarding, and turned an already-successful submission into
 * "Something went wrong, please try again" on the client, with a resubmit
 * then hitting "already submitted" -- the exact dead end this task exists to
 * remove. The catch falls back to the same "nothing resolved" defaults
 * formatTrainingDate/lookupStoredEpicId use on their own null inputs, so the
 * completion screen degrades to generic-but-truthful content instead of
 * being lost.
 */
async function resolveNextSteps(
  contract: { acceptanceId: string; email: string; netId: string | null; epicNeeded: boolean; hasEpic: boolean },
): Promise<OnboardingNextSteps> {
  try {
    const [acceptance, zone, epicId] = await Promise.all([
      prisma.acceptance.findUnique({
        where: { id: contract.acceptanceId },
        select: { application: { select: { cycle: { select: { inPersonTrainingDate: true, trainingLocation: true } } } } },
      }),
      getDisplayTimeZone(),
      lookupStoredEpicId(contract.netId, contract.email),
    ]);
    const cycle = acceptance?.application?.cycle ?? null;
    return buildOnboardingNextSteps({
      email: contract.email,
      trainingDate: formatTrainingDate(cycle?.inPersonTrainingDate ?? null, zone),
      trainingLocation: formatTrainingLocation(cycle?.trainingLocation ?? null),
      epicNeeded: contract.epicNeeded,
      storedEpicId: epicId,
      hasEpic: contract.hasEpic,
    });
  } catch (err) {
    log.error("[onboarding] failed to resolve next-steps detail; showing generic completion content", errorAttrs(err));
    return buildOnboardingNextSteps({
      email: contract.email,
      trainingDate: "the scheduled training date",
      trainingLocation: "",
      epicNeeded: contract.epicNeeded,
      storedEpicId: null,
      hasEpic: contract.hasEpic,
    });
  }
}

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
  // Checkbox-confirmed agreements (confirmKind: "checkbox") arrive as
  // confirm__<id> checkbox fields; harvest them the same way as custom answers.
  const confirmations: Record<string, boolean> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("confirm__")) confirmations[k.slice(9)] = v === "on";
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
    pronouns: str("pronouns") || undefined, staffTitle: str("staffTitle") || undefined,
    epicIdExpiration: str("epicIdExpiration") || undefined,
    signatures, customAnswers, confirmations,
    // Epic access type is no longer collected: IT decides the account
    // modification type, not the applicant.
    hasEpic: bool("hasEpic"), existingEpicId: str("existingEpicId") || undefined,
    worksWithYnhh: bool("worksWithYnhh"),
    spanishSelfReported: bool("spanishSelfReported"), licensedRN: bool("licensedRN"),
    hipaaCompletedAt: hipaaAt || undefined,
    hipaaFile: file instanceof File && file.size > 0 ? { fileName: file.name, mimeType: file.type, bytes: Buffer.from(await file.arrayBuffer()) } : undefined,
  };
  try {
    const contract = await submitContract(token, input);
    await captureEvent({
      event: "onboarding_contract_submitted",
      distinctId: contract.email,
      groups: await activeTermGroup(),
    });
    const nextSteps = await resolveNextSteps(contract);
    return { ok: true, nextSteps };
  } catch (err) {
    if (err instanceof ContractValidationError) return { ok: false, message: err.message, fieldErrors: err.fieldErrors };
    if (err instanceof ContractError) return { ok: false, message: err.message };
    throw err;
  }
}
