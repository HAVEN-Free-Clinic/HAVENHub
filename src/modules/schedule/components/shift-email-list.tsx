"use client";

/**
 * A copyable list of the addresses for everyone on a shift.
 *
 * Reproductive health has had one of these in its readiness panel for a while,
 * and it is the single thing directors of the other departments asked for most:
 * mailing your own Saturday should not mean opening the roster and typing
 * fourteen addresses by hand. This is that control, department-agnostic.
 *
 * Renders the addresses as readable text as well as copying them, because the
 * clipboard is not available in every context (an insecure origin, a locked-down
 * browser) and a director staring at a Copy button that silently did nothing has
 * no fallback. Select-on-focus makes the manual path a keystroke rather than a
 * drag.
 */

import { useState } from "react";
import { Button } from "@/platform/ui/button";
import { Textarea } from "@/platform/ui/input";

type Props = {
  emails: string[];
  /** Section label, e.g. "Shift emails" or "Clinic emails". */
  label: string;
  /** Shown in place of the field when the list is empty. */
  emptyLabel?: string;
};

export function ShiftEmailList({ emails, label, emptyLabel = "Nobody on shift yet." }: Props) {
  const [copied, setCopied] = useState(false);
  // Comma-space, which is what Outlook, Gmail and Apple Mail all accept in a To:
  // field. Semicolons work in Outlook alone.
  const value = emails.join(", ");

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground-soft">
          {label}
          {emails.length > 0 && (
            <span className="ml-1 font-normal text-subtle-foreground">
              ({emails.length})
            </span>
          )}
        </span>
        {emails.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="px-2 py-0.5 text-xs"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              } catch {
                // Clipboard denied or unavailable. The addresses are on screen
                // and selectable, so there is nothing to recover from and
                // nothing worth interrupting the director with.
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
      </div>
      {emails.length === 0 ? (
        <p className="text-sm text-subtle-foreground italic">{emptyLabel}</p>
      ) : (
        <Textarea
          readOnly
          rows={3}
          value={value}
          aria-label={label}
          onFocus={(e) => e.currentTarget.select()}
          className="resize-y px-2 py-1.5 text-xs text-foreground-soft [overflow-wrap:anywhere]"
        />
      )}
    </div>
  );
}
