/**
 * Mime types we are willing to render inline (preview). Everything else is
 * forced to download even when inline is requested: a stored `text/html` or
 * `image/svg+xml` would be a stored-XSS vector. SVG is intentionally excluded.
 * This is the single source of truth shared by the file-serving route and the
 * speed-score view model so the reviewer's inline iframe and the route's
 * Content-Disposition can never drift.
 */
export const INLINE_SAFE_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function isInlinePreviewable(mimeType: string | null | undefined): boolean {
  return mimeType != null && INLINE_SAFE_MIME_TYPES.has(mimeType);
}
