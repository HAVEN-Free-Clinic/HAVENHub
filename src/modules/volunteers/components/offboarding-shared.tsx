import { Alert } from "@/platform/ui/alert";
// Type-only, so the server module is erased at compile time and never bundled.
import type { BulkResult } from "@/modules/volunteers/services/transition-actions";

/**
 * Shared between transition-tab.tsx and flagged-tab.tsx: both tabs run a bulk
 * offboard and both offer a CSV download, so the result alert, the download
 * mechanics, and the filename parsing live here once instead of twice.
 */

/**
 * Alert renders a <p>, whose content model is phrasing content only, so the
 * skip list below cannot be a <ul> (a <ul> is flow content; a browser would
 * auto-close the <p> in front of it, splitting the icon and text out of
 * Alert's bordered box). Each skip reason renders as a block-level <span>
 * instead, which is still phrasing content by tag even though it displays on
 * its own line. The wrapping span carries role="list" and each skip line
 * role="listitem" so a screen reader still announces it as a list even though
 * the markup cannot use <ul>/<li>.
 */
export function BulkResultAlert({
  verb,
  result,
  className,
}: {
  verb: string;
  result: BulkResult | null;
  className?: string;
}) {
  if (!result) return null;
  const tone = result.skipped.length > 0 ? "warning" : "success";
  return (
    <Alert tone={tone} className={className}>
      {result.succeeded.length} {verb}
      {result.skipped.length > 0 && (
        <>
          {", "}
          {result.skipped.length} skipped:
          <span role="list">
            {result.skipped.map((s) => (
              <span key={s.personId} role="listitem" className="mt-1 block pl-3 text-xs">
                {s.name}: {s.reason}
              </span>
            ))}
          </span>
        </>
      )}
    </Alert>
  );
}

/** Pull the filename out of a Content-Disposition header, with a safe default. */
export function filenameFrom(header: string | null): string {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? "offboarding.csv";
}

/**
 * POSTs to the offboarding export route, downloads the response as a CSV via
 * a synthetic anchor click, and revokes the object URL afterward.
 *
 * Throws on a non-OK response rather than reporting its own error, so both
 * callers can show it inline next to their own export button instead of this
 * helper assuming where the message belongs.
 */
export async function downloadCsv(body: unknown): Promise<void> {
  const res = await fetch("/api/volunteers/offboarding/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error("Export failed.");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filenameFrom(res.headers.get("Content-Disposition"));
  link.click();
  URL.revokeObjectURL(url);
}
