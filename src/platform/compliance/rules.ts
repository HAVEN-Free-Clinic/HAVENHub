/**
 * Pure compliance rules - no database access, no side effects.
 *
 * Validity rule:  a certificate is good for 365 days from completion.
 * Term bar:       must remain valid through termEnd + 30 days.
 * Renewal warning: within 60 days of expiry as of today.
 */

export const CERT_VALIDITY_DAYS = 365;
export const TERM_END_BUFFER_DAYS = 30;
export const RENEWAL_WARNING_DAYS = 60;

/** Milliseconds per day, used for arithmetic throughout. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Returns the date on which the certificate expires.
 * expiresAt = completionDate + CERT_VALIDITY_DAYS days (exact milliseconds).
 */
export function certExpiresAt(completionDate: Date): Date {
  return new Date(completionDate.getTime() + CERT_VALIDITY_DAYS * MS_PER_DAY);
}

/**
 * The resolved training state for a volunteer in a given term.
 * PENDING unless the person has a COMPLETE VolunteerTraining row for the term.
 */
export type TrainingState = "COMPLETE" | "PENDING";

/**
 * The computed compliance status. Never stored; always re-derived from data.
 *
 *   NO_CERTIFICATE   no cert record on file
 *   UNKNOWN_DATE     cert on file but no completionDate parsed yet
 *   EXPIRED          expiresAt < now
 *   EXPIRING_SOON    valid today but fails the term bar, OR expiresAt within 60d of now
 *   COMPLIANT        expiresAt >= termEnd + 30d (with term) OR expiresAt >= now + 60d (no term)
 *                    AND in both cases expiresAt >= now (not expired)
 */
export type ComplianceStatus =
  | "COMPLIANT"
  | "EXPIRING_SOON"
  | "EXPIRED"
  | "UNKNOWN_DATE"
  | "NO_CERTIFICATE";

/**
 * Compute the compliance status for a person.
 *
 * @param cert     The most recent certificate on file, or null if none exists.
 * @param termEnd  The end date of the active term, or null if no active term.
 * @param now      The reference point in time (defaults to Date.now()).
 */
export function complianceStatus(
  cert: { completionDate: Date | null } | null,
  termEnd: Date | null,
  now: Date = new Date()
): ComplianceStatus {
  if (cert === null) return "NO_CERTIFICATE";
  if (cert.completionDate === null) return "UNKNOWN_DATE";

  const expiresAt = certExpiresAt(cert.completionDate);
  const nowMs = now.getTime();
  const expiresMs = expiresAt.getTime();

  // EXPIRED: expiresAt < now (strictly less than; equality is not expired)
  if (expiresMs < nowMs) return "EXPIRED";

  // At this point the cert is valid today. Determine COMPLIANT vs EXPIRING_SOON.
  //
  // Renewal warning threshold: expiresAt < now + 60d -> EXPIRING_SOON regardless of term bar.
  const renewalThresholdMs = nowMs + RENEWAL_WARNING_DAYS * MS_PER_DAY;

  if (termEnd !== null) {
    // Term bar: expiresAt >= termEnd + 30d
    const termBarMs = termEnd.getTime() + TERM_END_BUFFER_DAYS * MS_PER_DAY;
    const meetsTermBar = expiresMs >= termBarMs;
    const meetsRenewalBar = expiresMs >= renewalThresholdMs;

    if (meetsTermBar && meetsRenewalBar) return "COMPLIANT";
    return "EXPIRING_SOON";
  }

  // No active term: COMPLIANT iff expiresAt >= now + 60d
  if (expiresMs >= renewalThresholdMs) return "COMPLIANT";
  return "EXPIRING_SOON";
}

/** The combined clearance a volunteer needs to be active for the term: a valid
 *  certificate AND completed training. The certificate-specific ComplianceStatus
 *  values are unchanged; this only combines them with training. */
export type OverallClearance = "CLEARED" | "NOT_CLEARED";

export function overallClearance(
  certStatus: ComplianceStatus,
  training: TrainingState
): OverallClearance {
  const certValid = certStatus === "COMPLIANT" || certStatus === "EXPIRING_SOON";
  return certValid && training === "COMPLETE" ? "CLEARED" : "NOT_CLEARED";
}
