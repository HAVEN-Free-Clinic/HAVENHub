"use client";

import { useState } from "react";
import { Eye } from "lucide-react";
import { Modal } from "@/platform/ui/modal";
import { buttonClasses } from "@/platform/ui/button";

type CertificateViewerProps = {
  certId: string;
  fileName: string;
  /** Shown in the header when a manager is viewing someone else's certificate. */
  ownerName?: string;
};

/**
 * "View" button that opens a modal previewing the certificate PDF inline. The
 * iframe is only mounted while the modal is open (so roster rows never each load
 * a PDF) and unmounts on close. Download / Open-in-new-tab are provided as
 * fallbacks for browsers that will not render PDFs in an iframe.
 */
export function CertificateViewer({ certId, fileName, ownerName }: CertificateViewerProps) {
  const [open, setOpen] = useState(false);

  const inlineHref = `/my-info/certificate/${certId}?inline=1`;
  const downloadHref = `/my-info/certificate/${certId}`;
  const title = ownerName ? `${ownerName} - ${fileName}` : fileName;

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
            <>
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
            </>
          }
        >
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
