"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye } from "lucide-react";
import { Modal } from "@/platform/ui/modal";
import { buttonClasses } from "@/platform/ui/button";
import { Field, Input } from "@/platform/ui/input";

type CertificateViewerProps = {
  certId: string;
  fileName: string;
  /** Shown in the header when a manager is viewing someone else's certificate. */
  ownerName?: string;
  /** The cert's current completion date, if any. Controls whether entry is offered. */
  completionDate?: Date | null;
  /** True only when the viewer holds volunteers.manage_compliance. Gates date entry. */
  canEditDate?: boolean;
  /** Bound server action: (dateIso) => result. Required for entry to render. */
  onSetDate?: (dateIso: string) => Promise<{ error?: string }>;
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
 */
export function CertificateViewer({
  certId,
  fileName,
  ownerName,
  completionDate,
  canEditDate,
  onSetDate,
}: CertificateViewerProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const inlineHref = `/my-info/certificate/${certId}?inline=1`;
  const downloadHref = `/my-info/certificate/${certId}`;
  const title = ownerName ? `${ownerName}: ${fileName}` : fileName;

  const showDateEntry = Boolean(canEditDate && onSetDate && !completionDate);

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
      setOpen(false);
      router.refresh();
    });
  }

  const today = new Date().toISOString().split("T")[0];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClasses("outline", "sm", "gap-1.5")}
      >
        <Eye className="h-4 w-4" />
        View
      </button>

      {open && (
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title={title}
          footer={
            <div className="flex w-full items-end justify-between gap-3">
              {showDateEntry ? (
                <form action={handleSubmit} className="flex items-end gap-2">
                  <Field label="Completion date">
                    <Input type="date" name="completionDate" required max={today} />
                  </Field>
                  <button
                    type="submit"
                    disabled={isPending}
                    className={buttonClasses("primary", "sm")}
                  >
                    {isPending ? "Saving..." : "Save and verify"}
                  </button>
                </form>
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
            <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}
          <iframe
            src={inlineHref}
            title={`Certificate preview: ${fileName}`}
            className="h-[75vh] w-full rounded-lg border border-slate-200"
          />
        </Modal>
      )}
    </>
  );
}
