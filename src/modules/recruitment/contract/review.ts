import type { OnboardingContract } from "@prisma/client";
import { formatCalendarDate } from "@/platform/dates/format";
import type { ContractBlock, ContractLayout, SystemFieldBlock, CustomQuestionBlock, ConfirmKind } from "./layout";
import type { ContractContext } from "./visibility";
import { buildContractAnswers, visibleContractBlocks } from "./visibility";
import { SYSTEM_FIELDS, systemFieldOptions } from "./system-fields";
import {
  buildContractSignatureView,
  type ContractSignatureRow,
  type LegacyContractSignatures,
} from "./signatures";

/** One resolved response line on the reviewer's summary: a human label with the
 *  applicant's answer already rendered to a string. `value` is null when the
 *  field was shown but left blank. `cert` is present only on the HIPAA
 *  certificate row, signalling the page to render a gated download link. */
export type ReviewField = { label: string; value: string | null; cert?: { fileName: string } };

/** One agreement's confirmation status for the at-a-glance checklist. */
export type AgreementReview = {
  blockId: string;
  title: string;
  confirmKind: ConfirmKind;
  confirmed: boolean;
};

export type ContractReview = {
  responses: ReviewField[];
  agreements: AgreementReview[];
  /** Signature rows for the evidence card: signable blocks only (initials +
   *  agreements whose confirmKind is signature/initials), never checkbox ones. */
  signatureRows: ContractSignatureRow[];
};

/** The stored-contract fields this module reads. A structural subset of
 *  OnboardingContract so callers can pass the Prisma row directly. */
export type ReviewContractFields = Pick<
  OnboardingContract,
  | "firstName" | "lastName" | "email" | "netId" | "phone" | "dateOfBirth"
  | "dietaryRestrictions" | "yaleAffiliation" | "gradYear" | "pronouns" | "staffTitle"
  | "epicIdExpiration" | "hasEpic" | "existingEpicId" | "epicAccessType" | "worksWithYnhh"
  | "spanishSelfReported" | "licensedRN" | "hipaaCompletedAt" | "hipaaFileName" | "hipaaStoredName"
  | "agreementSignature" | "professionalismSignature" | "trainingSignature" | "initials"
> & { customAnswers: unknown; signatures: unknown };

/** ISO calendar day (YYYY-MM-DD) in UTC: the noon-UTC anchor these date columns
 *  are stored at, so the day never shifts. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Reconstruct the flat answers map the applicant's form (and the submit path's
 * validator) built, from the stored contract columns. Mirrors submitContract's
 * `systemAnswers` + customAnswers + hasEpic assembly exactly, so review-side
 * visibility matches what the applicant was shown. Context keys
 * (department/track/epicRequirement) are layered on separately via
 * buildContractAnswers.
 */
export function reconstructContractAnswers(c: ReviewContractFields): Record<string, string | string[]> {
  const sys: Record<string, string> = {};
  if (c.firstName) sys.firstName = c.firstName;
  if (c.lastName) sys.lastName = c.lastName;
  if (c.email) sys.email = c.email;
  if (c.netId) sys.netId = c.netId;
  if (c.phone) sys.phone = c.phone;
  if (c.dateOfBirth) sys.dateOfBirth = isoDay(c.dateOfBirth);
  if (c.dietaryRestrictions) sys.dietaryRestrictions = c.dietaryRestrictions;
  if (c.yaleAffiliation) sys.yaleAffiliation = c.yaleAffiliation;
  if (c.gradYear) sys.gradYear = c.gradYear;
  if (c.pronouns) sys.pronouns = c.pronouns;
  if (c.staffTitle) sys.staffTitle = c.staffTitle;
  if (c.epicIdExpiration) sys.epicIdExpiration = isoDay(c.epicIdExpiration);
  const custom = (c.customAnswers ?? {}) as Record<string, string | string[]>;
  return { ...sys, ...custom, hasEpic: c.hasEpic ? "on" : "" };
}

/** Concise reviewer labels for the two Epic access-type options the applicant
 *  chose between; falls back to the raw stored value if it is neither. */
const EPIC_ACCESS_LABELS: Record<string, string> = {
  new: "New account",
  renewal: "Renewal or reactivation",
};

function yesNo(v: boolean): string {
  return v ? "Yes" : "No";
}

/** Resolve a stored select value to its option label, prepending an unknown
 *  stored value as its own label (matching systemFieldOptions) so it is never
 *  dropped. */
