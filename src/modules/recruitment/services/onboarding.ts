import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OnboardingContract } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { getSetting } from "@/platform/settings/service";
import { putObject, deleteObject } from "@/platform/storage";
import { decodeSignaturePng, SignatureError } from "./signature";
import type { SignatureInput, StoredSignature } from "../contract/signatures";
import { queueEmail } from "@/platform/email/send";
import { recordAudit } from "@/platform/audit";
import { parseCompletionDate, CompletionDateError } from "@/platform/compliance/completion-date";
import { RecruitmentAuthError } from "./review";
import { findAcceptanceConflicts } from "../engine/conflicts";
import { renderCycleEmail } from "../email/render";
import { resolveContractLayout } from "../contract/resolve";
import { parseContractLayout, type ContractLayout } from "../contract/layout";
import { DEFAULT_CONTRACT_LAYOUT } from "../contract/system-fields";

/**
 * How long an onboarding link stays usable after a send. The link is a standing
 * credential (opening it lets someone submit onboarding data as the applicant), so
 * it must not live forever; 21 days comfortably covers a real applicant while
 * bounding the window if the URL later leaks. Refreshed on every resend.
 */
const ONBOARDING_LINK_TTL_MS = 21 * 24 * 60 * 60 * 1000;

/** True when the contract's link has passed its expiry. Null expiresAt (contracts
 *  created before the field existed) is grandfathered as non-expiring. */
function isContractExpired(contract: { expiresAt: Date | null }): boolean {
  return contract.expiresAt != null && contract.expiresAt.getTime() < Date.now();
}

/** Parse a frozen snapshot, falling back to the code default if it is null or invalid. */
function safeParseLayout(value: unknown): ContractLayout {
  if (value == null) return DEFAULT_CONTRACT_LAYOUT;
  try { return parseContractLayout(value); } catch { return DEFAULT_CONTRACT_LAYOUT; }
}

/**
 * Validate a YYYY-MM-DD date of birth from the date input: it must be a real
 * calendar date and not in the future. Returns the date normalized to noon UTC
 * (matching the completion-date convention so it never shifts a day across time
 * zones), or null when the value is malformed.
 */
