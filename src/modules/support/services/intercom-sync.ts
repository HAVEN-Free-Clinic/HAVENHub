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
import { STATUS_LABELS } from "../components/status-badge";
import { CATEGORY_LABELS } from "../labels";

// ---------------------------------------------------------------------------
// State mapping: Intercom ticket state (internal/staff-facing label) -> TechRequestStatus
// ---------------------------------------------------------------------------

/**
 * Built from STATUS_LABELS rather than a second hand-written table, so the
 * Intercom-side mapping cannot silently drift from the Hub's own status
 * labels -- the workspace's custom ticket states were created to match these
 * exact strings (docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md,
 * "Direction 3 / State mapping": "Every TechRequestStatus needs a
 * corresponding state in the workspace").
 *
 * Keyed lowercase so a case difference between what an admin typed in
 * Intercom's UI and STATUS_LABELS doesn't turn into a spurious "unmapped
 * state" refusal.
 */
const INTERNAL_LABEL_TO_STATUS: Record<string, TechRequestStatus> = Object.fromEntries(
  (Object.entries(STATUS_LABELS) as [TechRequestStatus, string][]).map(([status, label]) => [
    label.trim().toLowerCase(),
    status,
  ])
);

/**
 * Maps an Intercom ticket's staff-facing state label (the webhook payload's
 * `ticket_state_internal_label`) to a TechRequestStatus, or null when the
 * label has no known mapping.
 *
 * Explicit and total over every status this codebase knows (every
 * TechRequestStatus, via STATUS_LABELS) and refuses everything else --
 * deliberately not a fallback/nearest-match. A label with no mapping is
 * exactly what happens the day someone adds a new custom state in Intercom's
 * UI without a matching code change, and guessing which existing status it
 * is "closest to" is how a ticket ends up silently Resolved. The caller
 * (applyIntercomTicketStateChange) logs and refuses to apply, never guesses.
 */
export function mapIntercomTicketStateToStatus(internalLabel: string): TechRequestStatus | null {
  return INTERNAL_LABEL_TO_STATUS[internalLabel.trim().toLowerCase()] ?? null;
}

/**
 * Outbound mirror of INTERNAL_LABEL_TO_STATUS above: which Intercom ticket
 * state label to push when a TechRequestStatus changes in the Hub (Direction
 * 3's Hub-origin half -- see notifications.ts's pushIntercomTicketState, the
 * function that performs the actual write).
 *
 * Built from the same Object.entries(STATUS_LABELS) call that produces
 * INTERNAL_LABEL_TO_STATUS, rather than a second hand-written label table:
 * two independently maintained copies of "which label goes with which
 * status" would drift, and the drift would be silent -- exactly the failure
 * this module's inbound mapping exists to avoid in the other direction.
 *
 * Kept case-preserving (STATUS_LABELS' own casing), unlike
 * INTERNAL_LABEL_TO_STATUS's lowercased keys -- those exist only to make
 * INBOUND matching forgiving of a case difference in Intercom's UI. This is
 * what gets WRITTEN back to Intercom, and the workspace's custom states were
 * created to match STATUS_LABELS' exact strings (see the design doc's
 * "Direction 3 / State mapping").
 *
 * Typed Partial, not Record, even though it is total today for every
 * TechRequestStatus (STATUS_LABELS is itself a total Record) -- a status
 * added to the schema without an accompanying workspace state is exactly the
 * drift mapStatusToIntercomTicketState below must refuse to guess at, and a
 * Partial type is what keeps that refusal a real, reachable branch rather
 * than dead code the compiler could prove impossible.
 */
const STATUS_TO_INTERNAL_LABEL: Partial<Record<TechRequestStatus, string>> = Object.fromEntries(
  (Object.entries(STATUS_LABELS) as [TechRequestStatus, string][]).map(([status, label]) => [status, label])
);

/**
 * Maps a TechRequestStatus to the Intercom ticket state label to push when it
 * changes in the Hub, or null when there is no mapped state.
 *
 * Explicit and total over every status STATUS_LABELS knows today, and
 * refuses -- never guesses -- anything else: the outbound mirror of
 * mapIntercomTicketStateToStatus above. The caller (pushIntercomTicketState
 * in notifications.ts) logs and leaves the Intercom ticket untouched rather
 * than pushing a nearest-looking state.
 */
export function mapStatusToIntercomTicketState(status: TechRequestStatus): string | null {
  return STATUS_TO_INTERNAL_LABEL[status] ?? null;
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
  | { ok: true; changed: boolean; ticket: TechRequest }
  | { ok: false; reason: "unmapped_state" | "ticket_not_found" };

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
 * Scope is deliberately narrow: only `status` is written. resolvedAt and
 * resolution (which resolveRequest sets together with status RESOLVED) are
 * Hub-authored fields with no equivalent in an Intercom state-change event --
 * there is no resolution text to carry -- so they are left untouched here.
 */
export async function applyIntercomTicketStateChange(
  intercomTicketId: string,
  internalLabel: string
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
    return { ok: false, reason: "ticket_not_found" };
  }

  if (existing.status === status) {
    return { ok: true, changed: false, ticket: existing };
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
    after: { status, source: "intercom" },
  });

  return { ok: true, changed: true, ticket: updated };
}
