/**
 * Epic-to-TechRequest status sync.
 *
 * The Epic workflow (epic.ts's createTicket/completeRequest/cancelEpicRequest,
 * itcm.ts's submitEpicRequests/reconcileDeactivationRequests) used to write
 * only EpicRequest.status and YnhhTicket.status, never TechRequest.status --
 * so AWAITING_YNHH had exactly one origin in the whole codebase: a manager
 * picking it by hand on the ticket detail page (see ticket-detail.tsx's
 * now-removed showStatusControl exception). A member's Epic request could sit
 * with Yale New Haven Health for weeks while their linked Intercom ticket
 * showed nothing.
 *
 * Two entry points, called by every place an EpicRequest moves into or out of
 * SUBMITTED. Both route their TechRequest.status write through manage.ts's
 * setStatus rather than writing the column directly, so the existing
 * Hub-origin Intercom sync (Direction 2's conversation note, Direction 3's
 * ticket-state push -- see notifications.ts) fires exactly as it would for a
 * manager-driven change, with no separate write-then-forget-to-push path to
 * keep in sync. A second, Epic-specific staff note (buildEpicSubmissionNote /
 * buildEpicResolutionNote in notifications.ts) is posted alongside it, naming
 * the specific Epic request(s) and YNHH ticket -- detail the generic
 * status-change note never carries.
 *
 *   - onEpicSubmitted(actorPersonId, ynhhTicketId): called after one or more
 *     EpicRequests move to SUBMITTED under a YnhhTicket. Every TechRequest
 *     among them (via EpicRequest.techRequestId) moves to AWAITING_YNHH.
 *   - onEpicResolved(actorPersonId, epicRequestId, outcome): called after a
 *     single EpicRequest moves to COMPLETED or CANCELLED. Its linked
 *     TechRequest moves back to IN_PROGRESS -- but ONLY when no OTHER
 *     EpicRequest attached to the same TechRequest is still SUBMITTED. A
 *     TechRequest can carry many EpicRequests (the 0..n relationship), and
 *     mirroring a single request's completion would flip the ticket back to
 *     IN_PROGRESS while a sibling request was still sitting with YNHH.
 *
 * Never AUTO-RESOLVE: onEpicResolved's target is always IN_PROGRESS, never
 * RESOLVED. The Epic account may not have been the only thing the member
 * asked about, and deciding a ticket is finished is a human call an agent
 * makes deliberately -- moving it out of AWAITING_YNHH is the useful,
 * mechanical part; deciding it is finished is not ours to do.
 *
 * A linked TechRequest already in a terminal status (RESOLVED/CLOSED/
 * CANCELLED) is left alone by onEpicSubmitted: it was evidently closed out
 * for reasons independent of this Epic request, and resurrecting it to
 * AWAITING_YNHH would fight whatever the manager (or Intercom, for a ticket
 * still linked there) already decided. onEpicResolved only ever acts when the
 * TechRequest is currently AWAITING_YNHH, so it never touches a terminal
 * ticket either -- there is nothing to "move back" from.
 */

import type { EpicRequestKind } from "@prisma/client";
import { prisma } from "@/platform/db";
import { pushYnhhServiceRequest } from "@/platform/intercom/tickets";
import { setStatus, TERMINAL_STATUSES } from "./manage";
import {
  buildEpicSubmissionNote,
  buildEpicResolutionNote,
  buildYnhhServiceRequestNote,
  notifyEpicYnhhNote,
} from "./notifications";

/**
 * Called after one or more EpicRequests have been committed as SUBMITTED
 * under `ynhhTicketId` (epic.ts's createTicket, itcm.ts's submitEpicRequests
 * and reconcileDeactivationRequests all call this once their own transaction
 * has committed). Re-reads the ticket's requests rather than taking them as a
 * parameter, so every caller -- whether it batched requestIds directly or
 * adopted pre-existing rows -- gets the same authoritative grouping with no
 * risk of the caller's in-memory list drifting from what actually landed.
 *
 * Requests with no techRequestId are not attached to any support ticket and
 * are silently skipped -- most Epic requests (a term-wide NEW/MODIFY/RENEW
 * batch, a DEACTIVATE raised at offboard) never came from one.
 */
export async function onEpicSubmitted(actorPersonId: string, ynhhTicketId: string): Promise<void> {
  const ticket = await prisma.ynhhTicket.findUnique({
    where: { id: ynhhTicketId },
    select: { id: true, serviceRequestNumber: true },
  });
  if (!ticket) return; // defensive: this runs immediately after creating the ticket

  const requests = await prisma.epicRequest.findMany({
    where: { ticketId: ynhhTicketId, techRequestId: { not: null } },
    select: { techRequestId: true, kind: true, person: { select: { name: true } } },
  });

  const byTechRequest = new Map<string, { kind: EpicRequestKind; personName: string }[]>();
  for (const r of requests) {
    // Narrowed non-null by the where clause above; Prisma's generated type
    // does not carry that through, hence the assertion.
    const techRequestId = r.techRequestId as string;
    const list = byTechRequest.get(techRequestId) ?? [];
    list.push({ kind: r.kind, personName: r.person.name });
    byTechRequest.set(techRequestId, list);
  }

  for (const [techRequestId, entries] of byTechRequest) {
    const current = await prisma.techRequest.findUnique({ where: { id: techRequestId } });
    if (!current) continue; // defensive: techRequestId is a live FK, but a race is not worth failing the Epic submission over
    if (TERMINAL_STATUSES.includes(current.status)) continue; // see module doc comment

    const updated = await setStatus(actorPersonId, techRequestId, "AWAITING_YNHH");

    if (updated.intercomConversationId) {
      await notifyEpicYnhhNote(updated, buildEpicSubmissionNote(entries, ticket));
    }
  }
}

