/**
 * HipaaPanel: HIPAA certificate upload and history.
 *
 * - Shows the latest certificate with upload date + download link, or
 *   "No certificate on file."
 * - Provides a file input (accept="application/pdf") + Upload button.
 * - Shows full history with date, size, and download link.
 *
 * The server action receives the formData, reads the File, converts to Buffer,
 * and calls saveCertificate. CertificateValidationError is redirected back
 * with ?error=...; success is redirected with ?certSaved=1.
 */

import type { HipaaCertificate } from "@prisma/client";
import Link from "next/link";
import { Input } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";

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
};

export function HipaaPanel({
  certificates,
  uploadAction,
  error,
  certSaved,
}: HipaaPanelProps) {
  const latest = certificates[0] ?? null;
  const history = certificates.slice(1);

  return (
    <div className="space-y-6">
      {/* Latest certificate */}
      <div>
        <h3 className="mb-2 text-sm font-medium text-slate-700">Current Certificate</h3>
        {latest ? (
          <p className="text-sm text-slate-600">
            {latest.source === "IMPORT"
              ? "On file (imported from previous records)"
              : `Uploaded ${formatDate(latest.uploadedAt)}`}{" "}
            <Link
              href={`/my-info/certificate/${latest.id}`}
              className="text-brand hover:underline"
            >
              Download
            </Link>
          </p>
        ) : (
          <p className="text-sm text-slate-400">No certificate on file.</p>
        )}
      </div>

      {/* Upload form */}
      <div>
        <h3 className="mb-2 text-sm font-medium text-slate-700">Upload New Certificate</h3>
        {error && (
          <p
            role="alert"
            className="mb-3 rounded-md border border-critical/20 bg-red-50 px-3 py-2 text-sm text-critical"
          >
            {error}
          </p>
        )}
        {certSaved && (
          <p className="mb-3 text-sm text-success">Certificate uploaded successfully.</p>
        )}
        <form action={uploadAction} className="flex items-end gap-3">
          <div className="flex-1">
            <Input
              type="file"
              name="certificate"
              accept="application/pdf"
              className="cursor-pointer"
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            Upload certificate
          </Button>
        </form>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-slate-700">History</h3>
          <ul className="space-y-1.5">
            {history.map((cert) => (
              <li key={cert.id} className="flex items-center gap-3 text-sm text-slate-600">
                <span>
                  {cert.source === "IMPORT"
                    ? "On file (imported from previous records)"
                    : formatDate(cert.uploadedAt)}
                </span>
                <span className="text-slate-400">{formatSize(cert.size)}</span>
                <Link
                  href={`/my-info/certificate/${cert.id}`}
                  className="text-brand hover:underline"
                >
                  Download
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
