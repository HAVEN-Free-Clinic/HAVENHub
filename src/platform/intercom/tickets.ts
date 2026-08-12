import { log, errorAttrs } from "@/platform/logging";
import { intercomAccessToken } from "./config";

const INTERCOM_API = "https://api.intercom.io";

/**
 * Same pin as conversations.ts and identity.ts, and for the same reason: left
 * to the workspace default, this write's behavior would depend on a setting
 * this codebase does not control. See identity.ts's INTERCOM_API_VERSION doc
 * comment for the full rationale; duplicated here rather than imported
 * because these files intentionally have no dependency on each other.
 */
const INTERCOM_API_VERSION = "2.14";

/**
 * Ceiling on the ticket-number write-back. Same value and same reasoning as
 * conversations.ts's INTERCOM_REPLY_TIMEOUT_MS -- generous for one REST call,
 * comfortably inside a serverless function's own timeout -- kept as a
 * separate constant because this call site may reasonably need a different
 * budget later.
 */
export const INTERCOM_TICKET_WRITE_TIMEOUT_MS = 5_000;

/**
 * Same budget as INTERCOM_TICKET_WRITE_TIMEOUT_MS, kept as its own constant
 * because fetchTicketState below is called once per row inside the
 * reconciliation cron's paged loop (src/app/api/cron/intercom-reconcile) --
 * a batch of these adds up, unlike the one-off writes above -- so this name
 * gives that call site room to tune its own budget independently later.
 */
export const INTERCOM_TICKET_READ_TIMEOUT_MS = 5_000;

/**
 * The Intercom ticket-type attribute this write targets. Created 2026-08-11
 * on all six ticket types for exactly this purpose (see
 * docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md).
 */
const HUB_TICKET_NUMBER_ATTRIBUTE = "Hub ticket number";

/**
 * Writes the Hub's ticket `number` onto an Intercom Ticket's "Hub ticket
 * number" attribute (`PUT /tickets/{id}`, `ticket_attributes`).
 *
 * This is the write-back Direction 1's earlier attempt could not do: that
 * path (src/app/api/support/tickets/from-conversation/route.ts) only ever
 * had a conversation id, and this attribute lives in the Ticket Type
 * attribute namespace -- a different write surface from a conversation's
 * custom_attributes, which cannot reach it at all (see that route's doc
 * comment for the full explanation). The ticket.created webhook is the first
 * place a real Intercom ticket id exists to write through.
 *
 * Best-effort, deliberately: the ticket already exists and the member already
 * has their number by the time this runs (see the design's "Step 4 is
 * best-effort" note), so a failed write-back is a cosmetic problem, not a
 * reason to fail the webhook. Never throws -- unconfigured, network error,
 * timeout, and non-2xx all resolve to `false` and are logged, the same
 * fail-closed shape as postConversationNote and resolveIdentityFromConversation.
 */
