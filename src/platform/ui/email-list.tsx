"use client";

/**
 * A copyable list of addresses.
 *
 * Reproductive health had one of these in its readiness panel for a while, and
 * it is the single thing directors of the other departments asked for most:
 * mailing your own Saturday should not mean opening the roster and typing
 * fourteen addresses by hand. It then turned out the Saturday was the easy half
 * -- "how do I mail every SCTM, not just this clinic day's" had no answer at
 * all -- so this lives in platform/ui now and the people directory uses it too.
 *
 * Renders the addresses as readable text as well as copying them, because the
 * clipboard is not available in every context (an insecure origin, a locked-down
 * browser) and a director staring at a Copy button that silently did nothing has
 * no fallback. Select-on-focus makes the manual path a keystroke rather than a
 * drag.
 */

import { CopyButton } from "@/platform/ui/copy-button";
import { Textarea } from "@/platform/ui/input";

type Props = {
  emails: string[];
  /** Section label, e.g. "Shift emails" or "Clinic emails". */
  label: string;
  /** Shown in place of the field when the list is empty. */
  emptyLabel?: string;
  /** Rows for the address box. Longer lists deserve a taller default. */
  rows?: number;
  /** Optional line under the label, e.g. what the list is scoped to. */
  hint?: string;
};

export function EmailList({
  emails,
  label,
  emptyLabel = "Nobody on shift yet.",
  rows = 3,
  hint,
}: Props) {
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
        {/* No errorMessage: the addresses are on screen in a select-on-focus
            box below, so a refused clipboard costs one drag and is not worth
            interrupting a director over. CopyButton stays silent and, more to
            the point, does not claim a copy that did not happen. */}
        {emails.length > 0 && <CopyButton value={value} buttonClassName="px-2 py-0.5 text-xs" />}
      </div>
      {hint && <p className="text-xs text-subtle-foreground">{hint}</p>}
      {emails.length === 0 ? (
        <p className="text-sm text-subtle-foreground italic">{emptyLabel}</p>
      ) : (
        <Textarea
          readOnly
          rows={rows}
          value={value}
          aria-label={label}
          onFocus={(e) => e.currentTarget.select()}
          className="resize-y px-2 py-1.5 text-xs text-foreground-soft [overflow-wrap:anywhere]"
        />
      )}
    </div>
  );
}
