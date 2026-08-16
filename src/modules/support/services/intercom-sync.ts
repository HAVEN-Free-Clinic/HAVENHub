/**
 * Direction 3 of the Intercom <-> TechRequest sync (see
 * docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md): keeping
 * TechRequest.status and an Intercom Ticket's state in sync, in both
 * directions.
 *
 * This module owns the INBOUND half: applying an Intercom-driven ticket
 * state change to the linked TechRequest.status
 * (applyIntercomTicketStateChange), and both mapping tables the two
 * directions share (mapIntercomTicketStateToStatus for inbound,
 * mapStatusToIntercomTicketState for outbound). The webhook receiver
 * (src/app/api/support/tickets/events) calls applyIntercomTicketStateChange;
 * the HTTP plumbing (signature verification, envelope parsing, topic
 * dispatch) lives in the route so this module stays independently testable
 * against a real database.
 *
 * The OUTBOUND half -- a Hub status change pushing a new state onto the
 * linked Ticket -- lives in notifications.ts's pushIntercomTicketState, not
 * here. That is a deliberate module split, and it is the loop suppression:
 * origin is carried by which function performs a write, not by a persisted
 * flag. manage.ts's setStatus and resolveRequest are the Hub-origin call
 * sites -- they call notifyIntercomStatusChange (an internal note) and
 * pushIntercomTicketState (the Ticket's actual state) unconditionally on
 * every status change for a linked ticket, which is correct, because every
 * call to setStatus/resolveRequest genuinely originates in the Hub (a
 * manager action or a Hub workflow like the YNHH gate).
 * applyIntercomTicketStateChange below is the Intercom-origin half, and it
 * deliberately never calls notifyIntercomStatusChange or
 * pushIntercomTicketState -- doing either would talk back to Intercom about
 * a change Intercom itself just made, which is the naive loop the design
 * warns about. Because these are two separate functions with two separate
 * call sites (a webhook route with no Person actor vs. an RBAC-gated manager
 * action) living in two separate modules that do not import each other's
 * write path, the "did this change come from Intercom or the Hub" question
 * never has to be answered by inspecting the row -- it is answered by which
 * module's code is running, and a future edit cannot wire the two together
 * "for completeness" without an import this module does not have.
 */

import type { TechRequest, TechRequestCategory, TechRequestStatus } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { log } from "@/platform/logging";
import { normalizeTicketStateLabel } from "@/platform/intercom/tickets";
import { CATEGORY_LABELS } from "../labels";

// ---------------------------------------------------------------------------
// State mapping: Intercom ticket state (internal/staff-facing label) -> TechRequestStatus
// ---------------------------------------------------------------------------

/**
 * The Hub's status labels and Intercom's state labels are two DIFFERENT
 * vocabularies, and this module is the only place that knows how they line up.
 *
 * An earlier version derived both directions from STATUS_LABELS, on the theory
 * that a single table cannot drift from itself. The reasoning was sound and the
 * conclusion was still wrong, in a way only the live workspace revealed:
 * STATUS_LABELS is the Hub's own UI text, written for Hub managers, while the
 * workspace's state labels are copy ops wrote for members ("Waiting on YNHH
 * Collaboration" reads better to a member than "Awaiting YNHH"). Deriving one
 * from the other silently REQUIRED the two to be identical, so the four labels
 * that were not simply failed to map: outbound writes rejected by Intercom,
 * inbound labels refused as unmapped, nothing raised on either side, and the
 * two systems drifting apart in silence.
 *
 * The tables below are therefore explicit, and the two vocabularies are free to
 * differ. What that gives up is the drift-proofing: they can now fall out of
 * step with the WORKSPACE, which no unit test can observe. The comment below
 * records what the workspace actually held when this was written, and the test
 * file asserts the two directions still agree with each other.
 *
 * Workspace states, GET /ticket_states on 2026-08-12:
 *   Submitted | In progress | Awaiting user | Resolved
 *   Won't fix | Waiting on YNHH ITS | Cancelled
 */

/**
 * Hub status -> the Intercom state label to write (outbound; Direction 3's
 * Hub-origin half, performed by notifications.ts's pushIntercomTicketState).
 *
 * Total over TechRequestStatus rather than Partial: a status added to the schema
 * should be a compile error here, where someone has to decide which Intercom
 * state it means, rather than a silent runtime no-op.
 *
 * RESOLVED and CLOSED both map to "Resolved" deliberately. Ops treats them as
 * one outcome and did not want a second terminal state in the member's view.
 * That makes this mapping many-to-one and therefore not invertible -- see the
 * inbound table for which way "Resolved" comes back.
 */
