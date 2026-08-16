import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OnboardingContract } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { getSetting } from "@/platform/settings/service";
import { putObject, deleteObject } from "@/platform/storage";
import { decodeSignaturePng, SignatureError } from "./signature";
import { normalizeIdentityKey } from "./identity-keys";
import { isStoredSignature, type SignatureInput, type StoredSignature } from "../contract/signatures";
import { queueEmail } from "@/platform/email/send";
import { recordAudit } from "@/platform/audit";
import { parseCompletionDate, CompletionDateError } from "@/platform/compliance/completion-date";
import { RecruitmentAuthError } from "./review";
import { findAcceptanceConflicts } from "../engine/conflicts";
import { renderCycleEmail } from "../email/render";
import { resolveContractLayout } from "../contract/resolve";
import { parseContractLayout, type ContractLayout } from "../contract/layout";
import { DEFAULT_CONTRACT_LAYOUT } from "../contract/system-fields";
import { buildContractAnswers, visibleContractBlocks, type ContractContext } from "../contract/visibility";
import { epicRequirementFor, resolveEpicNeeded } from "../contract/epic-requirement";
import { buildOnboardingNextSteps } from "../onboarding-next-steps";
import { formatTrainingDate, formatTrainingLocation } from "../training-date";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { log, errorAttrs } from "@/platform/logging";
import { deriveRowState, type OnboardingRow } from "../engine/onboarding-rows";
import { resolveCustomAnswers } from "../contract/custom-answers";

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

/** Parse the frozen review context stored at submit, or null when the row predates
 *  the column or the stored value is malformed (caller falls back to a live
 *  derivation in that case). Validates only the shape this module writes. */
function parseReviewContext(value: unknown): ContractContext | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const { department, track, epicRequirement, storedEpicId } = v;
  if (typeof track !== "string") return null;
  if (typeof epicRequirement !== "string") return null;
  if (department !== null && typeof department !== "string") return null;
  if (storedEpicId !== null && typeof storedEpicId !== "string") return null;
  return {
    department: department as string | null,
    track: track as ContractContext["track"],
    epicRequirement: epicRequirement as ContractContext["epicRequirement"],
    storedEpicId: storedEpicId as string | null,
  };
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

/**
 * Validate a YYYY-MM-DD date from the Epic ID expiration date input: it must be
 * a real calendar date. Unlike parseDateOfBirth, no past/future bound applies
 * (an expiration is naturally often in the future, and a lapsed one is allowed
 * to already be in the past). Returns the date normalized to midnight UTC, or
 * null when the value is malformed.
 */
function parseYmdDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month0 = parseInt(match[2], 10) - 1;
  const day = parseInt(match[3], 10);
  const d = new Date(Date.UTC(year, month0, day, 0, 0, 0, 0));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month0 || d.getUTCDate() !== day) return null;
  return d;
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
  // Include the acceptance -> application -> cycle chain so the onboarding
  // page can derive the applicant's department and track (and from those,
  // the Epic requirement) without a second round trip.
  const contract = await prisma.onboardingContract.findUnique({
    where: { token },
    include: { acceptance: { include: { application: { include: { cycle: true } } } } },
  });
  // An expired PENDING link is treated as invalid (the page shows the not-valid
  // state). An SRR can revive it by resending, which refreshes expiresAt on the
  // same token. expiresAt only ever bounded the window for filling out and
  // submitting the form (submitContract's own expiry check is gated the same
  // way), so a SUBMITTED/PROMOTED contract past that window is not a stale
  // credential; it is someone reading their own already-recorded confirmation
  // (the page's `contract.status !== "PENDING"` branch), and expiry must not
  // hide it behind the generic "not available" error.
  if (contract && contract.status === "PENDING" && isContractExpired(contract)) return null;
  return contract;
}

/**
 * The Epic ID already on file for an applicant, or null. Matched the same way
 * promotion.ts matches an existing Person: by netId (case-insensitive), else by
 * contactEmail. A brand-new applicant has no Person yet, so this returns null
 * and the Epic section collects normally. The onboarding page and submitContract
 * both call this so their Epic-section visibility agrees (client/server parity).
 */
