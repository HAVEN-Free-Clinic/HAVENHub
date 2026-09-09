"use client";

import { CopyButton } from "@/platform/ui/copy-button";

/** Read-only feed address with select-on-focus and a copy button. */
export function FeedUrlField({ value }: { value: string }) {
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
        {/* No errorMessage: the address is on screen in the select-on-focus
            field beside this, so there is nothing to recover. */}
        <CopyButton value={value} />
      </div>
    </div>
  );
}