const STATUS_TO_INTERCOM_STATE: Record<TechRequestStatus, string> = {
  SUBMITTED: "Submitted",
  IN_PROGRESS: "In progress",
  AWAITING_REQUESTER: "Awaiting user",
  AWAITING_YNHH: "Waiting on YNHH ITS",
  RESOLVED: "Resolved",
  CLOSED: "Resolved",
  CANCELLED: "Cancelled",
};

/**
 * Intercom state label -> Hub status (inbound), keyed by normalizeStateLabel.
 *
 * Deliberately NOT an inversion of STATUS_TO_INTERCOM_STATE. That map is
 * many-to-one, so inverting it would resolve "Resolved" to whichever of
 * RESOLVED/CLOSED happened to be enumerated last, making a correctness question
 * turn on key order. RESOLVED is the explicit choice: it is what the Hub's own
 * resolve path sets, so an Intercom-origin "Resolved" lands on exactly the
 * status a Hub-origin resolve would have produced.
 *
 * "Won't fix" has no outbound counterpart at all. It exists in the workspace and
 * an agent can pick it, so leaving it unmapped would mean the Hub silently
 * ignoring a real terminal decision -- the exact failure this module's
 * fail-closed posture exists to make loud everywhere else. It maps to CLOSED,
 * the Hub's quiet terminal status. The asymmetry is intentional and one-way:
 * such a ticket reads CLOSED in the Hub, and a later Hub-origin push of CLOSED
 * would write back "Resolved", losing the nuance. That path is unreachable in
 * practice, since a linked ticket's status is read-only in the Hub (see
 * ticket-detail.tsx), and losing "Won't fix" would in any case be a far better
 * outcome than the Hub never learning the ticket ended.
 */
const INTERCOM_STATE_TO_STATUS: Record<string, TechRequestStatus> = {
  submitted: "SUBMITTED",
  "in progress": "IN_PROGRESS",
  "awaiting user": "AWAITING_REQUESTER",
  "waiting on ynhh its": "AWAITING_YNHH",
  resolved: "RESOLVED",
  "won't fix": "CLOSED",
  cancelled: "CANCELLED",
};

/**
 * Trim, lowercase, and fold a typographic apostrophe to a straight one.
 *
 * Moved to src/platform/intercom/tickets.ts on 2026-08-13 and imported back
 * under its old local name, because the outbound half now folds the SAME label
 * before matching it against the workspace's state list (see that function's
 * doc comment). src/platform cannot import src/modules, so the shared piece has
 * to live over there; keeping the local alias leaves this file's call sites
 * reading exactly as they did.
 */
const normalizeStateLabel = normalizeTicketStateLabel;

/**
 * Maps an Intercom ticket's staff-facing state label (the webhook payload's
 * `ticket_state_internal_label`) to a TechRequestStatus, or null when the label
 * has no known mapping.
 *
 * Refuses everything it does not know rather than falling back to a
 * nearest-match. An unmapped label is exactly what a new custom state added in
 * Intercom's UI produces, and guessing which existing status it is "closest to"
 * is how a ticket ends up silently Resolved. The caller
 * (applyIntercomTicketStateChange) logs and refuses to apply, never guesses.
 */
export function mapIntercomTicketStateToStatus(internalLabel: string): TechRequestStatus | null {
  return INTERCOM_STATE_TO_STATUS[normalizeStateLabel(internalLabel)] ?? null;
}

/**
 * Maps a TechRequestStatus to the Intercom ticket state label to push when it
 * changes in the Hub.
 *
 * Total over TechRequestStatus, so this cannot actually return null today. The
 * `| null` in the return type stays because pushIntercomTicketState already
 * branches on it, and that branch is what would keep a future status without a
 * mapping from pushing a nearest-looking state.
 */
export function mapStatusToIntercomTicketState(status: TechRequestStatus): string | null {
  return STATUS_TO_INTERCOM_STATE[status] ?? null;
}

// ---------------------------------------------------------------------------
// Category mapping: Intercom ticket type name -> TechRequestCategory
// ---------------------------------------------------------------------------

