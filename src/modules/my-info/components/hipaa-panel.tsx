/**
 * HipaaPanel: HIPAA certificate upload, compliance status, and history.
 *
 * - Shows the computed compliance status badge for the latest certificate.
 * - While the latest cert is under review (UNKNOWN_DATE or
 *   PENDING_VERIFICATION), shows a read-only notice explaining the wait; no
 *   self-service date entry exists. PENDING_VERIFICATION also offers a
 *   support fallback for a wait that runs long.
 * - Provides a file input (accept="application/pdf") + Upload button,
 *   collapsed behind a "Replace this certificate" disclosure while under
 *   review, since uploading again would not speed anything up.
 * - Shows full history with date, size, and download link.
 *
 * The server action receives the formData, reads the File, converts to Buffer,
 * and calls saveCertificate. CertificateValidationError is redirected back
 * with ?error=...; success is redirected with ?certSaved=1, which pops a toast
 * via the flash classifier's `certSaved` registry entry rather than this
 * component rendering its own inline confirmation.
 */

import type { HipaaCertificate } from "@prisma/client";
import { Card } from "@/platform/ui/card";
import { Field } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Badge } from "@/platform/ui/badge";
import { FormActions } from "@/platform/ui/form";
import { CertificateViewer } from "@/modules/my-info/components/certificate-viewer";
import { certExpiresAt, hipaaNeedsTrainingLink } from "@/platform/compliance/rules";
import type { ComplianceStatus } from "@/platform/compliance/rules";
import { SectionHeader } from "@/platform/ui/section-header";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatCalendarDate, formatDateOnly } from "@/platform/dates";
import { ExternalLinkButton } from "@/platform/ui/external-link-button";
import { WORKDAY_LEARNING_URL } from "@/platform/external-links";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";

function formatSize(bytes: number): string {
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
}

type HipaaPanelProps = {
  certificates: HipaaCertificate[];
  uploadAction: (formData: FormData) => Promise<void>;
  status: ComplianceStatus;
};

function StatusBadge({ status, cert }: { status: ComplianceStatus; cert: HipaaCertificate | null }) {
  if (status === "NO_CERTIFICATE") {
    return null; // handled below
  }
  if (status === "UNKNOWN_DATE") {
    return <Badge tone="default">Completion date pending</Badge>;
  }
  if (status === "PENDING_VERIFICATION") {
    return <Badge tone="warning">Awaiting verification</Badge>;
  }
  if (!cert?.completionDate) return null;
  const expiresAt = certExpiresAt(cert.completionDate);
  if (status === "COMPLIANT") {
    return <Badge tone="success">Compliant through {formatCalendarDate(expiresAt)}</Badge>;
  }
  if (status === "EXPIRING_SOON") {
    return <Badge tone="warning">Expires {formatCalendarDate(expiresAt)}, renew soon</Badge>;
  }
  if (status === "EXPIRED") {
    return <Badge tone="critical">Expired {formatCalendarDate(expiresAt)}</Badge>;
  }
  return null;
}

