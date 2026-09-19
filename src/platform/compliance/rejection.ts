/**
 * The vocabulary for refusing a HIPAA certificate.
 *
 * A manager picks one of these presets rather than only typing a note, because
 * the reason has to survive being read by two different audiences at two
 * different moments: the roster, where staff want the short label, and the
 * member's own page and email, where somebody who uploaded the wrong file needs
 * a sentence telling them what to do instead. A free-text box alone gives the
 * second audience whatever a rushed manager typed, which on the evidence of the
 * other free-text fields in this app is frequently nothing at all.
 *
 * The note is additive, never a replacement: it is appended after the preset
 * sentence, so the member always gets a complete explanation and the manager
 * only types when there is something specific to add.
 *
 * Client-safe. The `CertificateRejectionReason` import is type-only and erased
 * at build, so the certificate viewer (a client component) can import the
 * labels without pulling the Prisma runtime into the browser bundle -- while
 * still failing `tsc` the moment this list and the database enum disagree.
 */

import type { CertificateRejectionReason } from "@prisma/client";

export type RejectionReason = CertificateRejectionReason;

export type RejectionReasonDef = {
  value: RejectionReason;
  /** The short label: the picker, and anywhere staff read it. */
  staffLabel: string;
  /**
   * What the member is told, as a complete sentence.
   *
   * Written to be true of the FILE, never of the person: "the file you uploaded
   * is not a HIPAA training certificate", not "you uploaded the wrong thing".
   * The member is about to be asked to do this again, and the copy has to read
   * as a correctable mistake rather than a verdict.
   */
  memberSentence: string;
};

/**
 * Display order for the picker, commonest first. "Not a HIPAA certificate" leads
 * because it is the case this feature was asked for: people upload the Workday
 * transcript, the course completion page, or a screenshot.
 */
export const REJECTION_REASONS: RejectionReasonDef[] = [
  {
    value: "NOT_A_CERTIFICATE",
    staffLabel: "Not a HIPAA certificate",
    memberSentence:
      "The file you uploaded is not a HIPAA training certificate.",
  },
  {
    value: "WRONG_PERSON",
    staffLabel: "Wrong person's certificate",
    memberSentence:
      "The certificate you uploaded is issued to someone else.",
  },
  {
    value: "UNREADABLE",
    staffLabel: "Unreadable or incomplete file",
    memberSentence:
      "We could not read the certificate you uploaded -- it may be incomplete, blank, or too low-resolution.",
  },
  {
    value: "OUT_OF_DATE",
    staffLabel: "Certificate is out of date",
    memberSentence:
      "The certificate you uploaded is out of date, so it does not cover this term.",
  },
  {
    value: "OTHER",
    staffLabel: "Other",
    // Deliberately says nothing specific: OTHER exists for the cases the four
    // presets do not name, and the note is where the manager says what happened.
    memberSentence: "The certificate you uploaded could not be accepted.",
  },
];

const BY_VALUE = new Map(REJECTION_REASONS.map((r) => [r.value, r]));

/** Every value the picker and the service will accept. */
export const REJECTION_REASON_VALUES: RejectionReason[] = REJECTION_REASONS.map((r) => r.value);

/** True when `value` is one of the reasons, narrowing an untrusted form field. */
export function isRejectionReason(value: unknown): value is RejectionReason {
  return typeof value === "string" && BY_VALUE.has(value as RejectionReason);
}

/** The short staff label, e.g. for a roster cell or an audit read-out. */
export function rejectionReasonLabel(value: RejectionReason): string {
  return BY_VALUE.get(value)?.staffLabel ?? "Other";
}

/**
 * The full member-facing explanation: the preset sentence, plus the manager's
 * note when they left one.
 *
 * One function so the HIPAA panel and the rejection email cannot drift into
 * telling the same member two different things about the same certificate --
 * which is exactly how UNKNOWN_DATE ended up with three vocabularies before
 * labels.ts consolidated them.
 */
export function rejectionExplanation(
  reason: RejectionReason | null,
  note: string | null,
): string {
  const base = reason ? (BY_VALUE.get(reason)?.memberSentence ?? "") : "";
  const trimmed = note?.trim() ?? "";
  if (!base) return trimmed || "The certificate you uploaded could not be accepted.";
  return trimmed ? `${base} ${trimmed}` : base;
}

/** Longest note we will store. Generous for a sentence or two, bounded so a
 *  paste cannot put a novel into an email body. */
export const REJECTION_NOTE_MAX = 500;
