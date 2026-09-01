"use client";

import { useState } from "react";
import { Button } from "@/platform/ui/button";

/**
 * Downloads the directory CSV for whatever the page is currently showing.
 *
 * A POST + fetch + synthetic anchor rather than a plain `<a href>`: the export
 * is audited server-side, and a bare link is something a browser prefetches,
 * a user bookmarks, and a chat client unfurls -- each of which would write an
 * audit row for a download nobody performed, and the last of which would hand
 * the file to whoever saw the message. Same reasoning as the offboarding
 * export, whose download helper this mirrors.
 */
export function DirectoryExportButton({
  body,
  label,
  disabled,
}: {
  /** Sent verbatim as the request body; the route validates it. */
  body: Record<string, string | undefined>;
  label: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    let url: string | null = null;
    try {
      const res = await fetch("/api/volunteers/directory/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Export failed.");
      const blob = await res.blob();
      url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFrom(res.headers.get("Content-Disposition"));
      link.click();
    } catch {
      setError("Export failed. Try again, or tell IT if it keeps happening.");
    } finally {
      // Revoked in `finally` rather than straight after click(): an exception
      // between createObjectURL and click() would otherwise leak the blob for
      // the life of the document.
      if (url) URL.revokeObjectURL(url);
      setBusy(false);
    }
  }

  return (
    <div>
      <Button variant="outline" size="sm" onClick={download} disabled={busy || disabled}>
        {busy ? "Preparing…" : label}
      </Button>
      {error && (
        <p role="status" className="mt-1 text-xs text-critical">
          {error}
        </p>
      )}
    </div>
  );
}

/** Pull the filename out of a Content-Disposition header, with a safe default. */
function filenameFrom(header: string | null): string {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? "directory.csv";
}
