/**
 * Reconciliation sweep for Direction 3 of the Intercom <-> TechRequest sync
 * (see docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md).
 *
 * Webhooks are the only thing keeping TechRequest.status and its linked
 * Intercom Ticket's state aligned, and a lost delivery leaves no trace to
 * retry from: if Intercom is briefly unreachable when the Hub pushes, or a
 * webhook exhausts Intercom's own retries, the two drift permanently with
 * nothing to notice it -- the Hub reads IN_PROGRESS while Intercom reads
 * Resolved, silently, forever. This sweep is the backstop: it walks every
 * TechRequest linked to an Intercom Ticket, asks Intercom for that Ticket's
 * live state, and reports every place the two disagree.
 *
 * REPORT-ONLY, DELIBERATELY -- this never writes TechRequest.status. Intercom
 * is the control surface for status (Direction 3's whole point), which argues
 * for Intercom winning a disagreement. But a Hub-origin status like
 * AWAITING_YNHH whose outbound push failed is ALSO a legitimate divergence
 * where the Hub is right, and the fix there is to retry the PUSH, not to
 * overwrite the Hub from Intercom -- the opposite repair. The loop-suppression
 * design (intercom-sync.ts's module doc comment) carries origin by which code
 * path performed a write, not by a column on the row, so by the time this
 * sweep runs later there is nothing left in the database that says which of
 * the two cases a given mismatch is. Guessing wrong writes real status data
 * from a coin flip; auditing the mismatch for a human to resolve costs
 * nothing and is never wrong. Hence: report over repair.
 */

import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { log } from "@/platform/logging";
import { fetchTicketState } from "@/platform/intercom/tickets";
import { intercomAccessToken } from "@/platform/intercom/config";
import { mapIntercomTicketStateToStatus } from "./intercom-sync";

/** One page at a time, so a large backlog never holds one giant result set in memory. */
const PAGE_SIZE = 50;

/**
 * Hard ceiling on rows touched in a single invocation. A serverless function
 * has its own wall-clock budget (see the cron route's maxDuration); this is
 * what keeps a large backlog from timing out mid-sweep and reconciling
 * nothing. Ordered by id, so a bounded run always makes forward progress --
 * the next scheduled run picks up past where this one stopped, on average,
 * rather than re-scanning the same head of the table every time. (No cursor
 * is persisted between runs -- see the route's doc comment for why an
 * approximate forward march is an acceptable trade for staying stateless.)
 */
const MAX_ROWS_PER_RUN = 500;

export type ReconcileSummary = {
  checked: number;
  inSync: number;
  mismatched: number;
  unmappedIntercomState: number;
  unreachable: number;
};

/**
 * Walks every TechRequest with a linked Intercom Ticket, compares Hub status
 * to Intercom's live state, and audits every mismatch and every unmapped
 * state. Never writes TechRequest.status -- see the module doc comment.
 *
 * Returns an all-zero summary immediately, without a query, when Intercom has
 * no access token configured: nothing here could ever succeed without one, so
 * there is no reason to page through rows just to fail fetchTicketState on
 * every single one.
 *
 * Database reads are NOT caught here -- isDbUnreachableError propagates to the
 * caller (the cron route), which is the layer that owns the HTTP-level
 * response. recordAudit itself is already fire-and-forget on its default
 * (singleton) path (see platform/audit.ts's own doc comment), so an audit
 * failure never aborts the sweep; only the underlying findMany reads can
 * throw out of this function.
 */
export async function reconcileIntercomTickets(): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    checked: 0,
    inSync: 0,
    mismatched: 0,
    unmappedIntercomState: 0,
    unreachable: 0,
  };

  if (!intercomAccessToken()) return summary;

  let cursor: string | undefined;

  while (summary.checked < MAX_ROWS_PER_RUN) {
    const rows = await prisma.techRequest.findMany({
      where: { intercomTicketId: { not: null } },
      orderBy: { id: "asc" },
      take: Math.min(PAGE_SIZE, MAX_ROWS_PER_RUN - summary.checked),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, number: true, status: true, intercomTicketId: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      summary.checked += 1;
      // Not null by construction of the where clause above -- select does not
      // narrow that, so this guard is only ever a type-level formality.
      const ticketId = row.intercomTicketId;
      if (!ticketId) continue;

      const internalLabel = await fetchTicketState(ticketId);
      if (internalLabel === null) {
        // Could not reach Intercom for this one ticket right now -- an
        // outage, not evidence of drift. "We don't know" must never become
        // "they disagree".
        summary.unreachable += 1;
        continue;
      }

      const mappedStatus = mapIntercomTicketStateToStatus(internalLabel);
      if (!mappedStatus) {
        // A state the Hub does not recognize -- someone added a custom state
        // in Intercom's UI without a matching code change. There is nothing
        // to compare against, so this is its own reported condition, distinct
        // from (and audited separately from) a status mismatch.
        summary.unmappedIntercomState += 1;
        log.warn("[support] reconciliation found an Intercom ticket state with no mapped status", {
          ticketId,
          ticketNumber: row.number,
          internalLabel,
        });
        await recordAudit({
          actorPersonId: null,
          action: "intercom_reconcile.unmapped_state",
          entityType: "TechRequest",
          entityId: row.id,
          after: { ticketNumber: row.number, intercomTicketId: ticketId, internalLabel },
        });
        continue;
      }

      if (mappedStatus === row.status) {
        summary.inSync += 1;
        continue;
      }

      summary.mismatched += 1;
      log.warn("[support] reconciliation found a status mismatch between the Hub and Intercom", {
        ticketId,
        ticketNumber: row.number,
        hubStatus: row.status,
        intercomInternalLabel: internalLabel,
        intercomMappedStatus: mappedStatus,
      });
      await recordAudit({
        actorPersonId: null,
        action: "intercom_reconcile.status_mismatch",
        entityType: "TechRequest",
        entityId: row.id,
        before: { hubStatus: row.status },
        after: {
          ticketNumber: row.number,
          intercomTicketId: ticketId,
          intercomInternalLabel: internalLabel,
          intercomMappedStatus: mappedStatus,
        },
      });
    }

    if (rows.length < PAGE_SIZE) break;
  }

  return summary;
}
