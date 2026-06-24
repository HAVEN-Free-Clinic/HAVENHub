"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";

export function DeleteSiteButton({ action }: { action: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Delete this provider?</span>
        <form action={action}>
          <button
            type="submit"
            className="rounded-lg bg-critical px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700"
          >
            Confirm
          </button>
        </form>
        <button
          onClick={() => setConfirming(false)}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-semibold text-critical transition hover:bg-red-50"
    >
      <Trash2 className="h-4 w-4" aria-hidden />
      Delete
    </button>
  );
}