const TICKET_TYPE_NAME_TO_CATEGORY: Record<string, TechRequestCategory> = Object.fromEntries(
  (Object.entries(CATEGORY_LABELS) as [TechRequestCategory, string][]).map(([category, label]) => [
    label.trim().toLowerCase(),
    category,
  ])
);

/**
 * Maps an Intercom Ticket Type's name to a TechRequestCategory.
 *
 * Unlike the status mapping, an unrecognized ticket type falls back to OTHER
 * rather than refusing the whole webhook. The two mappings carry different
 * stakes: guessing a STATUS wrong can silently mark a ticket Resolved or hide
 * it from a queue -- worth refusing outright. Miscategorizing a ticket is a
 * triage inconvenience the OTHER bucket already exists to absorb, and
 * refusing ticket.created entirely over it would sacrifice the one outcome
 * the whole design protects above all else: the ticket still exists. Logged
 * either way so a genuinely renamed or new ticket type is visible in the
 * logs rather than silently reclassified.
 */
export function mapIntercomTicketTypeToCategory(ticketTypeName: string | null): TechRequestCategory {
  const category = ticketTypeName ? TICKET_TYPE_NAME_TO_CATEGORY[ticketTypeName.trim().toLowerCase()] : undefined;
  if (!category) {
    log.warn("[support] unrecognized Intercom ticket type name; filing as OTHER", { ticketTypeName });
    return "OTHER";
  }
  return category;
}

// ---------------------------------------------------------------------------
// applyIntercomTicketStateChange
// ---------------------------------------------------------------------------

export type ApplyStateChangeResult =
  | { ok: true; changed: boolean; ticket: TechRequest; stale?: boolean }
  | { ok: false; reason: "unmapped_state" | "ticket_not_found" };

/**
 * The event timestamp carried by the most recent Intercom-origin status change
 * already applied to this ticket, or null when there is none to compare against.
 *
 * Read out of the audit trail rather than a column on TechRequest, because the
 * row recording "an Intercom event moved this ticket" already exists, is written
 * in the same function that applies the change, and is indexed by
 * (entityType, entityId) -- so the ordering guard needs no schema change and no
 * second source of truth that could disagree with the audit log.
 *
 * Fails OPEN in every ambiguous case (no prior row, a row predating this field,
 * an unparseable value): the guard exists to reject a demonstrably older event,
 * and "we cannot tell" must stay the pre-guard behavior of applying it rather
 * than becoming a new way for a real state change to be dropped. recordAudit is
 * fire-and-forget on the singleton path (platform/audit.ts), so a lost audit row
 * degrades this to exactly the behavior that shipped before audit 14 -- never to
 * something worse.
 */