export async function lookupStoredEpicId(
  netId: string | null,
  email: string | null,
): Promise<string | null> {
  // Same key promoteContracts matches on. `equals` is case-insensitive but
  // whitespace-sensitive, and these columns carry untrimmed applicant keystrokes
  // (audit 14, ONB-4).
  const key = normalizeIdentityKey(netId);
  const emailKey = normalizeIdentityKey(email);
  const byNetId = key
    ? await prisma.person.findFirst({ where: { netId: { equals: key, mode: "insensitive" } }, select: { epicId: true } })
    : null;
  const matched = byNetId ?? (emailKey
    ? await prisma.person.findFirst({ where: { contactEmail: { equals: emailKey, mode: "insensitive" } }, select: { epicId: true } })
    : null);
  return matched?.epicId ?? null;
}

/**
 * Whether an ACTIVE Person already exists for this applicant, matched the same
 * way lookupStoredEpicId matches: by netId (case-insensitive), else by
 * contactEmail. Deliberately filters to status "ACTIVE" (lookupStoredEpicId
 * does not), because this answers a different question: not "is there an
 * Epic ID on file" but "can this person actually sign in right now" -- the
 * same ACTIVE check requestMemberLoginLink (member-magic-link.ts) and
 * getActivePerson (session.ts) apply at sign-in time. A brand-new applicant
 * has no Person at all (false); an offboarded former member also can't sign
 * in (false) even though a stale Person row exists. Used by
 * buildOnboardingNextSteps's `hasAccount` input to decide whether the
 * "sign in" instruction is actually true for this volunteer yet: signing in
 * only works once a Person row exists, and promoteContracts (promotion.ts) is
 * the only production path that creates one.
 */
