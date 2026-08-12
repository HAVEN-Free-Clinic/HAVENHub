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
 *
 * Outbound Intercom sync (Direction 3, Hub-origin half -- see
 * docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md and
 * notifications.ts's pushIntercomTicketState): addComment's requester-reply
 * reopen (RESOLVED -> IN_PROGRESS) is a Hub-origin status change exactly like
 * manage.ts's setStatus, so it pushes the new status onto a linked Intercom
 * Ticket the same way. Without this, a ticket reopened by a requester's reply
 * would leave Intercom reading Resolved forever.
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
import { pushIntercomTicketState } from "./notifications";

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
  // A requester's public reply to a RESOLVED ticket reopens it. The resolution
  // email tells them "reply on the ticket and we'll follow up", but there was no
  // reopen path anywhere and managers hide their controls once a ticket is
  // terminal, so a reply used to succeed into a void: it bumped updatedAt and
  // notified nobody who could act. Reopening to IN_PROGRESS puts it back in the
  // manager queue (notifyCommentAdded already alerts the assignee/managers of a
  // requester comment). CLOSED and CANCELLED are left terminal: no email invites
  // a reply there, and a manager's own note must not reopen the ticket.
  const reopens = !manager && input.visibility === "PUBLIC" && req.status === "RESOLVED";
  const updated = await prisma.techRequest.update({
    where: { id: requestId },
    data: { updatedAt: new Date(), ...(reopens ? { status: "IN_PROGRESS", resolvedAt: null } : {}) },
  });
  await recordAudit({
    actorPersonId,
    action: "support.comment_add",
    entityType: "TechRequest",
    entityId: requestId,
    after: { visibility: input.visibility },
  });
  if (reopens) {
    await recordAudit({
      actorPersonId,
      action: "support.reopen",
      entityType: "TechRequest",
      entityId: requestId,
      before: { status: "RESOLVED" },
      after: { status: "IN_PROGRESS" },
    });
    // This is a Hub-origin status change exactly like setStatus/resolveRequest
    // in manage.ts, and Direction 3 requires every one of those to push onto
    // the linked Intercom Ticket's own state (see pushIntercomTicketState's
    // doc comment) -- without this, a ticket reopened by a requester's reply
    // leaves the Hub reading IN_PROGRESS while Intercom still reads Resolved,
    // permanently. Never throws (pushIntercomTicketState's own posture), so a
    // failed push cannot fail an already-committed comment.
    await pushIntercomTicketState(updated, req.status);
  }
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
    let routedToAssignee = false;
    if (req.assignedToId) {
      const assignee = await prisma.person.findUnique({
        where: { id: req.assignedToId },
        select: { id: true, entraObjectId: true, contactEmail: true, status: true },
      });
      // Only route solely to the assignee if they are still an ACTIVE support
      // manager. An offboarded or de-permissioned assignee lingers on the ticket
      // (the detail UI keeps a former assignee in the select), so without this a
      // requester's reply would reach a stale assignee and no current manager.
      if (assignee && assignee.status === "ACTIVE" && (await can(assignee.id, MANAGE))) {
        recipients.push({ id: assignee.id, entraObjectId: assignee.entraObjectId, contactEmail: assignee.contactEmail });
        routedToAssignee = true;
      }
    }
    if (!routedToAssignee) {
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
