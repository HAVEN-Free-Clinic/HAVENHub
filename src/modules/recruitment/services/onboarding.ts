import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OnboardingContract } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { getSetting } from "@/platform/settings/service";
import { putObject, deleteObject } from "@/platform/storage";
import { queueEmail } from "@/platform/email/send";
import { recordAudit } from "@/platform/audit";
import { parseCompletionDate, CompletionDateError } from "@/platform/compliance/completion-date";
import { RecruitmentAuthError } from "./review";
import { renderCycleEmail } from "../email/render";

export class ContractError extends Error {
  constructor(message: string) { super(message); this.name = "ContractError"; }
}
export class ContractValidationError extends Error {
  fieldErrors: Record<string, string>;
  constructor(message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = "ContractValidationError";
    this.fieldErrors = fieldErrors;
  }
}

export async function createOrResendContract(
  acceptanceId: string,
  actorId: string,
  baseUrl: string,
): Promise<OnboardingContract> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("Only SRR can send onboarding links.");
  }
  const acceptance = await prisma.acceptance.findUnique({
    where: { id: acceptanceId },
    include: {
      application: {
        include: {
          applicant: true,
          cycle: { select: { id: true, title: true } },
        },
      },
      contract: true,
    },
  });
  if (!acceptance) throw new ContractError("Acceptance not found.");
  const applicant = acceptance.application.applicant;
  let contract = acceptance.contract;
  if (contract && contract.status !== "PENDING") {
    throw new ContractError("This applicant has already submitted their onboarding contract.");
  }
  if (!contract) {
    contract = await prisma.onboardingContract.create({
      data: {
        acceptanceId,
        token: randomUUID(),
        firstName: applicant.firstName,
        lastName: applicant.lastName,
        email: applicant.email,
        netId: applicant.netId,
        phone: applicant.phone,
      },
    });
  }
  const url = `${baseUrl}/onboard/${contract.token}`;
  const email = await renderCycleEmail(acceptance.application.cycle.id, "recruitment.onboarding", {
    firstName: contract.firstName || "there",
    cycleTitle: acceptance.application.cycle.title,
    contractUrl: url,
  });
  const c = contract;
  await prisma.$transaction(async (tx) => {
    await queueEmail(tx, {
      to: c.email,
      subject: email.subject,
      html: email.html,
      template: "recruitment.onboarding",
    });
    await tx.onboardingContract.update({
      where: { id: c.id },
      data: { sentAt: new Date() },
    });
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.onboarding_send",
    entityType: "OnboardingContract",
    entityId: c.id,
  });
  return prisma.onboardingContract.findUniqueOrThrow({ where: { id: c.id } });
}

export async function getContractByToken(token: string) {
  return prisma.onboardingContract.findUnique({ where: { token } });
}

export type ContractSubmission = {
  firstName: string;
  lastName: string;
  email: string;
  netId?: string;
  phone?: string;
  dateOfBirth?: Date;
  dietaryRestrictions?: string;
  yaleAffiliation?: string;
  gradYear?: string;
  agreementSignature: string;
  professionalismSignature: string;
  trainingSignature: string;
  initials: string;
  epicNeeded: boolean;
  hasEpic: boolean;
  existingEpicId?: string;
  epicAccessType?: string;
  worksWithYnhh: boolean;
  spanishSelfReported?: boolean;
  licensedRN?: boolean;
  hipaaCompletedAt?: string; // raw YYYY-MM-DD from the date input; validated in submitContract
  hipaaFile?: { fileName: string; mimeType: string; bytes: Buffer };
};

