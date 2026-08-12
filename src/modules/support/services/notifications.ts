/**
 * Support module notification helpers.
 *
 * notifyTicketSubmitted fans out on ticket creation: a confirmation email to
 * the requester (skipped for a ticket linked to an Intercom conversation --
 * see its doc comment), then one alert per current holder of
 * support.manage_requests (skipping the requester so a manager who files
 * their own ticket is not double-notified).
 *
 * notifyIntercomStatusChange is the outbound half of the Intercom sync (see
 * docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md, Direction
 * 2): for a ticket linked to a conversation, a status change is told to the
 * member there instead of by email. manage.ts calls this in place of notify()
 * when a ticket has an intercomConversationId.
 */

import type { Prisma, PrismaClient, TechRequest, TechRequestComment, TechRequestStatus, Person } from "@prisma/client";
import { notify } from "@/platform/notifications/notify";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { getSetting } from "@/platform/settings/service";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { postConversationReply } from "@/platform/intercom/conversations";
import { log } from "@/platform/logging";
import { MANAGE } from "./tech-request";
import { CATEGORY_LABELS } from "../labels";
import { STATUS_LABELS } from "../components/status-badge";

type Db = PrismaClient | Prisma.TransactionClient;

function ticketLink(baseUrl: string, id: string): string {
  return `${baseUrl}/support/${id}`;
}

/** Settings are unset in tests; the resolved base URL falls back to "" so links are still well-formed relative paths. */
async function resolveBaseUrl(): Promise<string> {
  return (await getSetting<string>("app.baseUrl")) ?? "";
}

// ---------------------------------------------------------------------------
// Outbound Intercom sync (Direction 2)
// ---------------------------------------------------------------------------

/**
 * AWAITING_YNHH is the one status worth writing custom copy for: Intercom has
 * no native equivalent, and "blocked on Yale New Haven Health, not
 * forgotten" is the single most useful thing a waiting member can be told.
 * Every other status falls back to the generic STATUS_LABELS phrasing below.
 */
const AWAITING_YNHH_MESSAGE =
  "This request is on hold while we wait to hear back from Yale New Haven Health (YNHH). It has not been forgotten -- we will update you here as soon as YNHH responds.";

/**
 * Builds the member-facing text posted into Intercom for a status change.
 * Only ever sees the ticket number, the new status, and the resolution field
 * -- never a TechRequestComment row, so an INTERNAL comment cannot reach this
 * function to begin with (comments have their own, separate notification
 * path -- notifyCommentAdded in comments.ts -- that this sync does not
 * touch). See isPublicComment below for the boundary any future extension
 * that does forward comment content into this message must go through.
 *
 * resolution is a parameter, not read off a TechRequest row, because a
 * reopened ticket (see comments.ts's addComment "reopens" branch) clears
 * resolvedAt but leaves the old resolution text in place -- reading it here
 * would re-surface a stale resolution note on an unrelated later status
 * change. Callers pass resolution only when they are the ones setting it
 * fresh (resolveRequest); a plain setStatus transition never has one to pass.
 */
export function buildIntercomStatusMessage(
  ticketNumber: number,
  status: TechRequestStatus,
  resolution: string | null
): string {
  const headline =
    status === "AWAITING_YNHH"
      ? AWAITING_YNHH_MESSAGE
      : `Your IT Support ticket #${ticketNumber} is now ${STATUS_LABELS[status]}.`;
  return resolution ? `${headline}\n\n${resolution}` : headline;
}

/**
 * Hard boundary for anything sourced from TechRequestComment that might ever
 * reach Intercom. INTERNAL comments are manager-only workspace notes and must
 * never reach a member's conversation -- checked here, at the one place
 * comment content would have to pass through, rather than trusted to
 * whichever caller assembled a comment list having already filtered it
 * correctly. "A filter to apply later" is exactly the failure mode this
 * closes off.
 *
 * Not called by any production path today: buildIntercomStatusMessage above
 * only ever forwards a ticket's status and resolution field, never a comment
 * body, so nothing currently constructs Intercom content from
 * TechRequestComment at all. This is the gate any future extension (e.g.
 * forwarding a manager's public reply alongside a status change) must go
 * through rather than a decision left to be re-derived correctly next time.
 */
