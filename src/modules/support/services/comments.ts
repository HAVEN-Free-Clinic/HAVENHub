/**
 * Support module comment service: the two-way thread on a TechRequest.
 *
 * Visibility model:
 *   PUBLIC   - visible to the requester and any support.manage_requests holder.
 *   INTERNAL - manager-only; never visible to the requester, never notified.
 *
 * Permission model:
 *   addComment   - a manager may post PUBLIC or INTERNAL on any ticket. A
 *                  non-manager may only post PUBLIC, and only on their own
 *                  ticket (SupportNotFoundError on someone else's ticket, so a
 *                  stranger cannot distinguish "not found" from "exists but
 *                  you can't see it"; SupportForbiddenError for an INTERNAL
 *                  attempt on their own ticket).
 *   listComments - same read gate as getTechRequest (requester or manager);
 *                  INTERNAL rows are filtered out for non-managers.
 */

import type {
  Prisma,
  PrismaClient,
  TechRequest,
  TechRequestComment,
  TechRequestAttachment,
  CommentVisibility,
  Person,
} from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { notify } from "@/platform/notifications/notify";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { getSetting } from "@/platform/settings/service";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { MANAGE, SupportForbiddenError, SupportNotFoundError, SupportStateError } from "./tech-request";

type Db = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// addComment
// ---------------------------------------------------------------------------

export type AddCommentInput = {
  body: string;
  visibility: CommentVisibility;
};

/**
 * Posts a comment on a ticket. Audits "support.comment_add" with visibility
 * in after. Touches the ticket's updatedAt so it resurfaces in
 * updatedAt-sorted lists (My requests, the master queue).
 */
export async function addComment(
  actorPersonId: string,
  requestId: string,
  input: AddCommentInput
): Promise<TechRequestComment> {
  const body = input.body?.trim();
  if (!body) throw new SupportStateError("A comment body is required.");

  const req = await prisma.techRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new SupportNotFoundError();

  const manager = await can(actorPersonId, MANAGE);
  if (!manager) {
    // Do not leak existence to strangers: same treatment as getTechRequest.
    if (req.requesterId !== actorPersonId) throw new SupportNotFoundError();
    if (input.visibility === "INTERNAL") {
      throw new SupportForbiddenError("Only managers can post internal notes.");
    }
  }

  const comment = await prisma.techRequestComment.create({
    data: { requestId, authorId: actorPersonId, body, visibility: input.visibility },
  });
  await prisma.techRequest.update({ where: { id: requestId }, data: { updatedAt: new Date() } });
  await recordAudit({
    actorPersonId,
    action: "support.comment_add",
    entityType: "TechRequest",
    entityId: requestId,
    after: { visibility: input.visibility },
  });
  return comment;
}

// ---------------------------------------------------------------------------
// listComments
// ---------------------------------------------------------------------------

export type CommentRow = TechRequestComment & {
  author: { id: string; name: string | null };
  attachments: TechRequestAttachment[];
};

/**
 * Returns a ticket's comments, oldest first, each with its attachments. Same
 * read gate as getTechRequest (requester or manager; SupportNotFoundError
 * otherwise). INTERNAL rows (and, with them, their attachments) are
 * filtered out for non-managers -- see getAttachmentForDownload for the
 * matching per-attachment enforcement on direct download.
 */
export async function listComments(actorPersonId: string, requestId: string): Promise<CommentRow[]> {
  const req = await prisma.techRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new SupportNotFoundError();
  const manager = await can(actorPersonId, MANAGE);
  if (!manager && req.requesterId !== actorPersonId) throw new SupportNotFoundError();

  return prisma.techRequestComment.findMany({
    where: { requestId, ...(manager ? {} : { visibility: "PUBLIC" }) },
    orderBy: { createdAt: "asc" },
    include: { author: { select: { id: true, name: true } }, attachments: true },
  }) as unknown as Promise<CommentRow[]>;
}

// ---------------------------------------------------------------------------
// notifyCommentAdded
// ---------------------------------------------------------------------------

/**
 * Notifies the other side of the conversation after a comment is posted.
 * INTERNAL comments notify no one. For a PUBLIC comment: the requester's
 * comment notifies the assignee (or every manager if unassigned); a
 * manager's comment notifies the requester. The author is never notified of
 * their own comment.
 */
export async function notifyCommentAdded(
  db: Db,
  req: TechRequest,
  comment: TechRequestComment,
  author: Pick<Person, "id" | "name">
): Promise<void> {
  if (comment.visibility === "INTERNAL") return;

  const baseUrl = (await getSetting<string>("app.baseUrl")) ?? "";
  const link = `${baseUrl}/support/${req.id}`;
  const authorIsRequester = author.id === req.requesterId;

  const recipients: { id: string; entraObjectId: string | null; contactEmail: string | null }[] = [];
  if (authorIsRequester) {
    if (req.assignedToId) {
      const assignee = await prisma.person.findUnique({
        where: { id: req.assignedToId },
        select: { id: true, entraObjectId: true, contactEmail: true },
      });
      if (assignee) recipients.push(assignee);
    } else {
      const managers = await peopleWithAnyPermission([MANAGE]);
      recipients.push(...managers);
    }
  } else {
    const requester = await prisma.person.findUnique({
      where: { id: req.requesterId },
      select: { id: true, entraObjectId: true, contactEmail: true },
    });
    if (requester) recipients.push(requester);
  }

  const rendered = await renderEmail("support.comment_added", {
    ticketNumber: req.number,
    subject: req.subject,
    authorName: author.name ?? "Someone",
    link,
  });

  for (const p of recipients) {
    if (p.id === author.id) continue;
    await notify(db, {
      type: "support.comment_added",
      person: p,
      email: { subject: rendered.subject, html: rendered.html },
      teams: { title: `IT Support #${req.number}: new reply`, summary: req.subject, link },
      triggeredById: author.id,
    });
  }
}