async function lastAppliedEventAt(techRequestId: string): Promise<Date | null> {
  const row = await prisma.auditLog.findFirst({
    where: {
      entityType: "TechRequest",
      entityId: techRequestId,
      action: "intercom_ticket_sync.status_change",
    },
    // id breaks a createdAt tie: two rows can share a timestamp at Postgres'
    // resolution, and which one is "latest" must not depend on scan order.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { after: true },
  });

  const after = row?.after;
  if (!after || typeof after !== "object" || Array.isArray(after)) return null;
  const at = (after as Record<string, unknown>).intercomEventAt;
  if (typeof at !== "string") return null;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Applies an Intercom-driven ticket state change to the TechRequest linked by
 * intercomTicketId. See the module doc comment for the loop-suppression
 * argument this function is the load-bearing half of.
 *
 * No-op guard: when the incoming status already equals the current one
 * (Intercom redelivering the same event, or two deliveries racing to the same
 * end state), nothing is written or audited and `changed: false` is
 * returned. This is necessary but not sufficient on its own for loop
 * suppression -- see the module doc comment -- but it is what makes a
 * redelivered webhook a no-op rather than a duplicate audit row.
 *
 * Unlike manage.ts's setStatus, this does NOT refuse a TERMINAL current
 * status. Direction 3 makes Intercom the control surface: an agent moving a
 * Resolved ticket back to In Progress in Intercom's own UI is an ordinary
 * action there, and it must reach the Hub rather than be silently dropped
 * because the Hub's OWN UI happens to gate that transition when a manager
 * tries it from this side.
 *
 * Staleness guard: `occurredAt` is when Intercom says the event happened (the
 * webhook envelope's own timestamp; see the route's extractEventTimestamp). An
 * event older than the last one already applied is refused as a no-op rather
 * than written. Intercom does not guarantee delivery ORDER and retries failed
 * deliveries for hours, so without this the only thing standing between a
 * ticket and a silent revert was status equality -- which says nothing about
 * age: an "In progress" delivery that lost a race to, or was retried after, a
 * "Resolved" one would quietly drag the ticket backwards, and the reconciliation
 * sweep would then report the Hub and Intercom as disagreeing with no way to
 * tell which side was stale (audit 14, finding 4). Arrival order is not trusted
 * because it is not a property Intercom offers.
 *
 * Scope is deliberately narrow: only `status` is written. resolvedAt and
 * resolution (which resolveRequest sets together with status RESOLVED) are
 * Hub-authored fields with no equivalent in an Intercom state-change event --
 * there is no resolution text to carry -- so they are left untouched here.
 */
export async function applyIntercomTicketStateChange(
  intercomTicketId: string,
  internalLabel: string,
  occurredAt: Date | null = null
): Promise<ApplyStateChangeResult> {
  const status = mapIntercomTicketStateToStatus(internalLabel);
  if (!status) {
    log.warn("[support] Intercom ticket state has no mapped TechRequestStatus; refusing to guess", {
      intercomTicketId,
      internalLabel,
    });
    await recordAudit({
      actorPersonId: null,
      action: "intercom_ticket_sync.unmapped_state",
      entityType: "TechRequest",
      after: { intercomTicketId, internalLabel },
    });
    return { ok: false, reason: "unmapped_state" };
  }

  const existing = await prisma.techRequest.findUnique({ where: { intercomTicketId } });
  if (!existing) {
    // Not necessarily a fault: this can be a delivery-ordering race against
    // ticket.created (Intercom does not guarantee webhook ordering), which a
    // later redelivery may resolve on its own. Logged either way so a
    // genuinely orphaned ticket id is visible.
    log.warn("[support] Intercom ticket.state.updated for an unknown ticket id", { intercomTicketId });
    // Audited like every sibling refusal in this module. A log line is not a
    // record: it ages out of retention and cannot be joined to the ticket it
    // concerns, so the one refusal that leaves the Hub and Intercom genuinely
    // out of sync was also the only one with nothing durable to find later
    // (audit 14, finding 5). A repeat of the same intercomTicketId here is the
    // signature of a permanently orphaned Intercom ticket rather than a
    // transient ordering race, and that distinction is only visible across
    // rows.
    await recordAudit({
      actorPersonId: null,
      action: "intercom_ticket_sync.ticket_not_found",
      entityType: "TechRequest",
      after: { intercomTicketId, internalLabel, mappedStatus: status },
    });
    return { ok: false, reason: "ticket_not_found" };
  }

  if (existing.status === status) {
    return { ok: true, changed: false, ticket: existing };
  }

  // Checked only for a real transition: a redelivery that agrees with the
  // current status already returned above, so the extra read below only
  // happens when something is genuinely about to be written.
  if (occurredAt) {
    const appliedAt = await lastAppliedEventAt(existing.id);
    if (appliedAt && occurredAt.getTime() < appliedAt.getTime()) {
      log.warn("[support] refusing an out-of-order Intercom ticket state change", {
        intercomTicketId,
        internalLabel,
        occurredAt: occurredAt.toISOString(),
        lastAppliedAt: appliedAt.toISOString(),
      });
      await recordAudit({
        actorPersonId: null,
        action: "intercom_ticket_sync.stale_event",
        entityType: "TechRequest",
        entityId: existing.id,
        before: { status: existing.status },
        after: {
          status,
          source: "intercom",
          occurredAt: occurredAt.toISOString(),
          lastAppliedAt: appliedAt.toISOString(),
        },
      });
      return { ok: true, changed: false, ticket: existing, stale: true };
    }
  }

  const updated = await prisma.techRequest.update({
    where: { id: existing.id },
    data: { status },
  });

  await recordAudit({
    actorPersonId: null,
    action: "intercom_ticket_sync.status_change",
    entityType: "TechRequest",
    entityId: existing.id,
    before: { status: existing.status },
    // intercomEventAt is what lastAppliedEventAt reads back on the NEXT
    // delivery, so this field is load-bearing rather than descriptive: drop it
    // and the ordering guard above silently stops rejecting anything. Null when
    // the payload carried no usable timestamp, which reads back as "cannot
    // tell" and fails open.
    after: { status, source: "intercom", intercomEventAt: occurredAt ? occurredAt.toISOString() : null },
  });

  return { ok: true, changed: true, ticket: updated };
}
