"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button, buttonClasses } from "@/platform/ui/button";

/** A single uploaded file rendered as an expand-on-demand preview. The iframe is
 *  mounted only while expanded, so a card with several documents does not load
 *  them all at once. Non-inline-previewable types (per the shared allowlist)
 *  offer "Open in new tab" instead of an iframe. */
export function DocumentPreview({
  fileName,
  inlineHref,
  inlinePreviewable,
}: {
  fileName: string;
  inlineHref: string;
  inlinePreviewable: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span className="truncate">{fileName}</span>
        </Button>
        <a href={inlineHref} target="_blank" rel="noopener noreferrer" className={buttonClasses("ghost", "sm")}>
          Open in new tab
        </a>
      </div>
      {open && inlinePreviewable && (
        <iframe
          src={inlineHref}
          title={`Document preview: ${fileName}`}
          className="h-[60vh] w-full rounded-b-lg border-t border-border"
        />
      )}
      {open && !inlinePreviewable && (
        <p className="px-3 pb-3 text-sm text-muted-foreground">
          This file type can&apos;t be previewed inline. Use &ldquo;Open in new tab&rdquo; to view it.
        </p>
      )}
    </div>
  );
}
