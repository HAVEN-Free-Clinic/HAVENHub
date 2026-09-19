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
 * PENDING unless the person has a COMPLETE Training row for the term.
 */
export type TrainingState = "COMPLETE" | "PENDING";

/**
 * The computed compliance status. Never stored; always re-derived from data.
 *
 *   NO_CERTIFICATE       no cert record on file
 *   REJECTED             a compliance manager refused the file (not a certificate,
 *                        wrong person, unreadable). Never counts toward clearance.
 *   UNKNOWN_DATE         cert on file but no completionDate parsed yet
 *   PENDING_VERIFICATION cert has a completionDate but has not been verified by a coordinator
 *   EXPIRED              expiresAt < now (verified cert)
 *   EXPIRING_SOON        valid today but fails the term bar, OR expiresAt within 60d of now
 *   COMPLIANT            expiresAt >= termEnd + 30d (with term) OR expiresAt >= now + 60d (no term)
 *                        AND in both cases expiresAt >= now (not expired)
 */
export type ComplianceStatus =
  | "COMPLIANT"
  | "EXPIRING_SOON"
  | "EXPIRED"
  | "UNKNOWN_DATE"
  | "PENDING_VERIFICATION"
  | "REJECTED"
  | "NO_CERTIFICATE";

/**
 * The certificate fields every rule in this module reads.
 *
 * `rejectedAt` is REQUIRED, not optional, and that is the point: a caller that
 * selects only completionDate/verifiedAt would read a refused certificate as a
 * perfectly good one and silently clear somebody the clinic rejected. Making it
 * required moves that into tsc, so every query that feeds these rules has to say
 * out loud that it fetched the column. Two separate queries computing "the
 * effective certificate" from differently-shaped data is the exact drift that
 * made campaign audiences disagree with the compliance page once already
 * (see effectiveCompliance below).
 */
export type CertFacts = {
  completionDate: Date | null;
  verifiedAt: Date | null;
  rejectedAt: Date | null;
};

/**
 * Whether to show the "complete HIPAA training in Workday" link for a status.
 * True when the person must (re)take the course or go back for the right file:
 * no cert on file, expired, expiring soon, or rejected. False when a cert is on
 * file awaiting a manager (UNKNOWN_DATE, PENDING_VERIFICATION) or already
 * compliant, where sending them back to the course would misdirect.
 *
 * REJECTED is on the true side even though the member may not need to retake
 * anything: Workday is where the real certificate is downloaded, and somebody
 * who just uploaded the course transcript by mistake is precisely the person who
 * needs to be shown where the actual certificate lives.
 */
export function hipaaNeedsTrainingLink(status: ComplianceStatus): boolean {
  return (
    status === "NO_CERTIFICATE" ||
    status === "REJECTED" ||
    status === "EXPIRED" ||
    status === "EXPIRING_SOON"
  );
}

/**
 * Compute the compliance status for a person.
 *
 * @param cert     The most recent certificate on file, or null if none exists.
 * @param termEnd  The end date of the active term, or null if no active term.
 * @param now      The reference point in time (defaults to Date.now()).
 */
