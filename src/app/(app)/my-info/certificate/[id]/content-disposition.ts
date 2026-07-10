/**
 * Build a Content-Disposition header value for a certificate file.
 *
 * - `inline` controls whether the browser renders the file in-page (preview) or
 *   downloads it.
 * - The ASCII `filename` parameter is sanitized (control chars, double-quotes, and
 *   any non-ASCII code point removed, per RFC 6266) and falls back to
 *   "certificate.pdf" if it sanitizes to empty; the RFC 5987 `filename*` parameter
 *   carries the full original name percent-encoded.
 *
 *   Non-ASCII must be stripped from the plain `filename`: a stored fileName can
 *   contain characters outside Latin-1 (e.g. U+202F NARROW NO-BREAK SPACE, which
 *   OS/browser PDF namers insert before AM/PM in timestamps). Left in the header
 *   value, such a character makes constructing the Response's Headers throw a
 *   ByteString TypeError ("value ... greater than 255"), 500-ing the download.
 */
export function certificateContentDisposition(fileName: string, inline: boolean): string {
  const disposition = inline ? "inline" : "attachment";
  // Keep only printable ASCII minus the double-quote, dropping control chars and
  // any non-ASCII code point so the header value stays Latin-1-safe (see above).
  const safeFileName = fileName.replace(/[^\x20-\x7e]|"/g, "").trim() || "certificate.pdf";
  const encodedFileName = encodeURIComponent(fileName);
  return `${disposition}; filename="${safeFileName}"; filename*=UTF-8''${encodedFileName}`;
}