export async function lookupHasAccount(
  netId: string | null,
  email: string | null,
): Promise<boolean> {
  const key = normalizeIdentityKey(netId);
  const emailKey = normalizeIdentityKey(email);
  const byNetId = key
    ? await prisma.person.findFirst({ where: { netId: { equals: key, mode: "insensitive" }, status: "ACTIVE" }, select: { id: true } })
    : null;
  if (byNetId) return true;
  const byEmail = emailKey
    ? await prisma.person.findFirst({ where: { contactEmail: { equals: emailKey, mode: "insensitive" }, status: "ACTIVE" }, select: { id: true } })
    : null;
  return Boolean(byEmail);
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
  pronouns?: string;
  staffTitle?: string;
  epicIdExpiration?: string; // raw YYYY-MM-DD from the date input; validated in submitContract
  // Drawn signatures keyed by block id: each agreement's id, plus "initials".
  // Which are required is driven by the frozen snapshot layout. The typed-name
  // fallback still produces a PNG, so every value is a SignatureInput.
  signatures: Record<string, SignatureInput>;
  customAnswers?: Record<string, string | string[]>;
  // Checkbox-confirmed agreements (confirmKind: "checkbox"), keyed by agreement
  // block id. Unlike signature/initials agreements, these have no drawn PNG;
  // the boolean confirmation itself is the record that the applicant agreed.
  confirmations?: Record<string, boolean>;
  // epicNeeded is deliberately NOT part of this type: it is derived
  // server-side from the department's Epic requirement plus the applicant's
  // epic_needed_self answer (see resolveEpicNeeded in submitContract), never
  // trusted from the client.
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

  // Load the authoritative context the client used to decide what to show:
  // the acceptance's department and the cycle's track, from which the Epic
  // requirement follows. A broken chain (acceptance or department no longer
  // resolves) degrades safely rather than throwing: track defaults to
  // VOLUNTEER and department to null, which makes epicRequirementFor return
  // NONE and hides every department-gated block, matching what the onboarding
  // page itself falls back to when rendering. The extra cycle fields
  // (id/title/training) are not needed for that derivation; they are carried
  // along so the confirmation email queued below can reuse this same query
  // instead of re-fetching the same chain a second time.
  const acceptance = await prisma.acceptance.findUnique({
    where: { id: contract.acceptanceId },
    include: {
      application: {
        include: {
          cycle: {
            select: { id: true, title: true, track: true, inPersonTrainingDate: true, trainingLocation: true },
          },
        },
      },
    },
  });
  const cycle = acceptance?.application?.cycle ?? null;
  const track = cycle?.track ?? "VOLUNTEER";
  const departmentCode = acceptance?.departmentCode ?? null;
  const dept = departmentCode
    ? await prisma.department.findUnique({
        where: { code: departmentCode },
        select: { requiresEpicDirector: true, requiresEpicVolunteer: true },
      })
    : null;
  const requirement = epicRequirementFor(dept, track);
  const storedEpicId = await lookupStoredEpicId(contract.netId, contract.email);

  const e: Record<string, string> = {};
  if (!input.firstName?.trim()) e.firstName = "required";
  if (!input.lastName?.trim()) e.lastName = "required";
  if (!input.email?.trim()) e.email = "required";
  // Required agreement signatures + required custom questions come from the frozen
  // snapshot layout, so an edited contract validates exactly what it renders.
  const layout = safeParseLayout(contract.templateSnapshot);
  // Feed the submitted system-field values into the same
  // buildContractAnswers/visibleContractBlocks pair the client
  // (onboard-form.tsx) runs, over the frozen snapshot, with the same
  // authoritative context, so client and server compute the same visibility.
  // The client's answers map is seeded from prefill and kept live via onChange
  // for these input names, so a block's visibleWhen can key off any of them
  // (e.g. staffTitle on yaleAffiliation === "staff"); without this the server
  // could never see a raw system-field value and would evaluate such a
  // condition against an empty map. systemAnswers is spread first so a custom
  // answer or the authoritative context still wins on any key collision.
  // hasEpic feeds in as "on"/"" to match how the client's own answers map
  // represents that checkbox, since a block's visibleWhen (e.g.
  // epicIdExpiration) can key off it.
  const systemAnswers: Record<string, string> = {};
  if (input.firstName) systemAnswers.firstName = input.firstName;
  if (input.lastName) systemAnswers.lastName = input.lastName;
  if (input.email) systemAnswers.email = input.email;
  if (input.netId) systemAnswers.netId = input.netId;
  if (input.phone) systemAnswers.phone = input.phone;
  if (input.dateOfBirth) systemAnswers.dateOfBirth = input.dateOfBirth;
  if (input.dietaryRestrictions) systemAnswers.dietaryRestrictions = input.dietaryRestrictions;
  if (input.yaleAffiliation) systemAnswers.yaleAffiliation = input.yaleAffiliation;
  if (input.gradYear) systemAnswers.gradYear = input.gradYear;
  if (input.pronouns) systemAnswers.pronouns = input.pronouns;
  if (input.staffTitle) systemAnswers.staffTitle = input.staffTitle;
  if (input.epicIdExpiration) systemAnswers.epicIdExpiration = input.epicIdExpiration;
  const answers = buildContractAnswers(
    { ...systemAnswers, ...(input.customAnswers ?? {}), hasEpic: input.hasEpic ? "on" : "" },
    { department: departmentCode, track, epicRequirement: requirement, storedEpicId },
  );
  const visible = visibleContractBlocks(layout.blocks, answers);
  const initialsEnabled = visible.some(
    (b) => b.kind === "system_field" && b.systemKey === "initials" && b.enabled !== false,
  );
  const signed = (id: string) => Boolean(input.signatures?.[id]?.dataUrl);
  if (initialsEnabled && !signed("initials")) e["sig__initials"] = "required";
  for (const b of visible) {
    if (b.kind === "agreement") {
      const kind = b.confirmKind ?? "signature";
      if (kind === "checkbox") {
        if (!input.confirmations?.[b.id]) e[`confirm__${b.id}`] = "required";
      } else if (!signed(b.id)) {
        e[`sig__${b.id}`] = "required";
      }
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
  let epicIdExpiration: Date | undefined;
  if (input.epicIdExpiration) {
    const parsed = parseYmdDate(input.epicIdExpiration);
    if (parsed) epicIdExpiration = parsed;
    else e.epicIdExpiration = "Enter a valid date.";
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
  // Only visible, non-checkbox agreements carry a drawn/typed signature to blob
  // out here: a hidden agreement was never required above, and a checkbox
  // agreement's confirmation has no PNG at all (input.signatures[id] would be
  // undefined for it, so including it here would throw on sig.dataUrl).
  const requiredIds = new Set<string>([
    ...visible
      .filter((b) => b.kind === "agreement" && (b.confirmKind ?? "signature") !== "checkbox")
      .map((b) => (b as { id: string }).id),
    ...(initialsEnabled ? ["initials"] : []),
  ]);
  for (const id of requiredIds) {
    const sig = input.signatures[id];
    try {
      const bytes = decodeSignaturePng(sig.dataUrl);
      const imageKey = `onboarding/${contract.id}/sig-${id.replace(/[^a-z0-9_]/gi, "_")}-${randomUUID()}.png`;
      await putObject(imageKey, bytes, "image/png");
      signatureKeys.push(imageKey);
      const method = sig.method === "type" ? "type" : "draw";
      // A typed signature carries its own name; a drawn one's companion name is a
      // best-effort client hint that can be stale (the prefilled name, not the name
      // the applicant actually entered on this form), so prefer the submitted
      // identity name for drawn signatures.
      const signerName = method === "type" ? sig.name.trim() : (`${input.firstName} ${input.lastName}`.trim() || sig.name.trim());
      signatureJson[id] = { method, name: signerName, imageKey, signedAt: new Date().toISOString() };
    } catch (err) {
      // Any failure here -- decode OR a putObject storage error -- must roll back
      // the HIPAA blob and every signature blob written so far, or they orphan in
      // storage while the submit fails. (Previously only decode was guarded, so a
      // putObject throw escaped and leaked them.)
      await cleanupSignatures();
      if (writtenKey) await deleteObject(writtenKey);
      // Same contract as the apply wizard: the field error is rendered verbatim
      // under the field, so it carries the sentence and the banner stays generic.
      if (err instanceof SignatureError) throw new ContractValidationError("Please fix the highlighted fields.", { [`sig__${id}`]: "Please provide a valid signature." });
      throw err;
    }
  }
  const initialsName = input.signatures.initials?.name?.trim() ?? null;

  // Same pinned-identity rule the update below applies (#49): the submit's own
  // record of the applicant's email is this, not a freely-typed one. Named
  // here (rather than re-inlined) so the confirmation email queued after
  // commit addresses the same mailbox this contract is actually stored under.
  const finalEmail = contract.email || input.email.trim();
  // epicNeeded is never read from the client: ALL/NONE departments are decided
  // by the department regardless of what a spoofed or stale submission
  // claims, and SOME defers to the applicant's own answer. Named here (rather
  // than re-inlined) so the confirmation email's Epic line is derived from
  // the exact value this submit persists, not a second recomputation of it.
  const epicNeeded = resolveEpicNeeded(requirement, input.customAnswers?.epic_needed_self === "yes");

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
        // Pin the identity keys to the values the SRR-created contract was seeded
        // with (from the accepted Applicant record); ignore a freely-typed
        // netId/email in the submission (#49). Otherwise an applicant could type
        // another member's NetID and promoteContracts -- which binds the contract
        // to whatever Person those strings match -- would rewrite that third
        // party's roster/compliance/permissions. Fall back to the submitted value
        // only when the contract was seeded without one.
        email: finalEmail,
        netId: contract.netId ?? (input.netId?.trim() || null),
        phone: input.phone?.trim() || null,
        dateOfBirth: dateOfBirth ?? null,
        dietaryRestrictions: input.dietaryRestrictions?.trim() || null,
        yaleAffiliation: input.yaleAffiliation?.trim() || null,
        gradYear: input.gradYear?.trim() || null,
        pronouns: input.pronouns?.trim() || null,
        staffTitle: input.staffTitle?.trim() || null,
        epicIdExpiration: epicIdExpiration ?? null,
        initials: initialsName,
        signatures: signatureJson as object,
        // Confirmations (checkbox agreements) have no drawn signature, so this
        // is their only durable record that the applicant agreed. Namespaced
        // under confirm__<id> so a director-authored custom question can never
        // collide with an agreement's id (the two live in disjoint id/key
        // spaces at the schema level, but nothing stops an author from picking
        // the same string for both).
        customAnswers: {
          ...(input.customAnswers ?? {}),
          ...Object.fromEntries(
            Object.entries(input.confirmations ?? {})
              .filter(([, v]) => v)
              .map(([id]) => [`confirm__${id}`, "on"]),
          ),
        } as object,
        epicNeeded,
        hasEpic: input.hasEpic,
        existingEpicId: input.existingEpicId?.trim() || null,
        epicAccessType: input.epicAccessType?.trim() || null,
        worksWithYnhh: input.worksWithYnhh,
        spanishSelfReported: input.spanishSelfReported ?? false,
        licensedRN: input.licensedRN ?? false,
        hipaaCompletedAt: hipaaCompletedAt ?? null,
        ...fileRef,
        // Freeze the visibility context used to decide what the applicant saw --
        // department/track/Epic-requirement and the storedEpicId resolved at submit
        // -- so the signed-contract review renders exactly those blocks even after
        // the department's Epic requirement changes or a matching Person later gets
        // an epicId (which promotion itself causes). getContractForReview reads this
        // and only re-derives live for pre-column rows (#107/#108/#109).
        reviewContext: { department: departmentCode, track, epicRequirement: requirement, storedEpicId } as object,
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

  // Email the volunteer the same "what happens next" content the completion
  // screen and the revisit page show (buildOnboardingNextSteps -- see the doc
  // comment atop onboarding-next-steps.ts), so a closed tab still leaves a
  // durable record of what they were told. The contract is already durably
  // SUBMITTED and audited above, so a mail failure here must not surface as a
  // failed submission: a client retry would hit the `status !== "PENDING"`
  // guard near the top of this function and strand the volunteer with no
  // next-steps content at all. Same isolation saveCertificate uses for its
  // manager alerts (my-info.ts): catch, log, continue. A missing cycle (the
  // acceptance/application chain no longer resolves) is folded into the same
  // catch rather than a separate guard, since there is no meaningful email to
  // send without a cycle to attribute it to or a title to put in the subject.
  //
  // One field intentionally is NOT shared verbatim with the two screens: the
  // sign-in line. The screens re-derive `hasAccount` live on every render, so
  // they can correctly show/hide the sign-in bullet as the volunteer's actual
  // ability to sign in changes over time. This email is rendered once, here,
  // and then sits as static HTML in an inbox for however long the volunteer
  // takes to open it -- it cannot re-check anything. Passing a live
  // `hasAccount` snapshot in would let `signIn.text` freeze in whichever state
  // was true at send time (almost always "no account yet" for a new
  // volunteer) even after promotion later makes it true. So the email always
  // uses `signIn.emailText` instead, which is phrased to stay true regardless
  // of when it is read (see its doc comment in onboarding-next-steps.ts).
  // hasAccount itself is passed false here because nothing in this email
  // reads `signIn.text`; a real lookup would just be a wasted query.
  try {
    if (!cycle) throw new Error("cycle could not be resolved for the onboarding confirmation email");
    const [zone, baseUrl] = await Promise.all([
      getDisplayTimeZone(),
      getSetting<string>("app.baseUrl"),
    ]);
    // reviewed omitted: this contract just flipped PENDING -> SUBMITTED above
    // and cannot be PROMOTED yet, same as actions.ts's completion-screen call.
    const steps = buildOnboardingNextSteps({
      email: finalEmail,
      trainingDate: cycle.inPersonTrainingDate ? formatTrainingDate(cycle.inPersonTrainingDate, zone) : null,
      trainingLocation: formatTrainingLocation(cycle.trainingLocation ?? null),
      epicNeeded,
      storedEpicId,
      hasEpic: input.hasEpic,
      hasAccount: false,
    });
    const confirmation = await renderCycleEmail(cycle.id, "recruitment.onboarding_confirmation", {
      firstName: input.firstName.trim(),
      cycleTitle: cycle.title,
      signInText: steps.signIn.emailText,
      training: steps.training,
      epic: steps.epic,
      review: steps.review,
      // The one field OnboardingNextSteps carries that next-steps-screen.tsx
      // renders as a button rather than a bullet (loginPath). This is the
      // only one of the three surfaces with no surrounding app to navigate
      // from, so without an absolute URL here the signIn bullet names an
      // action with no way to take it.
      loginUrl: `${baseUrl}${steps.loginPath}`,
    });
    await queueEmail(prisma, {
      to: finalEmail,
      subject: confirmation.subject,
      html: confirmation.html,
      template: "recruitment.onboarding_confirmation",
    });
  } catch (err) {
    log.error("[onboarding] failed to queue the onboarding confirmation email", errorAttrs(err, { contractId: contract.id }));
  }

  return prisma.onboardingContract.findUniqueOrThrow({ where: { id: contract.id } });
}

/**
 * Tear down a not-yet-promoted onboarding contract so its acceptance can be
 * rescinded, re-routed, or re-decided. Five services (revokeAcceptance and the
 * routing/interview-decision guards) refuse to touch an acceptance once a
 * contract row exists and tell the operator to remove it first, but nothing
 * deleted an OnboardingContract, so the instruction pointed at a path that did
 * not exist and those decisions were permanently stuck.
 *
 * Deletes the contract row (leaving the acceptance intact and re-decidable) and
 * best-effort removes its private signature and HIPAA blobs. A PROMOTED contract
 * is refused: that person is on the roster, so the reversal is offboarding, not
 * a withdraw. SRR-only.
 */
export async function withdrawContract(contractId: string, actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("Only SRR can withdraw onboarding contracts.");
  }
  const contract = await prisma.onboardingContract.findUnique({
    where: { id: contractId },
    select: { id: true, status: true, hipaaStoredName: true, signatures: true },
  });
  if (!contract) throw new ContractError("Onboarding contract not found.");
  if (contract.status === "PROMOTED") {
    throw new ContractError("This applicant is already on the roster. Offboard them instead of withdrawing the contract.");
  }

  // Collect the private blobs to clean up: each signature's stored image plus the
  // HIPAA certificate (keyed under onboarding/<contractId>/, per submitContract).
  const blobKeys: string[] = [];
  const sigs = contract.signatures as Record<string, unknown> | null;
  if (sigs) {
    for (const v of Object.values(sigs)) {
      if (isStoredSignature(v) && v.imageKey) blobKeys.push(v.imageKey);
    }
  }
  if (contract.hipaaStoredName) blobKeys.push(`onboarding/${contract.id}/${contract.hipaaStoredName}`);

  // Delete the row first (the authoritative action). Blob cleanup is best-effort:
  // a leaked blob is a minor storage cost, whereas deleting blobs before a failed
  // row delete would leave a live contract pointing at missing signatures. Each
  // deleteObject is wrapped so a store outage does not make an already-completed
  // withdraw escape as a thrown error: withdrawContracts would otherwise count a
  // contract that is in fact gone as `failed`, and a retry would then report it
  // as not eligible (the row no longer exists).
  await prisma.onboardingContract.delete({ where: { id: contractId } });
  for (const key of blobKeys) {
    try {
      await deleteObject(key);
    } catch (err) {
      log.error("[onboarding] best-effort blob cleanup failed after a withdraw", errorAttrs(err, { contractId, key }));
    }
  }

  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.onboarding_withdraw",
    entityType: "OnboardingContract",
    entityId: contractId,
    before: { status: contract.status },
  });
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

/**
 * Project this cycle's acceptances into the narrow row DTO the onboarding table
 * renders.
 *
 * listOnboarding returns whole OnboardingContract rows, which carry the link
 * token (a standing credential), date of birth, phone, signature records, and
 * HIPAA file metadata. The table is a client component, so anything returned
 * here is serialized into the RSC payload and shipped to the browser. Only the
 * fields below cross that boundary.
 *
 * `now` is a parameter so expiry is resolved once, here, rather than during
 * client render.
 */
export async function listOnboardingRows(
  cycleId: string,
  now: Date = new Date(),
): Promise<OnboardingRow[]> {
  const rows = await listOnboarding(cycleId);
  return rows.map((r) => ({
    acceptanceId: r.id,
    contractId: r.contract?.id ?? null,
    firstName: r.application.applicant.firstName,
    lastName: r.application.applicant.lastName,
    departmentCode: r.departmentCode,
    state: deriveRowState({ conflicted: r.conflicted, contract: r.contract, now }),
    onRoster: r.contract?.promotedPersonId != null,
    customAnswers: r.contract
      ? resolveCustomAnswers(r.contract.templateSnapshot, r.contract.customAnswers)
      : [],
  }));
}

/** Load a submitted contract for the admin signed-contract view, with the owning
 *  cycle id so the page can confirm the contract belongs to the cycle in its URL,
 *  and the authoritative visibility context (department/track/epicRequirement)
 *  so the review renders exactly the blocks the applicant was shown -- the same
 *  acceptance -> application -> cycle chain, and the same epicRequirementFor
 *  derivation, that the fill-out page and submit validator use. */
export async function getContractForReview(contractId: string) {
  const contract = await prisma.onboardingContract.findUnique({
    where: { id: contractId },
    include: {
      acceptance: {
        include: { application: { select: { cycleId: true, cycle: { select: { track: true } } } } },
      },
    },
  });
  if (!contract) return null;
  // Prefer the context frozen at submit: it is what actually decided the blocks the
  // applicant was shown. Re-deriving it live drifts the signed record after the
  // department's Epic requirement changes or a matching Person gains an epicId --
  // which promotion itself causes -- silently adding or removing answered blocks
  // from the permanent review (#107/#108/#109). Only rows submitted before this
  // column existed fall back to the live derivation.
  const frozen = parseReviewContext(contract.reviewContext);
  let ctx: ContractContext;
  if (frozen) {
    ctx = frozen;
  } else {
    const departmentCode = contract.acceptance.departmentCode;
    const track = contract.acceptance.application.cycle?.track ?? "VOLUNTEER";
    const dept = departmentCode
      ? await prisma.department.findUnique({
          where: { code: departmentCode },
          select: { requiresEpicDirector: true, requiresEpicVolunteer: true },
        })
      : null;
    ctx = {
      department: departmentCode,
      track,
      epicRequirement: epicRequirementFor(dept, track),
      storedEpicId: await lookupStoredEpicId(contract.netId, contract.email),
    };
  }
  return { contract, cycleId: contract.acceptance.application.cycleId, ctx };
}

/** Minimal certificate metadata for the reviewer-gated HIPAA download route:
 *  the stored blob name (server-generated), the applicant's original file name,
 *  and its mime type. Null when the contract does not exist. */
export async function getContractHipaa(contractId: string) {
  return prisma.onboardingContract.findUnique({
    where: { id: contractId },
    select: { hipaaStoredName: true, hipaaFileName: true, hipaaMimeType: true },
  });
}

/**
 * Withdraw a batch of onboarding contracts.
 *
 * Authorization is checked once up front so a caller without the permission gets
 * a hard error rather than a silent all-skipped result. Past that, a contract
 * that is already promoted or already gone is a benign skip, not a failure: the
 * batch keeps going and the caller reports the split. withdrawContract also
 * re-checks the permission on every call, so if the actor's authorization is
 * revoked mid-batch (a narrow but real window: deletes are sequential with blob
 * I/O per item), that RecruitmentAuthError is re-thrown rather than absorbed as
 * a skip or a failure -- it aborts the whole batch instead of quietly deleting
 * further contracts under an actor who no longer holds the permission.
 */
export async function withdrawContracts(
  contractIds: string[],
  actorId: string,
): Promise<{ withdrawn: number; skipped: number; failed: number }> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("Only SRR can withdraw onboarding contracts.");
  }
  let withdrawn = 0, skipped = 0, failed = 0;
  for (const id of contractIds) {
    try {
      await withdrawContract(id, actorId);
      withdrawn += 1;
    } catch (err) {
      if (err instanceof RecruitmentAuthError) throw err;
      if (err instanceof ContractError) { skipped += 1; continue; }
      failed += 1;
    }
  }
  return { withdrawn, skipped, failed };
}
