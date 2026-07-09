/**
 * Support module manager-action service: the controls a support.manage_requests
 * holder uses to work a ticket (assign, change status/priority, resolve,
 * cancel), plus the requester's own self-service cancel.
 *
 * Permission model:
 *   ENFORCED internally (call-site cannot bypass):
 *     assignRequest, setStatus, setPriority, resolveRequest, cancelRequest -
 *     support.manage_requests
 *   TRUSTED caller ownership check:
 *     cancelOwnRequest - the requester cancels their own ticket; a ticket that
 *     is not theirs is treated as SupportNotFoundError (same
 *     "don't leak existence to strangers" convention as getTechRequest).
 *
 * State machine:
 *   CLOSED and CANCELLED are terminal. setStatus, resolveRequest, and
 *   cancelRequest/cancelOwnRequest all refuse to touch a ticket already in a
 *   terminal state (SupportStateError).
 *
 * Every mutation is audited. assignRequest, setStatus(AWAITING_REQUESTER),
 * and resolveRequest also notify (render once, then notify the one recipient);
 * setPriority and the two cancel paths are quiet administrative actions with
 * no notification, matching cancelRequest in epic.ts.
 */

import type { TechRequest, TechRequestStatus, TechRequestPriority } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { notify } from "@/platform/notifications/notify";
import { getSetting } from "@/platform/settings/service";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { MANAGE, SupportForbiddenError, SupportNotFoundError, SupportStateError } from "./tech-request";
import { STATUS_LABELS } from "../components/status-badge";

/** CLOSED and CANCELLED are terminal: no further status transition, resolve, or cancel is allowed. Also used by ticket-detail.tsx to gate the owner-facing cancel button. */
export const TERMINAL_STATUSES: TechRequestStatus[] = ["CLOSED", "CANCELLED"];

async function requireManage(actorPersonId: string): Promise<void> {
  if (!(await can(actorPersonId, MANAGE))) {
    throw new SupportForbiddenError(`The ${MANAGE} permission is required.`);
  }
}

async function loadOrThrow(id: string): Promise<TechRequest> {
  const req = await prisma.techRequest.findUnique({ where: { id } });
  if (!req) throw new SupportNotFoundError();
  return req;
}

/** Settings are unset in tests; the resolved base URL falls back to "" so links are still well-formed relative paths. */
async function resolveBaseUrl(): Promise<string> {
  return (await getSetting<string>("app.baseUrl")) ?? "";
}

// ---------------------------------------------------------------------------
// assignRequest
// ---------------------------------------------------------------------------

/**
 * Sets (or, with assigneeId null, clears) a ticket's assignee.
 *
 * Requires support.manage_requests. Ticket must exist (SupportNotFoundError).
 * When a non-null assignee is set, notifies that assignee
 * (support.request_assigned). Clearing the assignee sends no notification.
 *
 * Audits "support.assign" with before/after assignedToId.
 */
export async function assignRequest(
  actorPersonId: string,
  id: string,
  assigneeId: string | null
): Promise<TechRequest> {
  await requireManage(actorPersonId);
  const before = await loadOrThrow(id);

  const updated = await prisma.techRequest.update({
    where: { id },
    data: { assignedToId: assigneeId },
  });

  await recordAudit({
    actorPersonId,
    action: "support.assign",
    entityType: "TechRequest",
    entityId: id,
    before: { assignedToId: before.assignedToId },
    after: { assignedToId: assigneeId },
  });

  if (assigneeId) {
    const assignee = await prisma.person.findUnique({
      where: { id: assigneeId },
      select: { id: true, name: true, entraObjectId: true, contactEmail: true },
    });
    if (assignee) {
      const baseUrl = await resolveBaseUrl();
      const link = `${baseUrl}/support/${id}`;
      const rendered = await renderEmail("support.request_assigned", {
        ticketNumber: updated.number,
        subject: updated.subject,
        assigneeName: assignee.name ?? "there",
        link,
      });
      await notify(prisma, {
        type: "support.request_assigned",
        person: assignee,
        email: { subject: rendered.subject, html: rendered.html },
        teams: { title: `IT Support #${updated.number} assigned to you`, summary: updated.subject, link },
        triggeredById: actorPersonId,
      });
    }
  }

  return updated;
}