function parseDateOfBirth(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month0 = parseInt(match[2], 10) - 1;
  const day = parseInt(match[3], 10);
  const dob = new Date(Date.UTC(year, month0, day, 12, 0, 0, 0));
  // Reject calendar overflow (e.g. Feb 30 rolling into March).
  if (dob.getUTCFullYear() !== year || dob.getUTCMonth() !== month0 || dob.getUTCDate() !== day) {
    return null;
  }
  const now = new Date();
  const endOfTodayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999);
  if (dob.getTime() > endOfTodayUtc) return null;
  return dob;
}

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
          cycle: { select: { id: true, title: true, status: true } },
          acceptances: { select: { departmentCode: true } },
        },
      },
      contract: true,
    },
  });
  if (!acceptance) throw new ContractError("Acceptance not found.");
  // The onboarding email is itself an acceptance notification, so it must obey
  // the same gates the Decisions page enforces: never notify on a draft/archived
  // cycle, and never notify a conflicted applicant (accepted by >1 department)
  // before SRR resolves the conflict.
  const cycle = acceptance.application.cycle;
  if (cycle.status === "DRAFT" || cycle.status === "ARCHIVED") {
    throw new ContractError("Onboarding links can only be sent for an open or closed cycle.");
  }
  const conflicts = findAcceptanceConflicts(
    acceptance.application.acceptances.map((a) => ({ applicationId: acceptance.applicationId, departmentCode: a.departmentCode })),
  );
  if (conflicts.has(acceptance.applicationId)) {
    throw new ContractError("This applicant was accepted by more than one department. Resolve the conflict on the Decisions page before onboarding.");
  }
  const applicant = acceptance.application.applicant;
  let contract = acceptance.contract;
  if (contract && contract.status !== "PENDING") {
    throw new ContractError("This applicant has already submitted their onboarding contract.");
  }
  const layout = (!contract || !contract.templateSnapshot)
    ? await resolveContractLayout(cycle.id)
    : null;
  if (!contract) {
    // Prefill affiliation/grad-year/Spanish from the application answers so the
    // applicant does not re-answer them during onboarding; only on create, so a
    // resend never clobbers a contract a director has already started editing.
    const a = (acceptance.application.answers ?? {}) as Record<string, unknown>;
    contract = await prisma.onboardingContract.create({
      data: {
        acceptanceId,
        token: randomUUID(),
        firstName: applicant.firstName,
        lastName: applicant.lastName,
        email: applicant.email,
        netId: applicant.netId,
        phone: applicant.phone,
        yaleAffiliation: typeof a.yale_affiliation === "string" ? a.yale_affiliation : undefined,
        gradYear: typeof a.grad_year === "string" ? a.grad_year : undefined,
        spanishSelfReported: typeof a.spanish_proficiency === "string" && a.spanish_proficiency !== "none",
        templateSnapshot: layout as object,
      },
    });
  } else if (!contract.templateSnapshot) {
    // Resend of a pre-snapshot PENDING contract: freeze now.
    contract = await prisma.onboardingContract.update({
      where: { id: contract.id },
      data: { templateSnapshot: layout as object },
    });
  }
  const url = `${baseUrl}/onboard/${contract.token}`;
  const email = await renderCycleEmail(cycle.id, "recruitment.onboarding", {
    firstName: contract.firstName || "there",
    cycleTitle: cycle.title,
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
      // Refresh the expiry on every (re)send so a resend revives a lapsed link and
      // a fresh send bounds the credential's lifetime.
      data: { sentAt: new Date(), expiresAt: new Date(Date.now() + ONBOARDING_LINK_TTL_MS) },
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
  const contract = await prisma.onboardingContract.findUnique({ where: { token } });
  // An expired link is treated as invalid (the page shows the not-valid state). An
  // SRR can revive it by resending, which refreshes expiresAt on the same token.
  if (contract && isContractExpired(contract)) return null;
  return contract;
}

export type ContractSubmission = {
  firstName: string;
  lastName: string;
  email: string;
  netId?: string;
  phone?: string;
  dateOfBirth?: string; // raw YYYY-MM-DD from the date input; validated in submitContract
  dietaryRestrictions?: string;
  yaleAffiliation?: string;
  gradYear?: string;
  // Drawn signatures keyed by block id: each agreement's id, plus "initials".
  // Which are required is driven by the frozen snapshot layout. The typed-name
  // fallback still produces a PNG, so every value is a SignatureInput.
  signatures: Record<string, SignatureInput>;
  customAnswers?: Record<string, string | string[]>;
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
  if (isContractExpired(contract)) {
    throw new ContractError("This onboarding link has expired. Please ask your recruitment lead to resend it.");
  }

  const e: Record<string, string> = {};
  if (!input.firstName?.trim()) e.firstName = "required";
  if (!input.lastName?.trim()) e.lastName = "required";
  if (!input.email?.trim()) e.email = "required";
  // Required agreement signatures + required custom questions come from the frozen
  // snapshot layout, so an edited contract validates exactly what it renders.
  const layout = safeParseLayout(contract.templateSnapshot);
  const initialsEnabled = layout.blocks.some(
    (b) => b.kind === "system_field" && b.systemKey === "initials" && b.enabled !== false,
  );
  const signed = (id: string) => Boolean(input.signatures?.[id]?.dataUrl);
  if (initialsEnabled && !signed("initials")) e["sig__initials"] = "required";
  for (const b of layout.blocks) {
    if (b.kind === "agreement" && !signed(b.id)) {
      e[`sig__${b.id}`] = "required";
    }
    if (b.kind === "custom_question" && b.required) {
      const v = input.customAnswers?.[b.key];
      const empty = v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === "");
      if (empty) e[`custom__${b.key}`] = "required";
    }
  }
  if (!input.hipaaCompletedAt) e.hipaaCompletedAt = "required";
  if (!input.hipaaFile && !contract.hipaaStoredName) e.hipaaFile = "required";
  if (input.hasEpic && !input.existingEpicId?.trim()) {
    e.existingEpicId = "required when you already have Epic";
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
  let dateOfBirth: Date | undefined;
  if (input.dateOfBirth) {
    const parsed = parseDateOfBirth(input.dateOfBirth);
    if (parsed) dateOfBirth = parsed;
    else e.dateOfBirth = "Enter a valid date of birth.";
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

  // Persist each drawn signature as a private PNG blob and build the structured
  // record stored in the signatures JSON. Every enabled agreement (+ initials) was
  // validated as signed above, so decode failures here are treated as validation
  // errors, not crashes. Written keys are rolled back if the claim below fails.
  const signatureJson: Record<string, StoredSignature> = {};
  const signatureKeys: string[] = [];
  const cleanupSignatures = async () => { for (const k of signatureKeys) await deleteObject(k); };
  const requiredIds = new Set<string>([
    ...layout.blocks.filter((b) => b.kind === "agreement").map((b) => (b as { id: string }).id),
    ...(initialsEnabled ? ["initials"] : []),
  ]);
  for (const id of requiredIds) {
    const sig = input.signatures[id];
    let bytes: Buffer;
    try {
      bytes = decodeSignaturePng(sig.dataUrl);
    } catch (err) {
      await cleanupSignatures();
      if (writtenKey) await deleteObject(writtenKey);
      if (err instanceof SignatureError) throw new ContractValidationError("Please provide a valid signature.", { [`sig__${id}`]: "invalid signature" });
      throw err;
    }
    const imageKey = `onboarding/${contract.id}/sig-${id.replace(/[^a-z0-9_]/gi, "_")}.png`;
    await putObject(imageKey, bytes, "image/png");
    signatureKeys.push(imageKey);
    signatureJson[id] = { method: sig.method === "type" ? "type" : "draw", name: sig.name.trim(), imageKey, signedAt: new Date().toISOString() };
  }
  const initialsName = input.signatures.initials?.name?.trim() ?? null;

  // Claim the submit atomically: the status: "PENDING" precondition means only one
  // of two concurrent submits can flip the row. Without it, both would upload a
  // distinct HIPAA blob and both flip to SUBMITTED, but the row keeps only the last
  // blob, orphaning the other (plus a duplicate audit row).
  let claimed;
  try {
    claimed = await prisma.onboardingContract.updateMany({
      where: { id: contract.id, status: "PENDING" },
      data: {
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        email: input.email.trim(),
        netId: input.netId?.trim() || null,
        phone: input.phone?.trim() || null,
        dateOfBirth: dateOfBirth ?? null,
        dietaryRestrictions: input.dietaryRestrictions?.trim() || null,
        yaleAffiliation: input.yaleAffiliation?.trim() || null,
        gradYear: input.gradYear?.trim() || null,
        initials: initialsName,
        signatures: signatureJson as object,
        customAnswers: (input.customAnswers ?? {}) as object,
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
    await cleanupSignatures();
    if (writtenKey) await deleteObject(writtenKey);
    throw err;
  }
  if (claimed.count === 0) {
    // A concurrent submit already flipped this contract to SUBMITTED. Drop the blobs
    // we just wrote so they aren't orphaned, and don't write a second audit row.
    await cleanupSignatures();
    if (writtenKey) await deleteObject(writtenKey);
    throw new ContractError("This onboarding form has already been submitted.");
  }
  await recordAudit({
    action: "recruitment.onboarding_submit",
    entityType: "OnboardingContract",
    entityId: contract.id,
  });
  return prisma.onboardingContract.findUniqueOrThrow({ where: { id: contract.id } });
}

export async function listOnboarding(cycleId: string) {
  const rows = await prisma.acceptance.findMany({
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
  // Flag acceptances whose application was accepted by more than one department.
  // The onboarding surface must not let SRR send links to, or promote, these
  // until the conflict is resolved on the Decisions page.
  const conflicts = findAcceptanceConflicts(
    rows.map((r) => ({ applicationId: r.applicationId, departmentCode: r.departmentCode })),
  );
  return rows.map((r) => ({ ...r, conflicted: conflicts.has(r.applicationId) }));
}

/** Load a submitted contract for the admin signed-contract view, with the owning
 *  cycle id so the page can confirm the contract belongs to the cycle in its URL. */
export async function getContractForReview(contractId: string) {
  const contract = await prisma.onboardingContract.findUnique({
    where: { id: contractId },
    include: { acceptance: { include: { application: { select: { cycleId: true } } } } },
  });
  if (!contract) return null;
  return { contract, cycleId: contract.acceptance.application.cycleId };
}
