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