// ---------------------------------------------------------------------------
// setStatus
// ---------------------------------------------------------------------------

/**
 * Updates a ticket's status.
 *
 * Requires support.manage_requests. Ticket must exist (SupportNotFoundError)
 * and must not already be terminal (SupportStateError). Moving to
 * AWAITING_REQUESTER notifies the requester (support.status_changed).
 *
 * Audits "support.status_change" with before/after status.
 */
export async function setStatus(
  actorPersonId: string,
  id: string,
  status: TechRequestStatus
): Promise<TechRequest> {
  await requireManage(actorPersonId);
  const before = await loadOrThrow(id);

  if (TERMINAL_STATUSES.includes(before.status)) {
    throw new SupportStateError(`Cannot change the status of a ${before.status} ticket.`);
  }

  const updated = await prisma.techRequest.update({
    where: { id },
    data: { status },
  });

  await recordAudit({
    actorPersonId,
    action: "support.status_change",
    entityType: "TechRequest",
    entityId: id,
    before: { status: before.status },
    after: { status },
  });

  if (status === "AWAITING_REQUESTER") {
    const requester = await prisma.person.findUnique({
      where: { id: updated.requesterId },
      select: { id: true, name: true, entraObjectId: true, contactEmail: true },
    });
    if (requester) {
      const baseUrl = await resolveBaseUrl();
      const link = `${baseUrl}/support/${id}`;
      const rendered = await renderEmail("support.status_changed", {
        ticketNumber: updated.number,
        subject: updated.subject,
        statusLabel: STATUS_LABELS[status],
        link,
      });
      await notify(prisma, {
        type: "support.status_changed",
        person: requester,
        email: { subject: rendered.subject, html: rendered.html },
        teams: { title: `IT Support #${updated.number} update`, summary: updated.subject, link },
        triggeredById: actorPersonId,
      });
    }
  }

  return updated;
}

// ---------------------------------------------------------------------------
// setPriority
// ---------------------------------------------------------------------------

/**
 * Updates a ticket's priority. Requires support.manage_requests. Ticket must
 * exist (SupportNotFoundError). No notification (priority is an internal
 * triage signal, not requester-facing).
 *
 * Audits "support.priority_change" with before/after priority.
 */
