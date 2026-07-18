/**
 * Build a `Content-Disposition` header value for a served file.
 *
 * - `inline` controls whether the browser renders the file in-page (preview) or
 *   downloads it. Defaults to a download.
 * - `fallbackName` is used for the ASCII `filename` parameter when the original
 *   name sanitizes to empty (e.g. a name made up entirely of stripped chars).
 * - The ASCII `filename` parameter is sanitized (control chars, double-quotes,
 *   and any non-ASCII code point removed, per RFC 6266); the RFC 5987
 *   `filename*` parameter carries the full original name percent-encoded.
 *
 *   Non-ASCII MUST be stripped from the plain `filename`: a stored fileName can
 *   contain characters outside Latin-1 (e.g. U+202F NARROW NO-BREAK SPACE, which
 *   OS/browser namers insert before AM/PM in timestamps). Left in the header
 *   value, such a character makes constructing the Response's Headers throw a
 *   ByteString TypeError ("value ... greater than 255"), 500-ing the download.
 */
export function contentDisposition(
  fileName: string,
  { inline = false, fallbackName = "file" }: { inline?: boolean; fallbackName?: string } = {},
): string {
  const disposition = inline ? "inline" : "attachment";
  // Keep only printable ASCII minus the double-quote, dropping control chars and
  // any non-ASCII code point so the header value stays Latin-1-safe (see above).
  const safeFileName = fileName.replace(/[^\x20-\x7e]|"/g, "").trim() || fallbackName;
  const encodedFileName = encodeURIComponent(fileName);
  return `${disposition}; filename="${safeFileName}"; filename*=UTF-8''${encodedFileName}`;
}
