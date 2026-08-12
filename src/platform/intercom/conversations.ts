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
 * Posts a customer-visible reply into an Intercom conversation, authored as
 * the configured bot/workflow admin (see intercomBotAdminId).
 *
 * Never throws. Every failure -- unconfigured, network error, timeout,
 * non-2xx -- resolves to `false` and is logged (fail-closed logging, same
 * shape as identity.ts's resolveIdentityFromConversation), because the
 * caller's contract is "a Hub status change must succeed even when Intercom
 * is unreachable": the DB write of record has already committed by the time
 * this runs, and nothing here may turn that into a failed request.
 */
export async function postConversationReply(conversationId: string, body: string): Promise<boolean> {
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
      // type: "admin" + message_type: "comment" is Intercom's customer-visible
      // reply -- the member sees this in the same thread they used, which is
      // the entire point (vs. message_type: "note", which is staff-only and
      // would silently not reach them).
      body: JSON.stringify({
        message_type: "comment",
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