export async function HipaaPanel({
  certificates,
  uploadAction,
  status,
}: HipaaPanelProps) {
  const [zone, support] = await Promise.all([getDisplayTimeZone(), getSupportContact()]);
  const latest = certificates[0] ?? null;
  const history = certificates.slice(1);
  // While a certificate is under review, re-uploading does nothing: it does not
  // speed up a manager confirming or setting the date. Collapse the section
  // behind a disclosure so it stops reading as the obvious next step, without
  // removing it or gating it behind a permission (a member who uploaded the
  // wrong file must still be able to fix it).
  const underReview = status === "PENDING_VERIFICATION" || status === "UNKNOWN_DATE";

  const uploadForm = (
    <>
      {hipaaNeedsTrainingLink(status) && (
        <div className="mb-3 space-y-2">
          <p className="text-sm text-foreground-soft">
            Complete or renew your HIPAA training in Workday, then upload the certificate below.
          </p>
          <ExternalLinkButton href={WORKDAY_LEARNING_URL} variant="primary">
            Complete HIPAA training in Workday
          </ExternalLinkButton>
        </div>
      )}
      <form action={uploadAction}>
        <Field label="HIPAA certificate (PDF)" hint="PDF only.">
          {/* eslint-disable-next-line no-restricted-syntax -- native file input with file-button pseudo-element styling (file:* classes); no file primitive exists */}
          <input type="file" name="certificate" accept="application/pdf" className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong" />
        </Field>
        <FormActions>
          <SubmitButton variant="outline" size="sm" pendingLabel="Uploading…">
            Upload certificate
          </SubmitButton>
        </FormActions>
      </form>
    </>
  );

  return (
    <Card className="space-y-6">
      {/* Latest certificate */}
      <div>
        <SectionHeader as="h3" className="mb-2">Current Certificate</SectionHeader>
        {latest ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm text-foreground-soft">
              <span>
                {latest.source === "IMPORT"
                  ? "On file (imported from previous records)"
                  : `Uploaded ${formatDateOnly(latest.uploadedAt, zone)}`}
              </span>
              <CertificateViewer certId={latest.id} fileName={latest.fileName} />
            </div>
            {/* Compliance status badge */}
            <div className="flex items-center gap-2">
              <StatusBadge status={status} cert={latest} />
              {latest.completionDate && (
                <span className="text-xs text-subtle-foreground">
                  Detected completion date: {formatCalendarDate(latest.completionDate)}
                </span>
              )}
            </div>
            {/* Read-only notice while a certificate is under review. Members
                cannot set or confirm the date themselves, so the copy explains
                the wait instead of asking for action (issue #76). Both branches
                cover the full IN_PROGRESS range on the checklist; only this
                panel knows which substate applies.

                The `latest.completionDate === null` half of this condition is
                load-bearing on its own: `status` is the effective (fallback)
                status for the whole history, so a returning member's early
                renewal that fails to parse while their prior verified cert is
                still valid reads as COMPLIANT overall even though the newest
                file is dateless and unacknowledged otherwise. */}
            {(status === "UNKNOWN_DATE" || latest.completionDate === null) && (
              <p className="mt-2 text-sm text-muted-foreground">
                We could not read a completion date from this file, so a compliance manager will
                set it. No action is needed from you.
              </p>
            )}
            {status === "PENDING_VERIFICATION" && (
              <p className="mt-2 text-sm text-muted-foreground">
                We have your certificate and read a completion date of{" "}
                {latest.completionDate ? formatCalendarDate(latest.completionDate) : "the date on the file"}.
                A compliance manager confirms it before you are cleared. We will let you know when that
                happens, and you do not need to upload it again.
              </p>
            )}
            {status === "PENDING_VERIFICATION" && support.email && (
              <p className="mt-1 text-sm text-muted-foreground">
                If this is taking longer than expected,{" "}
                <SupportLink email={support.email}>{support.label}</SupportLink>.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-subtle-foreground">No certificate on file.</p>
        )}
      </div>

      {/* Upload form: collapsed behind a disclosure while a certificate is
          under review (PENDING_VERIFICATION/UNKNOWN_DATE), since it is not the
          next useful action during that wait. Fully expanded in every other
          status, including EXPIRED and NO_CERTIFICATE, where uploading is
          exactly what to do next. */}
      <div>
        {underReview ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium text-foreground-soft">
              Replace this certificate
            </summary>
            <div className="mt-3">{uploadForm}</div>
          </details>
        ) : (
          <>
            <SectionHeader as="h3" className="mb-2">Upload New Certificate</SectionHeader>
            {uploadForm}
          </>
        )}
      </div>

      {/* History */}
      {history.length > 0 && (
        <div>
          <SectionHeader as="h3" className="mb-2">History</SectionHeader>
          <ul className="space-y-1.5">
            {history.map((cert) => (
              <li key={cert.id} className="flex items-center gap-3 text-sm text-foreground-soft">
                <span>
                  {cert.source === "IMPORT"
                    ? "On file (imported from previous records)"
                    : formatDateOnly(cert.uploadedAt, zone)}
                </span>
                <span className="text-subtle-foreground">{formatSize(cert.size)}</span>
                <CertificateViewer certId={cert.id} fileName={cert.fileName} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
