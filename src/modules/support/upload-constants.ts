/**
 * Upload constraints for IT Support attachments.
 *
 * Kept in a dependency-free module (no node builtins, no prisma, no storage) so
 * both the client upload form and the server-side validator can import it. If
 * these constants lived in services/attachments.ts, importing them from a client
 * component would pull that server module (and node:fs via @/platform/storage)
 * into the browser bundle and break the build.
 */

/** MIME types accepted for support attachments (client accept list + server validation). */
export const ALLOWED_UPLOAD_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

/** `accept` attribute value for support attachment file inputs. */
export const SUPPORT_UPLOAD_ACCEPT = ALLOWED_UPLOAD_MIME_TYPES.join(",");