export async function submitContract(
  token: string,
  input: ContractSubmission,
): Promise<OnboardingContract> {
  const contract = await prisma.onboardingContract.findUnique({ where: { token } });
  if (!contract) throw new ContractError("This onboarding link is not valid.");
  if (contract.status !== "PENDING") {
    throw new ContractError("This onboarding form has already been submitted.");
  }

  const e: Record<string, string> = {};
  if (!input.firstName?.trim()) e.firstName = "required";
  if (!input.lastName?.trim()) e.lastName = "required";
  if (!input.email?.trim()) e.email = "required";
  if (!input.agreementSignature?.trim()) e.agreementSignature = "required";
  if (!input.professionalismSignature?.trim()) e.professionalismSignature = "required";
  if (!input.trainingSignature?.trim()) e.trainingSignature = "required";
  if (!input.initials?.trim()) e.initials = "required";
  if (!input.hipaaCompletedAt) e.hipaaCompletedAt = "required";
  if (!input.hipaaFile && !contract.hipaaStoredName) e.hipaaFile = "required";
  if (input.hasEpic && !input.existingEpicId?.trim()) {
    e.existingEpicId = "required when you already have EPIC";
  }
  let hipaaCompletedAt: Date | undefined;
  if (input.hipaaCompletedAt) {
    try {
      hipaaCompletedAt = parseCompletionDate(input.hipaaCompletedAt);
    } catch (err) {
      if (!(err instanceof CompletionDateError)) throw err;
      e.hipaaCompletedAt =
        err.reason.includes("future") ? "Completion date cannot be in the future."
        : err.reason.includes("older") ? "Completion date cannot be more than 5 years ago."
        : "Enter a valid completion date.";
    }
  }
  if (Object.keys(e).length > 0) {
    throw new ContractValidationError("Please fix the highlighted fields.", e);
  }

  let fileRef: {
    hipaaStoredName?: string;
    hipaaFileName?: string;
    hipaaMimeType?: string;
    hipaaSize?: number;
  } = {};
  let writtenKey: string | null = null;
  if (input.hipaaFile) {
    const maxMb = await getSetting<number>("uploads.maxMb");
    const capBytes = maxMb * 1024 * 1024;
    if (input.hipaaFile.bytes.length > capBytes) {
      throw new ContractValidationError("File too large.", {
        hipaaFile: `max ${maxMb} MB`,
      });
    }
    const ALLOWED_MIME = ["application/pdf", "image/jpeg", "image/png", "image/gif"];
    if (!ALLOWED_MIME.includes(input.hipaaFile.mimeType)) {
      throw new ContractValidationError("File type not supported.", { hipaaFile: "Upload a PDF or image." });
    }
    const safeExt =
      (path.extname(input.hipaaFile.fileName).match(/^\.[A-Za-z0-9]{1,8}$/)?.[0]) ?? "";
    const storedName = `hipaa-${randomUUID()}${safeExt}`;
    const storageKey = `onboarding/${contract.id}/${storedName}`;
    await putObject(storageKey, input.hipaaFile.bytes, input.hipaaFile.mimeType);
    writtenKey = storageKey;
    fileRef = {
      hipaaStoredName: storedName,
      hipaaFileName: input.hipaaFile.fileName,
      hipaaMimeType: input.hipaaFile.mimeType,
      hipaaSize: input.hipaaFile.bytes.length,
    };
  }

  let updated;
  try {
    updated = await prisma.onboardingContract.update({
      where: { id: contract.id },
      data: {
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        email: input.email.trim(),
        netId: input.netId?.trim() || null,
        phone: input.phone?.trim() || null,
        dateOfBirth: input.dateOfBirth ?? null,
        dietaryRestrictions: input.dietaryRestrictions?.trim() || null,
        yaleAffiliation: input.yaleAffiliation?.trim() || null,
        gradYear: input.gradYear?.trim() || null,
        agreementSignature: input.agreementSignature.trim(),
        professionalismSignature: input.professionalismSignature.trim(),
        trainingSignature: input.trainingSignature.trim(),
        initials: input.initials.trim(),
        epicNeeded: input.epicNeeded,
        hasEpic: input.hasEpic,
        existingEpicId: input.existingEpicId?.trim() || null,
        epicAccessType: input.epicAccessType?.trim() || null,
        worksWithYnhh: input.worksWithYnhh,
        spanishSelfReported: input.spanishSelfReported ?? false,
        licensedRN: input.licensedRN ?? false,
        hipaaCompletedAt: hipaaCompletedAt ?? null,
        ...fileRef,
        status: "SUBMITTED",
        submittedAt: new Date(),
      },
    });
  } catch (err) {
    if (writtenKey) await deleteObject(writtenKey);
    throw err;
  }
  await recordAudit({
    action: "recruitment.onboarding_submit",
    entityType: "OnboardingContract",
    entityId: contract.id,
  });
  return updated;
}

export async function listOnboarding(cycleId: string) {
  return prisma.acceptance.findMany({
    where: { application: { cycleId } },
    include: {
      application: {
        include: {
          applicant: { select: { firstName: true, lastName: true, email: true } },
        },
      },
      contract: true,
    },
    orderBy: { createdAt: "asc" },
  });
}