export async function setPriority(
  actorPersonId: string,
  id: string,
  priority: TechRequestPriority
): Promise<TechRequest> {
  await requireManage(actorPersonId);
  const before = await loadOrThrow(id);

  const updated = await prisma.techRequest.update({
    where: { id },
    data: { priority },
  });

  await recordAudit({
    actorPersonId,
    action: "support.priority_change",
    entityType: "TechRequest",
    entityId: id,
    before: { priority: before.priority },
    after: { priority },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// resolveRequest
// ---------------------------------------------------------------------------

/**
 * Resolves a ticket: sets status RESOLVED, resolvedAt to now, and the
 * resolution note.
 *
 * Requires support.manage_requests. Ticket must exist (SupportNotFoundError)
 * and must not already be terminal (SupportStateError). resolution must be
 * non-blank (SupportStateError). Notifies the requester
 * (support.request_resolved).
 *
 * Audits "support.resolve" with before/after status.
 */
export async function resolveRequest(
  actorPersonId: string,
  id: string,
  resolution: string
): Promise<TechRequest> {
  await requireManage(actorPersonId);

  const trimmed = resolution?.trim();
  if (!trimmed) throw new SupportStateError("A resolution is required.");

  const before = await loadOrThrow(id);
  if (TERMINAL_STATUSES.includes(before.status)) {
    throw new SupportStateError(`Cannot resolve a ${before.status} ticket.`);
  }

  const updated = await prisma.techRequest.update({
    where: { id },
    data: { status: "RESOLVED", resolvedAt: new Date(), resolution: trimmed },
  });

  await recordAudit({
    actorPersonId,
    action: "support.resolve",
    entityType: "TechRequest",
    entityId: id,
    before: { status: before.status },
    after: { status: "RESOLVED" },
  });

  const requester = await prisma.person.findUnique({
    where: { id: updated.requesterId },
    select: { id: true, name: true, entraObjectId: true, contactEmail: true },
  });
  if (requester) {
    const baseUrl = await resolveBaseUrl();
    const link = `${baseUrl}/support/${id}`;
    const rendered = await renderEmail("support.request_resolved", {
      ticketNumber: updated.number,
      subject: updated.subject,
      resolution: trimmed,
      hasResolution: true,
      link,
    });
    await notify(prisma, {
      type: "support.request_resolved",
      person: requester,
      email: { subject: rendered.subject, html: rendered.html },
      teams: { title: `IT Support #${updated.number} resolved`, summary: updated.subject, link },
      triggeredById: actorPersonId,
    });
  }

  return updated;
}

// ---------------------------------------------------------------------------
// cancelRequest (manager)
// ---------------------------------------------------------------------------

/**
 * Manager cancellation of a non-terminal ticket.
 *
 * Requires support.manage_requests. Ticket must exist (SupportNotFoundError)
 * and must not already be terminal (SupportStateError). reason must be
 * non-blank (SupportStateError).
 *
 * No notification is sent -- a quiet administrative action, matching
 * cancelRequest in epic.ts. The requester sees the Cancelled status next time
 * they view the ticket.
 *
 * Audits "support.cancel" with the reason.
 */
export async function cancelRequest(
  actorPersonId: string,
  id: string,
  reason: string
): Promise<TechRequest> {
  await requireManage(actorPersonId);

  const trimmed = reason?.trim();
  if (!trimmed) throw new SupportStateError("A reason is required to cancel a request.");

  const before = await loadOrThrow(id);
  if (TERMINAL_STATUSES.includes(before.status)) {
    throw new SupportStateError(`Cannot cancel a ${before.status} ticket.`);
  }

  const updated = await prisma.techRequest.update({
    where: { id },
    data: { status: "CANCELLED" },
  });

  await recordAudit({
    actorPersonId,
    action: "support.cancel",
    entityType: "TechRequest",
    entityId: id,
    before: { status: before.status },
    after: { status: "CANCELLED", reason: trimmed },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// cancelOwnRequest (requester self-service)
// ---------------------------------------------------------------------------

/**
 * The requester cancels their own ticket. Does NOT require
 * support.manage_requests.
 *
 * Ticket must exist and belong to actorPersonId; otherwise
 * SupportNotFoundError (same non-leaking convention as getTechRequest: a
 * stranger cannot tell "not found" from "not yours"). Ticket must not already
 * be terminal (SupportStateError).
 *
 * Audits "support.cancel_own".
 */
export async function cancelOwnRequest(actorPersonId: string, id: string): Promise<TechRequest> {
  const before = await loadOrThrow(id);
  if (before.requesterId !== actorPersonId) throw new SupportNotFoundError();

  if (TERMINAL_STATUSES.includes(before.status)) {
    throw new SupportStateError(`Cannot cancel a ${before.status} ticket.`);
  }

  const updated = await prisma.techRequest.update({
    where: { id },
    data: { status: "CANCELLED" },
  });

  await recordAudit({
    actorPersonId,
    action: "support.cancel_own",
    entityType: "TechRequest",
    entityId: id,
    before: { status: before.status },
    after: { status: "CANCELLED" },
  });

  return updated;
}