export function isPublicComment(comment: Pick<TechRequestComment, "visibility">): boolean {
  return comment.visibility === "PUBLIC";
}

/**
 * Posts a status update into a ticket's linked Intercom conversation.
 * No-op when the ticket has no intercomConversationId -- manage.ts also
 * branches on this before deciding whether to call notify() at all, but this
 * guards independently so the function is safe to call unconditionally too.
 *
 * Never throws. postConversationReply already fails closed (unconfigured,
 * timeout, network error, and non-2xx all resolve to `false`, logged there
 * with the Intercom-facing detail). This wrapper adds the one piece of
 * context a bare Intercom-side log line cannot carry -- which Hub ticket this
 * was for -- so a failure is traceable back to a ticket number without
 * correlating two different logs by conversation id alone.
 */
export async function notifyIntercomStatusChange(
  req: Pick<TechRequest, "id" | "number" | "status" | "intercomConversationId">,
  resolution: string | null = null
): Promise<void> {
  if (!req.intercomConversationId) return;
  const message = buildIntercomStatusMessage(req.number, req.status, resolution);
  const posted = await postConversationReply(req.intercomConversationId, message);
  if (!posted) {
    log.warn("[support] failed to post status update to Intercom conversation", {
      ticketId: req.id,
      ticketNumber: req.number,
      status: req.status,
    });
  }
}

/**
 * Notify on ticket submission: a confirmation to the requester, then a
 * per-person fan-out alert to every current holder of support.manage_requests.
 *
 * The requester confirmation is skipped for a ticket with an
 * intercomConversationId. A ticket opened from a conversation already told
 * the member their number synchronously, in the conversation, as part of
 * creating it (see createTechRequestFromConversation and the
 * from-conversation route) -- an email on top of that would be both
 * redundant and wrong-channel, since the member reached us through chat, not
 * necessarily as a Hub user with an inbox to check. Per the design: "This
 * replaces the requester-facing support email, and only that" -- the manager
 * alert below is a different audience (staff, not the member) and is
 * unaffected.
 */
export async function notifyTicketSubmitted(
  db: Db,
  req: TechRequest,
  requester: Pick<Person, "id" | "name" | "entraObjectId" | "contactEmail">
): Promise<void> {
  const link = ticketLink(await resolveBaseUrl(), req.id);

  if (!req.intercomConversationId) {
    // Confirmation to the requester (its own template + notification type so
    // it reads as a receipt and can be routed independently of the manager
    // alert).
    const conf = await renderEmail("support.ticket_submitted", {
      ticketNumber: req.number,
      subject: req.subject,
      link,
    });
    await notify(db, {
      type: "support.ticket_submitted",
      person: requester,
      email: { subject: conf.subject, html: conf.html },
      teams: { title: `IT Support #${req.number} received`, summary: req.subject, link },
      triggeredById: requester.id,
    });
  }

  // Alert every manager (per-person fan-out), skipping the requester so a
  // manager who files their own ticket does not get a duplicate. The manager
  // alert is a distinct template/type (an actionable "needs triage" notice) and
  // its content is identical for every recipient, so it is rendered once.
  const managers = await peopleWithAnyPermission([MANAGE]);
  const mgr = await renderEmail("support.ticket_manager_alert", {
    ticketNumber: req.number,
    subject: req.subject,
    category: CATEGORY_LABELS[req.category],
    requesterName: requester.name ?? "A volunteer",
    link,
  });
  for (const m of managers) {
    if (m.id === requester.id) continue;
    await notify(db, {
      type: "support.ticket_manager_alert",
      person: m,
      email: { subject: mgr.subject, html: mgr.html },
      teams: { title: `New IT Support #${req.number}`, summary: req.subject, link },
      triggeredById: requester.id,
    });
  }
}