/**
 * Pushes a YNHH ticket's service request number out to every Intercom ticket
 * that is waiting on it.
 *
 * This closes the gap that made the SR# effectively invisible outside the hub.
 * The number does not exist when a YNHH ticket is opened -- YNHH IT issues it
 * afterwards -- so the submission note above almost always rendered its
 * "no SR# on file yet" fallback, and the pencil that records the number later
 * wrote the column and told nobody. An agent in Intercom looking at a ticket
 * parked on AWAITING_YNHH had no way to reach YNHH's side of it.
 *
 * Two writes per linked ticket, because they serve different readers:
 *   - the ticket ATTRIBUTE, which is what an agent scans without opening
 *     anything (requires the workspace attribute; see pushYnhhServiceRequest);
 *   - a staff-only conversation NOTE, which is the durable record of when the
 *     number arrived and what it was, and which lands even in a workspace
 *     where the attribute was never created.
 *
 * Best-effort throughout, matching every other outbound Intercom path here:
 * the number has already been committed by the time this runs, and an
 * unreachable Intercom must not turn recording it into a failed save.
 * Terminal tickets are skipped -- they are closed out, and an attribute write
 * would reopen nothing but would misreport them as live YNHH work.
 */
export async function syncYnhhServiceRequestToIntercom(ynhhTicketId: string): Promise<void> {
  const ticket = await prisma.ynhhTicket.findUnique({
    where: { id: ynhhTicketId },
    select: { serviceRequestNumber: true },
  });
  // Nothing to push. Clearing a number deliberately does NOT blank the Intercom
  // attribute: the far more likely cause of an empty value is a typo being
  // corrected, and a two-step fix would otherwise flash "no SR#" at anyone
  // reading the ticket in between.
  if (!ticket?.serviceRequestNumber) return;

  const requests = await prisma.epicRequest.findMany({
    where: { ticketId: ynhhTicketId, techRequestId: { not: null } },
    select: { techRequestId: true },
  });
  const techRequestIds = [...new Set(requests.map((r) => r.techRequestId as string))];
  if (techRequestIds.length === 0) return;

  const linked = await prisma.techRequest.findMany({
    where: { id: { in: techRequestIds } },
    select: {
      id: true,
      number: true,
      status: true,
      intercomTicketId: true,
      intercomConversationId: true,
    },
  });

  for (const t of linked) {
    if (TERMINAL_STATUSES.includes(t.status)) continue;
    if (t.intercomTicketId) {
      await pushYnhhServiceRequest(t.intercomTicketId, ticket.serviceRequestNumber);
    }
    if (t.intercomConversationId) {
      await notifyEpicYnhhNote(t, buildYnhhServiceRequestNote(ticket.serviceRequestNumber));
    }
  }
}

/**
 * Called after a single EpicRequest has been committed as COMPLETED or
 * CANCELLED (epic.ts's completeRequest and cancelEpicRequest call this once
 * their own atomic claim has succeeded). No-ops when the request was never
 * attached to a TechRequest, when that TechRequest is not currently
 * AWAITING_YNHH (nothing to move it out of), or when another EpicRequest on
 * the same TechRequest is still SUBMITTED (see the module doc comment on the
 * 0..n relationship).
 */
export async function onEpicResolved(
  actorPersonId: string,
  epicRequestId: string,
  outcome: "COMPLETED" | "CANCELLED"
): Promise<void> {
  const req = await prisma.epicRequest.findUnique({
    where: { id: epicRequestId },
    select: { techRequestId: true, ticketId: true, kind: true, person: { select: { name: true } } },
  });
  if (!req?.techRequestId) return;

  const current = await prisma.techRequest.findUnique({ where: { id: req.techRequestId } });
  if (!current || current.status !== "AWAITING_YNHH") return;

  const stillOutstanding = await prisma.epicRequest.count({
    where: { techRequestId: req.techRequestId, status: "SUBMITTED" },
  });
  if (stillOutstanding > 0) return;

  const updated = await setStatus(actorPersonId, req.techRequestId, "IN_PROGRESS");

  if (updated.intercomConversationId) {
    const ynhhTicket = req.ticketId
      ? await prisma.ynhhTicket.findUnique({
          where: { id: req.ticketId },
          select: { id: true, serviceRequestNumber: true },
        })
      : null;
    await notifyEpicYnhhNote(
      updated,
      buildEpicResolutionNote({ kind: req.kind, personName: req.person.name, outcome }, ynhhTicket)
    );
  }
}