export async function pushTicketNumber(ticketId: string, number: number): Promise<boolean> {
  const token = intercomAccessToken();
  if (!token) return false;

  const endpoint = "tickets/:id";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERCOM_TICKET_WRITE_TIMEOUT_MS);
  try {
    const res = await fetch(`${INTERCOM_API}/tickets/${encodeURIComponent(ticketId)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Intercom-Version": INTERCOM_API_VERSION,
      },
      body: JSON.stringify({
        ticket_attributes: { [HUB_TICKET_NUMBER_ATTRIBUTE]: number },
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn("[intercom] ticket number write-back failed", {
        endpoint,
        version: INTERCOM_API_VERSION,
        status: res.status,
      });
      return false;
    }
    return true;
  } catch (err) {
    // Catches a network failure and an abort (the timeout above) alike -- see
    // the matching comment in identity.ts.
    log.warn(
      "[intercom] ticket number write-back failed",
      errorAttrs(err, { endpoint, version: INTERCOM_API_VERSION })
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Writes a new state onto an Intercom Ticket (`PUT /tickets/{id}`, `state`).
 *
 * This is the outward half of Direction 3 (see
 * docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md): a Hub
 * status change setting the Ticket's state so the member sees it in
 * Intercom's own UI, natively, with no Hub-authored text crossing over. The
 * inbound half reads a ticket's current state back out via the webhook's
 * `ticket_state_internal_label` field (see intercom-sync.ts); this write
 * targets that same state, taking the label directly rather than a separate
 * numeric/opaque state id. Like pushTicketNumber above, this has not been
 * verified against a live workspace -- confirming the write side of a custom
 * ticket state accepts its label directly is the highest-value thing to
 * check before this ships live.
 *
 * Deliberately generic: takes a plain string label, not a TechRequestStatus.
 * Which label corresponds to which Hub status is a support-module concern
 * (src/modules/support/services/intercom-sync.ts's mapStatusToIntercomTicketState),
 * and src/platform must not import src/modules -- so the mapping happens one
 * layer up, and this function only ever moves a string across the wire.
 *
 * Same fail-closed, never-throw posture and the same timeout budget as
 * pushTicketNumber: unconfigured, network error, timeout, and non-2xx all
 * resolve to `false` and are logged, never thrown -- a Hub status change must
 * commit even when Intercom is unreachable.
 */
export async function pushTicketState(ticketId: string, stateLabel: string): Promise<boolean> {
  const token = intercomAccessToken();
  if (!token) return false;

  const endpoint = "tickets/:id";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERCOM_TICKET_WRITE_TIMEOUT_MS);
  try {
    const res = await fetch(`${INTERCOM_API}/tickets/${encodeURIComponent(ticketId)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Intercom-Version": INTERCOM_API_VERSION,
      },
      body: JSON.stringify({ state: stateLabel }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn("[intercom] ticket state write-back failed", {
        endpoint,
        version: INTERCOM_API_VERSION,
        status: res.status,
      });
      return false;
    }
    return true;
  } catch (err) {
    // Catches a network failure and an abort (the timeout above) alike -- see
    // the matching comment in identity.ts.
    log.warn(
      "[intercom] ticket state write-back failed",
      errorAttrs(err, { endpoint, version: INTERCOM_API_VERSION })
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Reads an Intercom Ticket's current staff-facing state label
 * (`ticket_state_internal_label`), the same field the ticket.state.updated
 * webhook carries in its payload (see intercom-sync.ts's
 * mapIntercomTicketStateToStatus, which this call site reuses to interpret
 * the label the same way inbound and reconciliation do).
 *
 * This is the read half Direction 3's webhook never needed: a webhook either
 * arrives or it does not, and when Intercom retries a failed delivery there is
 * nothing more to poll for. A delivery that Intercom gives up on entirely (or
 * an outage on our side at the moment it fired) leaves no further retry and no
 * trace to notice the loss by -- that gap is what the reconciliation cron
 * (src/app/api/cron/intercom-reconcile) exists to close, and it can only do
 * that by asking Intercom directly instead of waiting for an event that may
 * never come.
 *
 * Same fail-closed, never-throw posture as pushTicketNumber/pushTicketState
 * above: unconfigured, network error, timeout, and non-2xx all resolve to
 * `null` and are logged, never thrown. The cron treats `null` as "could not
 * check this one right now" and skips it, never as evidence of drift --
 * an unreachable Intercom must not manufacture a mismatch report.
 */
export async function fetchTicketState(ticketId: string): Promise<string | null> {
  const token = intercomAccessToken();
  if (!token) return null;

  const endpoint = "tickets/:id";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERCOM_TICKET_READ_TIMEOUT_MS);
  try {
    const res = await fetch(`${INTERCOM_API}/tickets/${encodeURIComponent(ticketId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Intercom-Version": INTERCOM_API_VERSION,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn("[intercom] ticket state read failed", {
        endpoint,
        version: INTERCOM_API_VERSION,
        status: res.status,
      });
      return null;
    }
    const body = (await res.json()) as { ticket_state_internal_label?: string | null };
    return body.ticket_state_internal_label ?? null;
  } catch (err) {
    // Catches a network failure and an abort (the timeout above) alike -- see
    // the matching comment in identity.ts.
    log.warn("[intercom] ticket state read failed", errorAttrs(err, { endpoint, version: INTERCOM_API_VERSION }));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
