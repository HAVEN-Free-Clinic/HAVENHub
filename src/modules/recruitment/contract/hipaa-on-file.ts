import { certExpiresAt, complianceStatus, effectiveCompliance } from "@/platform/compliance/rules";

export type HipaaOnFile = {
  completionDate: Date;
  expiresAt: Date;
  /** The certificate is the newest upload and still waiting for a manager. */
  pendingVerification: boolean;
};

type CertRow = { completionDate: Date | null; verifiedAt: Date | null };

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
 * verification queue.
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
    complianceStatus({ completionDate: newest.completionDate, verifiedAt: now }, termEnd, now) === "COMPLIANT"
  ) {
    return { completionDate: newest.completionDate, expiresAt: certExpiresAt(newest.completionDate), pendingVerification: true };
  }
  return null;
}
