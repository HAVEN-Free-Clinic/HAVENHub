/**
 * HipaaPanel: HIPAA certificate upload, compliance status, and history.
 *
 * - Shows the computed compliance status badge for the latest certificate.
 * - When the latest cert has no completionDate, shows a read-only notice
 *   that a compliance manager will confirm the date (no self-service entry).
 * - Provides a file input (accept="application/pdf") + Upload button.
 * - Shows full history with date, size, and download link.
 *
 * The server action receives the formData, reads the File, converts to Buffer,
 * and calls saveCertificate. CertificateValidationError is redirected back
 * with ?error=...; success is redirected with ?certSaved=1.
 */

import type { HipaaCertificate } from "@prisma/client";
import { Card } from "@/platform/ui/card";
import { Input, Field } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { CertificateViewer } from "@/modules/my-info/components/certificate-viewer";
import { certExpiresAt } from "@/platform/compliance/rules";
import type { ComplianceStatus } from "@/platform/compliance/rules";

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatSize(bytes: number): string {
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
}

type HipaaPanelProps = {
  certificates: HipaaCertificate[];
  uploadAction: (formData: FormData) => Promise<void>;
  error?: string;
  certSaved?: boolean;
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
    return <Badge tone="success">Compliant through {formatDate(expiresAt)}</Badge>;
  }
  if (status === "EXPIRING_SOON") {
    return <Badge tone="warning">Expires {formatDate(expiresAt)}, renew soon</Badge>;
  }
  if (status === "EXPIRED") {
    return <Badge tone="critical">Expired {formatDate(expiresAt)}</Badge>;
  }
  return null;
}

export function HipaaPanel({
  certificates,
  uploadAction,
  error,
  certSaved,
  status,
}: HipaaPanelProps) {
  const latest = certificates[0] ?? null;
  const history = certificates.slice(1);

  return (
    <Card className="space-y-6">
      {/* Latest certificate */}
      <div>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Current Certificate</h3>
        {latest ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm text-foreground-soft">
              <span>
                {latest.source === "IMPORT"
                  ? "On file (imported from previous records)"
                  : `Uploaded ${formatDate(latest.uploadedAt)}`}
              </span>
              <CertificateViewer certId={latest.id} fileName={latest.fileName} />
            </div>
            {/* Compliance status badge */}
            <div className="flex items-center gap-2">
              <StatusBadge status={status} cert={latest} />
              {latest.completionDate && (
                <span className="text-xs text-subtle-foreground">
                  Detected completion date: {formatDate(latest.completionDate)}
                </span>
              )}
            </div>
            {/* Read-only notice when the completion date could not be parsed.
                Members cannot set the date themselves, so the copy is reassuring,
                not imperative (issue #76). */}
            {latest.completionDate === null && (
              <p className="mt-2 text-sm text-muted-foreground">
                A compliance manager will verify the completion date. No action is needed from you.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-subtle-foreground">No certificate on file.</p>
        )}
      </div>

      {/* Upload form */}
      <div>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Upload New Certificate</h3>
        {error && (
          <Alert tone="error" className="mb-3">
            {error}
          </Alert>
        )}
        {certSaved && (
          <Alert tone="success" className="mb-3">
            Certificate uploaded successfully.
          </Alert>
        )}
        <form action={uploadAction} className="flex items-end gap-3">
          <div className="flex-1">
            <Field label="HIPAA certificate (PDF)" hint="PDF only.">
              <Input
                type="file"
                name="certificate"
                accept="application/pdf"
                className="cursor-pointer"
              />
            </Field>
          </div>
          <SubmitButton variant="outline" size="sm" pendingLabel="Uploading…">
            Upload certificate
          </SubmitButton>
        </form>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">History</h3>
          <ul className="space-y-1.5">
            {history.map((cert) => (
              <li key={cert.id} className="flex items-center gap-3 text-sm text-foreground-soft">
                <span>
                  {cert.source === "IMPORT"
                    ? "On file (imported from previous records)"
                    : formatDate(cert.uploadedAt)}
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
