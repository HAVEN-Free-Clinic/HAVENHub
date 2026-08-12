import { log, errorAttrs } from "@/platform/logging";
import { intercomAccessToken, intercomBotAdminId } from "./config";

const INTERCOM_API = "https://api.intercom.io";

/**
 * Same pin as identity.ts, and for the same reason: leaving this to the
 * workspace default makes the reply endpoint's behavior depend on a setting
 * this codebase does not control. See identity.ts's INTERCOM_API_VERSION doc
 * comment for the full rationale; duplicated here rather than imported
 * because the two files intentionally have no dependency on each other.
 */
const INTERCOM_API_VERSION = "2.14";

/**
 * Ceiling on posting one conversation reply. A Hub status change (setStatus,
 * resolveRequest) waits on this call inline before returning, and per the
 * design a slow or hung Intercom call must never turn into a slow or hung
 * status change. Same value as identity.ts's INTERCOM_LOOKUP_TIMEOUT_MS --
 * generous for one REST call, comfortably inside a serverless function's own
 * timeout -- kept as a separate constant because the two call sites (a
 * synchronous Fin lookup vs. a background side effect of a Hub write) may
 * reasonably need different budgets later.
 */
export const INTERCOM_REPLY_TIMEOUT_MS = 5_000;

/**
 * Posts an INTERNAL NOTE into an Intercom conversation, authored as the
 * configured bot/workflow admin (see intercomBotAdminId).
 *
 * A note, deliberately, not a customer-visible reply. Hub-written content must
 * never render to a member: everything crossing this boundary is assembled
 * from database records, and Intercom shows tool and reply content straight to
 * the customer. Keeping it staff-only means a formatting mistake, an
 * unexpected field, or a future caller passing richer text is a leak to the
 * agent working the ticket rather than to the member.
 *
 * The consequence is real and intended: the member is NOT told when their
 * ticket changes status. An agent reads the note and decides what, if
 * anything, to relay in their own words. If automatic member-facing updates
 * are ever wanted, that is a separate decision about a separate message, not a
 * flag on this one.
 *
 * Never throws. Every failure -- unconfigured, network error, timeout,
 * non-2xx -- resolves to `false` and is logged (fail-closed logging, same
 * shape as identity.ts's resolveIdentityFromConversation), because the
 * caller's contract is "a Hub status change must succeed even when Intercom
 * is unreachable": the DB write of record has already committed by the time
 * this runs, and nothing here may turn that into a failed request.
 */
export async function postConversationNote(conversationId: string, body: string): Promise<boolean> {
  const token = intercomAccessToken();
  const adminId = intercomBotAdminId();
  if (!token || !adminId) return false;

  const endpoint = "conversations/:id/reply";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERCOM_REPLY_TIMEOUT_MS);
  try {
    const res = await fetch(`${INTERCOM_API}/conversations/${encodeURIComponent(conversationId)}/reply`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Intercom-Version": INTERCOM_API_VERSION,
      },
      // message_type: "note" is staff-only. "comment" would be the
      // customer-visible reply, and switching this one string is the whole
      // difference between an internal annotation and publishing Hub data to
      // the member -- so it is not a knob to make configurable.
      body: JSON.stringify({
        message_type: "note",
        type: "admin",
        admin_id: adminId,
        body,
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn("[intercom] conversation reply failed", {
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
      "[intercom] conversation reply failed",
      errorAttrs(err, { endpoint, version: INTERCOM_API_VERSION })
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
