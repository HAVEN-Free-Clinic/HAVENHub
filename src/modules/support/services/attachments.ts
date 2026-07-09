/**
 * Support module attachments service: files attached to a ticket or a
 * comment.
 *
 * Every attachment belongs to exactly one of a TechRequest (requestId) or a
 * TechRequestComment (commentId). Bytes are stored via the shared platform
 * storage abstraction (putObject/getObject); only a storageKey lives on the
 * row.
 *
 * Permission model:
 *   persistAttachment          - trusted caller (submit/comment actions,
 *                                 already gated). Validates the file itself
 *                                 (type/size) and throws SupportForbiddenError
 *                                 on a bad file.
 *   getAttachmentForDownload   - requester or support.manage_requests holder
 *                                 may download. SupportNotFoundError (not
 *                                 Forbidden) for anyone else, matching
 *                                 getTechRequest/listComments, so a stranger
 *                                 cannot distinguish "not found" from "exists
 *                                 but you can't see it". An attachment on an
 *                                 INTERNAL comment additionally requires
 *                                 support.manage_requests.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { TechRequestAttachment } from "@prisma/client";
import { prisma } from "@/platform/db";
import { putObject, getObject } from "@/platform/storage";
import { getSetting } from "@/platform/settings/service";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { MANAGE, SupportForbiddenError, SupportNotFoundError } from "./tech-request";

const DEFAULT_MAX_MB = 10;

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/** `accept` attribute value for support attachment file inputs, kept in sync with ALLOWED_MIME_TYPES. */
export const SUPPORT_UPLOAD_ACCEPT = [...ALLOWED_MIME_TYPES].join(",");

// ---------------------------------------------------------------------------
// validateSupportUpload
// ---------------------------------------------------------------------------

/**
 * Validates a support attachment's declared type and size. Returns an error
 * message string when the file should be rejected, or null when it is
 * acceptable. `maxMb` defaults to 10; callers with the resolved
 * "uploads.maxMb" setting should pass it through.
 */
export function validateSupportUpload(
  file: { fileName: string; mimeType: string; size: number },
  maxMb = DEFAULT_MAX_MB
): string | null {
  if (!ALLOWED_MIME_TYPES.has(file.mimeType)) {
    return "File type not allowed. Attach an image, PDF, text, or Office document.";
  }
  if (file.size > maxMb * 1024 * 1024) {
    return `File is too large (max ${maxMb} MB).`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// persistAttachment
// ---------------------------------------------------------------------------

export type AttachmentTarget = { requestId?: string; commentId?: string };

/**
 * Validates and stores a file attached to a ticket or a comment. Exactly one
 * of target.requestId / target.commentId must be set (the caller decides
 * which; this trusts the caller on ownership, same as addComment/
 * createTechRequest -- the submit/comment actions already gate to the
 * authenticated person). Throws SupportForbiddenError when the file fails
 * validation. Audits "support.attachment_add".
 */
export async function persistAttachment(
  actorPersonId: string,
  target: AttachmentTarget,
  file: { fileName: string; mimeType: string; bytes: Buffer }
): Promise<TechRequestAttachment> {
  const maxMb = (await getSetting<number>("uploads.maxMb")) ?? DEFAULT_MAX_MB;
  const err = validateSupportUpload(
    { fileName: file.fileName, mimeType: file.mimeType, size: file.bytes.length },
    maxMb
  );
  if (err) throw new SupportForbiddenError(err);

  const scope = target.requestId ?? target.commentId!;
  const ext = path.extname(file.fileName).match(/^\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "";
  const key = `support/${scope}/${randomUUID()}${ext}`;
  await putObject(key, file.bytes, file.mimeType);

  const attachment = await prisma.techRequestAttachment.create({
    data: {
      requestId: target.requestId ?? null,
      commentId: target.commentId ?? null,
      storageKey: key,
      filename: file.fileName,
      mimeType: file.mimeType,
      size: file.bytes.length,
      uploadedById: actorPersonId,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "support.attachment_add",
    entityType: "TechRequestAttachment",
    entityId: attachment.id,
  });

  return attachment;
}

// ---------------------------------------------------------------------------
// getAttachmentForDownload
// ---------------------------------------------------------------------------

/**
 * Resolves an attachment's bytes for an authenticated download. Requires the
 * requester or a support.manage_requests holder; an attachment hanging off
 * an INTERNAL comment additionally requires support.manage_requests.
 * Non-leaky: SupportNotFoundError covers "does not exist", "not yours", and
 * "internal note you can't see" alike.
 */
export async function getAttachmentForDownload(
  actorPersonId: string,
  attachmentId: string
): Promise<{ bytes: Buffer; filename: string; mimeType: string }> {
  const attachment = await prisma.techRequestAttachment.findUnique({
    where: { id: attachmentId },
    include: { request: true, comment: { include: { request: true } } },
  });
  if (!attachment) throw new SupportNotFoundError();

  const req = attachment.request ?? attachment.comment?.request;
  if (!req) throw new SupportNotFoundError();

  const manager = await can(actorPersonId, MANAGE);
  if (!manager && req.requesterId !== actorPersonId) throw new SupportNotFoundError();
  if (!manager && attachment.comment?.visibility === "INTERNAL") throw new SupportNotFoundError();

  const bytes = await getObject(attachment.storageKey);
  if (!bytes) throw new SupportNotFoundError();

  return { bytes, filename: attachment.filename, mimeType: attachment.mimeType };
}