export function complianceStatus(
  cert: CertFacts | null,
  termEnd: Date | null,
  now: Date = new Date()
): ComplianceStatus {
  if (cert === null) return "NO_CERTIFICATE";
  // Rejection outranks every other fact about the certificate, including the
  // verified stamp. A manager may refuse a cert that was verified earlier (it
  // turned out to be the wrong person's), and that has to revoke what the stamp
  // was providing rather than be outvoted by it. The stamp itself is left on the
  // row deliberately -- it is the record of who accepted it first -- so this
  // ordering is the only thing keeping a withdrawn certificate withdrawn.
  if (cert.rejectedAt !== null) return "REJECTED";
  if (cert.completionDate === null) return "UNKNOWN_DATE";
  // A self-asserted date does not count toward clearance until a human verifies it.
  // Precedes the expiry math: we do not compute expiry from an unconfirmed date.
  if (cert.verifiedAt === null) return "PENDING_VERIFICATION";

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

/**
 * Compliance status over a person's full certificate history. Prefers the newest
 * cert, but when that newest cert is an unverified (early) renewal, falls back to
 * the most recent still-valid VERIFIED cert. Uploading a fresh cert before the old
 * one expires must not revoke clearance while the new upload awaits verification.
 * `certs` must be newest-first (uploadedAt desc).
 *
 * The fallback triggers for PENDING_VERIFICATION, UNKNOWN_DATE and REJECTED: each
 * means "the newest upload is not a usable clearance" (unverified, its completion
 * date could not be read, or a manager refused it), NOT that the older verified
 * cert stopped being valid. Without UNKNOWN_DATE in the fallback, a dateless
 * renewal upload short-circuited and returned UNKNOWN_DATE, un-clearing a
 * volunteer whose prior verified cert was still valid and locking them out of the
 * hub. REJECTED joins them for exactly that reason: a member who uploads the
 * wrong file for NEXT year's renewal must not lose the certificate that is
 * covering them right now, or refusing a stray upload would un-clear somebody
 * mid-term as a side effect. deriveHipaaTaskState no longer bundles UNKNOWN_DATE
 * into the same terminal state as NO_CERTIFICATE, but the task remains
 * unsatisfied and still blocks onboarding until a manager acts on it.
 */
export function effectiveComplianceStatus(
  certs: CertFacts[],
  termEnd: Date | null,
  now: Date = new Date()
): ComplianceStatus {
  return effectiveCompliance(certs, termEnd, now).status;
}

/**
 * effectiveComplianceStatus, plus the certificate the status actually came from.
 *
 * The status alone is not enough for any caller that also wants to SHOW an expiry
 * date, and every one of them reached for `certs[0]` instead. That is the wrong
 * cert precisely when the fallback above fires: mid-renewal, the status describes
 * the older still-valid VERIFIED cert while certs[0] is the new unverified upload,
 * so the HIPAA panel badged "Compliant through <a year out>" and the weekly
 * reminder advertised the same far-off date, to a member whose real coverage runs
 * out next month (audit 14, L3 / hipaa-badge-expiry-from-unverified-cert).
 *
 * `cert` is null only when there are no certificates at all; otherwise it is the
 * row whose completionDate the status was computed from, so
 * `certExpiresAt(cert.completionDate)` is the date that status is about. Callers
 * that need to say something about the newest UPLOAD (e.g. "your renewal is
 * awaiting verification") should read certs[0] themselves, deliberately.
 */
export function effectiveCompliance<T extends CertFacts>(
  certs: T[],
  termEnd: Date | null,
  now: Date = new Date()
): { status: ComplianceStatus; cert: T | null } {
  if (certs.length === 0) return { status: complianceStatus(null, termEnd, now), cert: null };
  const newest = certs[0];
  const newestStatus = complianceStatus(newest, termEnd, now);
  if (
    newestStatus !== "PENDING_VERIFICATION" &&
    newestStatus !== "UNKNOWN_DATE" &&
    newestStatus !== "REJECTED"
  ) {
    return { status: newestStatus, cert: newest };
  }
  for (const cert of certs) {
    // Neither an unverified nor a refused certificate can serve as the fallback.
    // The rejected guard is not merely defensive: complianceStatus would return
    // REJECTED for such a row and the test below would drop it anyway, but saying
    // it here keeps "what may stand in as a clearance" readable in one place.
    if (cert.rejectedAt !== null) continue;
    if (cert.verifiedAt === null) continue;
    const status = complianceStatus(cert, termEnd, now);
    if (status === "COMPLIANT" || status === "EXPIRING_SOON") return { status, cert };
  }
  return { status: newestStatus, cert: newest };
}

/** The combined clearance a member needs to be active for the term: a valid
 *  certificate AND all required trainings complete. */
export type OverallClearance = "CLEARED" | "NOT_CLEARED";

export function overallClearance(
  certStatus: ComplianceStatus,
  allRequiredTrainingsComplete: boolean
): OverallClearance {
  const certValid = certStatus === "COMPLIANT" || certStatus === "EXPIRING_SOON";
  return certValid && allRequiredTrainingsComplete ? "CLEARED" : "NOT_CLEARED";
}
