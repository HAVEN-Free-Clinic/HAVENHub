"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye } from "lucide-react";
import { Alert } from "@/platform/ui/alert";
import { Modal } from "@/platform/ui/modal";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Field, Input } from "@/platform/ui/input";
import { formatForDateInput } from "@/platform/dates";
import { useTimeZone } from "@/platform/dates/client";

type CertificateViewerProps = {
  certId: string;
  fileName: string;
  /** Shown in the header when a manager is viewing someone else's certificate. */
  ownerName?: string;
  /** The cert's current completion date, if any. Controls whether entry is offered. */
  completionDate?: Date | null;
  /** True only when the viewer holds volunteers.manage_compliance. Gates date entry. */
  canEditDate?: boolean;
  /** True only for superadmins. Allows overwriting a date that is already set. */
  canEditExistingDate?: boolean;
  /** Bound server action: (dateIso) => result. Required for entry to render. */
  onSetDate?: (dateIso: string) => Promise<{ error?: string }>;
  /** True when the viewer may verify (holds manage_compliance or admin). */
  canVerify?: boolean;
  /** Whether the cert already carries a verified stamp. */
  verified?: boolean;
  /** Bound server action: () => result. Required for the Verify button to render. */
  onVerify?: () => Promise<{ error?: string }>;
};

/**
 * "View" button that opens a modal previewing the certificate PDF inline. The
 * iframe is only mounted while the modal is open (so roster rows never each load
 * a PDF) and unmounts on close. Download / Open-in-new-tab are provided as
 * fallbacks for browsers that will not render PDFs in an iframe.
 *
 * When canEditDate is true, onSetDate is provided, and the cert has no
 * completion date, a date-entry form appears in the footer so a compliance
 * manager can record the date read off the PDF. Saving also verifies the cert.
 *
 * When canVerify is true, onVerify is provided, and the cert already has a date
 * but no verified stamp (PENDING_VERIFICATION), a Verify button appears so a
 * compliance manager or admin can attest the cert after reviewing the PDF.
 */
export function CertificateViewer({
  certId,
  fileName,
  ownerName,
  completionDate,
  canEditDate,
  canEditExistingDate,
  onSetDate,
  canVerify,
  verified,
  onVerify,
}: CertificateViewerProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const zone = useTimeZone();

  const inlineHref = `/my-info/certificate/${certId}?inline=1`;
  const downloadHref = `/my-info/certificate/${certId}`;
  const title = ownerName ? `${ownerName}: ${fileName}` : fileName;

  const hasDate = Boolean(completionDate);
  const canSetNew = Boolean(canEditDate && onSetDate && !hasDate);
  const canOverwrite = Boolean(canEditExistingDate && onSetDate && hasDate);
  const showForm = canSetNew || (canOverwrite && editing);
  const isOverwrite = canOverwrite && editing;

  // Verify targets the PENDING_VERIFICATION case: a self-uploaded cert that has a
  // date but no verified stamp. Dateless certs verify via "Save and verify"
  // above; already-verified certs need no button.
  const canVerifyNow = Boolean(canVerify && onVerify && hasDate && !verified);

  const currentDateValue = completionDate
    ? completionDate.toISOString().split("T")[0]
    : undefined;

  function handleSubmit(formData: FormData) {
    if (!onSetDate) return;
    const dateIso = (formData.get("completionDate") as string | null) ?? "";
    setError(null);
    startTransition(async () => {
      const result = await onSetDate(dateIso);
      if (result?.error) {
        setError(result.error);
        return;
      }
      setEditing(false);
      setOpen(false);
      router.refresh();
    });
  }

  function handleVerify() {
    if (!onVerify) return;
    setError(null);
    startTransition(async () => {
      const result = await onVerify();
      if (result?.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  // Clinic-local YYYY-MM-DD so the date input's max matches the clinic's "today".
  const today = formatForDateInput(new Date(), zone);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => {
          setError(null);
          setEditing(false);
          setOpen(true);
        }}
      >
        <Eye className="h-4 w-4" />
        View
      </Button>

      {open && (
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title={title}
          footer={
            <div className="flex w-full items-end justify-between gap-3">
              {showForm ? (
                <form action={handleSubmit} className="flex items-end gap-2">
                  <Field label="Completion date">
                    <Input
                      type="date"
                      name="completionDate"
                      required
                      max={today}
                      defaultValue={isOverwrite ? currentDateValue : undefined}
                    />
                  </Field>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={isPending}
                  >
                    {isPending ? "Saving..." : isOverwrite ? "Update and verify" : "Save and verify"}
                  </Button>
                  {isOverwrite && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing(false);
                        setError(null);
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </form>
              ) : canOverwrite || canVerifyNow ? (
                <div className="flex items-center gap-2">
                  {canOverwrite && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setError(null);
                        setEditing(true);
                      }}
                    >
                      Edit date
                    </Button>
                  )}
                  {canVerifyNow && (
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      disabled={isPending}
                      onClick={handleVerify}
                    >
                      {isPending ? "Verifying..." : "Verify"}
                    </Button>
                  )}
                </div>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <a
                  href={inlineHref}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonClasses("ghost", "sm")}
                >
                  Open in new tab
                </a>
                <a href={downloadHref} className={buttonClasses("outline", "sm")}>
                  Download
                </a>
              </div>
            </div>
          }
        >
          {error && (
            <Alert tone="error" className="mb-2">{error}</Alert>
          )}
          <iframe
            src={inlineHref}
            title={`Certificate preview: ${fileName}`}
            className="h-[75vh] w-full rounded-lg border border-border"
          />
        </Modal>
      )}
    </>
  );
}
