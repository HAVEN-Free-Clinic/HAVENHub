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
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
