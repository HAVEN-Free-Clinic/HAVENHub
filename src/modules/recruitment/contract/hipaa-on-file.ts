import { certExpiresAt, complianceStatus, effectiveCompliance } from "@/platform/compliance/rules";

export type HipaaOnFile = {
  completionDate: Date;
  expiresAt: Date;
  /** The certificate is the newest upload and still waiting for a manager. */
  pendingVerification: boolean;
};

type CertRow = { completionDate: Date | null; verifiedAt: Date | null; rejectedAt: Date | null };

/**
 * The certificate on file that lets an onboarding contract skip the HIPAA upload,
 * or null when the contract has to ask for one.
 *
 * Uses compliance's own rule (effectiveCompliance) against the term the contract
 * is for, so onboarding never waves through a certificate the compliance page
 * would then flag: it must be COMPLIANT, meaning valid through the term's end
 * plus the buffer and not already inside the renewal window.
 *
 * One addition: a newest upload still waiting for verification counts when its
 * date would be COMPLIANT once verified. The volunteer already sent that
 * certificate, and asking for it again would only put a duplicate in the same
 * verification queue. A REJECTED upload is excluded from that courtesy: the
 * clinic has refused it, so asking again is exactly the right thing to do.
 *
 * `certs` must be newest-first (uploadedAt desc), as effectiveCompliance requires.
 */
export function hipaaOnFileFor(certs: CertRow[], termEnd: Date | null, now: Date = new Date()): HipaaOnFile | null {
  const { status, cert } = effectiveCompliance(certs, termEnd, now);
  if (status === "COMPLIANT" && cert?.completionDate) {
    return { completionDate: cert.completionDate, expiresAt: certExpiresAt(cert.completionDate), pendingVerification: false };
  }
  const newest = certs[0];
  if (
    newest?.completionDate &&
    newest.verifiedAt === null &&
    // A refused upload is not "already sent, just waiting on us". Skipping this
    // check would let the date parsed out of the very file the clinic rejected
    // wave the applicant past the contract's HIPAA step.
    newest.rejectedAt === null &&
    // Hypothetical: would this date clear them ONCE a manager verifies it?
    // rejectedAt is null here by the guard above, so passing null states that
    // deliberately rather than smuggling a value into a what-if.
    complianceStatus(
      { completionDate: newest.completionDate, verifiedAt: now, rejectedAt: null },
      termEnd,
      now,
    ) === "COMPLIANT"
  ) {
    return { completionDate: newest.completionDate, expiresAt: certExpiresAt(newest.completionDate), pendingVerification: true };
  }
  return null;
}
