/**
 * Build a Content-Disposition header value for a certificate file.
 *
 * - `inline` controls whether the browser renders the file in-page (preview) or
 *   downloads it.
 * - The ASCII `filename` parameter is sanitized (control chars and double-quotes
 *   removed, per RFC 6266) and falls back to "certificate.pdf" if it sanitizes to
 *   empty; the RFC 5987 `filename*` parameter carries the full original name.
 */
export function certificateContentDisposition(fileName: string, inline: boolean): string {
  const disposition = inline ? "inline" : "attachment";
  const safeFileName = fileName.replace(/[\x00-\x1f\x7f"]/g, "").trim() || "certificate.pdf";
  const encodedFileName = encodeURIComponent(fileName);
  return `${disposition}; filename="${safeFileName}"; filename*=UTF-8''${encodedFileName}`;
}
