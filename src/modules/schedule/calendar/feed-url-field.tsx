"use client";

import { useState } from "react";
import { Button } from "@/platform/ui/button";

/** Read-only feed address with select-on-focus and a copy button. */
export function FeedUrlField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    // ph-no-capture: this field's value is the member's live, non-expiring
    // feed token. posthog-js's default input masking already covers the raw
    // input value, but that default is a global setting someone could change
    // later without knowing this field depends on it. Marking the wrapper
    // itself keeps this specific field masked in session replay and out of
    // autocapture regardless of that global default.
    <div className="ph-no-capture min-w-0 flex-1">
      <label htmlFor="calendar-feed-url" className="block text-xs font-medium text-subtle-foreground">
        Calendar feed address
      </label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id="calendar-feed-url"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          // eslint-disable-next-line no-restricted-syntax -- read-only monospace feed address, not an editable form Input
          className="min-w-0 flex-1 rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground-soft"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            } catch {
              // Clipboard denied or unavailable. Same call as email-list.tsx:
              // the address is on screen in a select-on-focus field, so there
              // is nothing to recover and nothing worth interrupting for. The
              // label simply stays "Copy" rather than claiming a copy happened.
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        {/* See email-list.tsx: the focused button's own label change is not
            reliably re-announced, so a polite region carries it instead. */}
        <span role="status" className="sr-only">
          {copied ? "Copied to clipboard" : ""}
        </span>
      </div>
    </div>
  );
}
