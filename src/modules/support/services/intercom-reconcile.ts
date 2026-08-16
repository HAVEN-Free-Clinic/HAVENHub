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
import { log, errorAttrs } from "@/platform/logging";
import { fetchTicketState } from "@/platform/intercom/tickets";
import { intercomAccessToken } from "@/platform/intercom/config";
import { mapIntercomTicketStateToStatus } from "./intercom-sync";

/** One page at a time, so a large backlog never holds one giant result set in memory. */
const PAGE_SIZE = 50;

/**
 * Hard ceiling on rows touched in a single invocation. A serverless function
 * has its own wall-clock budget (see the cron route's maxDuration); this is
 * what keeps a large backlog from timing out mid-sweep and reconciling
 * nothing.
 */
const MAX_ROWS_PER_RUN = 500;

/**
 * Where the last run stopped, so the next one starts after it.
 *
 * The ceiling above used to be the whole story, and the claim that "the next
 * scheduled run picks up past where this one stopped" was simply false: each
 * run started from `orderBy: id asc` with no cursor, so the 501st linked ticket
 * onwards was never read by any run, ever. The sweep still reported a clean
 * summary -- checked: 500, mismatched: 0 -- which is worse than reporting
 * nothing, because the backstop for a silently missed status sync was itself
 * silently missing statuses (audit 14, SUP-4).
 *
 * Stored in the Setting key/value table, the same place cron liveness
 * heartbeats live (src/platform/cron-heartbeat.ts), so persisting runtime state
 * needs no schema change. Not registered in the settings catalog: this is a
 * position marker the sweep writes to itself, never an admin-editable value.
 *
 * Cleared when a run reaches the end of the table, so the next run wraps back
 * to the start. A sweep that only ever moved forward would check each ticket
 * once and then go quiet forever, which is the opposite of what a drift
 * detector is for -- drift appears at any time on a ticket that was in sync
 * yesterday.
 */
const CURSOR_KEY = "intercom.reconcileCursor";

async function readCursor(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: CURSOR_KEY } });
  const value = row?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const lastId = (value as Record<string, unknown>).lastId;
  return typeof lastId === "string" && lastId !== "" ? lastId : null;
}

/**
 * Best-effort, like recordCronHeartbeat: a failed cursor write must not turn a
 * completed sweep into a failed cron run. It IS logged rather than swallowed
 * silently, because a cursor that never advances is exactly the failure this
 * whole mechanism exists to end, and it would otherwise look identical to the
 * bug it replaced.
 */
async function writeCursor(lastId: string | null): Promise<void> {
  try {
    await prisma.setting.upsert({
      where: { key: CURSOR_KEY },
      create: { key: CURSOR_KEY, value: { lastId } },
      update: { value: { lastId } },
    });
  } catch (err) {
    log.warn("[support] reconciliation could not persist its cursor", errorAttrs(err, { lastId }));
  }
}

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
export async function reconcileIntercomTickets(
  options: { maxRows?: number } = {}
): Promise<ReconcileSummary> {
  const maxRows = options.maxRows ?? MAX_ROWS_PER_RUN;
  const summary: ReconcileSummary = {
    checked: 0,
    inSync: 0,
    mismatched: 0,
    unmappedIntercomState: 0,
    unreachable: 0,
  };

  if (!intercomAccessToken()) return summary;

  // Resumes where the last run stopped. Read before the loop rather than per
  // page: a run is one continuous walk, and re-reading mid-sweep would let a
  // concurrent run's cursor rewind this one.
  let lastId = await readCursor();
  // Distinguishes "stopped because the table ran out" (wrap back to the start
  // next time) from "stopped because maxRows was reached" (resume from lastId).
  let reachedEnd = false;

  while (summary.checked < maxRows) {
    const take = Math.min(PAGE_SIZE, maxRows - summary.checked);
    const rows = await prisma.techRequest.findMany({
      // An explicit `id: { gt: lastId }` rather than Prisma's `cursor`, because
      // a persisted cursor outlives the row it names: a ticket deleted between
      // runs would leave `cursor` pointing at a row that no longer exists,
      // while a plain range predicate simply resumes after that id.
      where: { intercomTicketId: { not: null }, ...(lastId ? { id: { gt: lastId } } : {}) },
      orderBy: { id: "asc" },
      take,
      select: { id: true, number: true, status: true, intercomTicketId: true },
    });
    if (rows.length === 0) {
      reachedEnd = true;
      break;
    }
    lastId = rows[rows.length - 1].id;

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

    // Short page means this query exhausted the table, not merely this budget.
    // Compared against `take`, not PAGE_SIZE: the final page of a run is
    // deliberately smaller when maxRows is about to be hit, and treating that
    // as the end of the table would clear the cursor and re-scan from the top
    // forever -- the very bug this cursor exists to fix.
    if (rows.length < take) {
      reachedEnd = true;
      break;
    }
  }

  await writeCursor(reachedEnd ? null : lastId);
  log.info("[support] reconciliation sweep finished", {
    ...summary,
    // Where the next run will start: null means "back at the beginning".
    resumeAfterId: reachedEnd ? null : lastId,
  });

  return summary;
}