function selectLabel(options: { value: string; label: string }[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/** Render the response line(s) for one visible system field. Most fields emit a
 *  single label/value row; `epic` and `hipaa` expand to several. */
function systemFieldRows(block: SystemFieldBlock, c: ReviewContractFields): ReviewField[] {
  const spec = SYSTEM_FIELDS[block.systemKey];
  const label = block.label ?? spec.defaultLabel;

  switch (block.systemKey) {
    case "name":
      return [{ label: "Name", value: `${c.firstName} ${c.lastName}`.trim() || null }];
    case "email":
      return [{ label, value: c.email || null }];
    case "netId":
      return [{ label, value: c.netId }];
    case "phone":
      return [{ label, value: c.phone }];
    case "dob":
      return [{ label, value: c.dateOfBirth ? formatCalendarDate(c.dateOfBirth) : null }];
    case "dietary":
      return [{ label, value: c.dietaryRestrictions }];
    case "pronouns":
      return [{ label, value: c.pronouns }];
    case "staffTitle":
      return [{ label, value: c.staffTitle }];
    case "epicIdExpiration":
      return [{ label, value: c.epicIdExpiration ? formatCalendarDate(c.epicIdExpiration) : null }];
    case "yaleAffiliation":
      return [{ label, value: c.yaleAffiliation ? selectLabel(systemFieldOptions("yaleAffiliation", c.yaleAffiliation), c.yaleAffiliation) : null }];
    case "gradYear":
      return [{ label, value: c.gradYear ? selectLabel(systemFieldOptions("gradYear", c.gradYear), c.gradYear) : null }];
    case "spanish":
      return [{ label, value: yesNo(c.spanishSelfReported) }];
    case "licensedRN":
      return [{ label, value: yesNo(c.licensedRN) }];
    case "epic": {
      const rows: ReviewField[] = [{ label: "Has Epic ID", value: yesNo(c.hasEpic) }];
      if (c.hasEpic) {
        rows.push({ label: "Existing Epic ID", value: c.existingEpicId });
        if (c.epicAccessType) {
          rows.push({ label: "Epic access type", value: EPIC_ACCESS_LABELS[c.epicAccessType] ?? c.epicAccessType });
        }
      }
      rows.push({ label: "Works with Yale New Haven Hospital", value: yesNo(c.worksWithYnhh) });
      return rows;
    }
    case "hipaa": {
      const rows: ReviewField[] = [
        { label: "HIPAA completion date", value: c.hipaaCompletedAt ? formatCalendarDate(c.hipaaCompletedAt) : null },
      ];
      if (c.hipaaStoredName) {
        const fileName = c.hipaaFileName ?? "Certificate";
        rows.push({ label: "HIPAA certificate", value: fileName, cert: { fileName } });
      }
      return rows;
    }
    case "initials":
      // The initials mark is evidence, shown in the signature card, not a response.
      return [];
    default:
      return [];
  }
}

/** Render a custom question's stored answer to a display string. */
function customQuestionRow(block: CustomQuestionBlock, raw: string | string[] | undefined): ReviewField {
  const label = block.label;
  if (raw == null || (Array.isArray(raw) && raw.length === 0) || raw === "") {
    return { label, value: null };
  }
  if (block.type === "CHECKBOX") {
    return { label, value: yesNo(Boolean(raw) && raw !== "") };
  }
  if (block.options && block.options.length > 0) {
    const values = Array.isArray(raw) ? raw : [raw];
    return { label, value: values.map((v) => selectLabel(block.options!, v)).join(", ") };
  }
  return { label, value: Array.isArray(raw) ? raw.join(", ") : raw };
}

function legacyColumns(c: ReviewContractFields): LegacyContractSignatures {
  return {
    agreementSignature: c.agreementSignature,
    professionalismSignature: c.professionalismSignature,
    trainingSignature: c.trainingSignature,
    initials: c.initials,
  };
}

/**
 * Build the reviewer's read-only summary of a submitted contract: the resolved
 * responses, each agreement's confirmation status, and the signature evidence
 * rows. Filters the frozen layout to exactly the blocks the applicant saw
 * (enabled + visibleWhen), using the same visibility pair the fill-out form and
 * the submit validator run, so the review never invents or hides a block.
 */
export function buildContractReview(
  c: ReviewContractFields,
  layout: ContractLayout,
  ctx: ContractContext,
): ContractReview {
  const answers = buildContractAnswers(reconstructContractAnswers(c), ctx);
  const enabled = layout.blocks.filter(
    (b) => b.kind !== "system_field" || b.enabled !== false || SYSTEM_FIELDS[b.systemKey].core,
  );
  const shown = visibleContractBlocks(enabled, answers);
  const custom = (c.customAnswers ?? {}) as Record<string, unknown>;

  // Signature evidence: agreements whose confirmKind is signable, plus initials.
  // Checkbox agreements are excluded so they never read as "Not signed".
  const signableBlocks: ContractBlock[] = shown.filter(
    (b) => b.kind !== "agreement" || (b.confirmKind ?? "signature") !== "checkbox",
  );
  const signatureRows = buildContractSignatureView({ blocks: signableBlocks }, c.signatures, legacyColumns(c));
  const signedById = new Map(signatureRows.map((r) => [r.blockId, Boolean(r.imageKey || r.legacyText)]));

  const responses: ReviewField[] = [];
  const agreements: AgreementReview[] = [];
  for (const b of shown) {
    if (b.kind === "section") continue;
    if (b.kind === "agreement") {
      const kind = b.confirmKind ?? "signature";
      const confirmed = kind === "checkbox"
        ? Boolean(custom[`confirm__${b.id}`]) && custom[`confirm__${b.id}`] !== ""
        : (signedById.get(b.id) ?? false);
      agreements.push({ blockId: b.id, title: b.title, confirmKind: kind, confirmed });
      continue;
    }
    if (b.kind === "custom_question") {
      responses.push(customQuestionRow(b, custom[b.key] as string | string[] | undefined));
      continue;
    }
    responses.push(...systemFieldRows(b, c));
  }

  return { responses, agreements, signatureRows };
}
