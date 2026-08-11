import { getActivePerson } from "@/platform/auth/match-person";
import { log, errorAttrs } from "@/platform/logging";
import { intercomAccessToken } from "./config";

const INTERCOM_API = "https://api.intercom.io";

/**
 * Pinned explicitly rather than left to Intercom's workspace default. Without
 * this header Intercom resolves whatever API version the workspace happens to
 * be set to, and find_by_external_id does not exist on older versions -- a
 * workspace pinned to one would 404 every lookup below, which this code maps
 * to "unverified" and permanently refuses every real member. Pinning makes
 * that failure mode depend on our own deploy, not on a setting we don't
 * control.
 */
const INTERCOM_API_VERSION = "2.14";

export type ResolvedIdentity =
  | { ok: true; personId: string; name: string | null }
  | { ok: false; reason: "unverified" | "unknown_person" | "lookup_failed" };

/**
 * Resolves who is in an Intercom conversation, from the conversation id alone.
 *
 * This exists because Fin's custom MCP connector cannot set request headers.
 * Confirmed in production: the endpoint returned 403 on every call because
 * X-Intercom-Person-Id never arrived, while bearer auth passed. Identity
 * therefore has to travel as a tool input, and that is a weaker position --
 * anything the model can fill in, a prompt injection can try to steer.
 *
 * Taking the CONVERSATION id rather than a person id is what claws most of that
 * back. The model never gets to assert "I am person X"; it can only name a
 * conversation, and we ask Intercom who owns it. Compare resolveIntercomIdentity
 * above, which can only confirm that a supplied id names someone real: this one
 * derives the answer from Intercom's own record instead of taking it on trust,
 * so a swapped value has to be another member's real conversation id rather
 * than merely another member's id.
 *
 * Fails closed on anything ambiguous. A conversation with no contacts (Intercom
 * returns these -- observed in this workspace) or with several is not something
 * we can pin to one member, and guessing which is exactly the kind of judgement
 * that turns into a cross-account read.
 */
export async function resolveIdentityFromConversation(
  conversationId: string
): Promise<ResolvedIdentity> {
  const token = intercomAccessToken();
  if (!token) return { ok: false, reason: "lookup_failed" };

  const endpoint = "conversations/:id";
  let contacts: Array<{ external_id?: string | null }> = [];
  try {
    const res = await fetch(
      `${INTERCOM_API}/conversations/${encodeURIComponent(conversationId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Intercom-Version": INTERCOM_API_VERSION,
        },
        cache: "no-store",
      }
    );
    // 404 means no such conversation in this workspace, which is what a made-up
    // or swapped id looks like. Refusal, not an outage.
    if (res.status === 404) return { ok: false, reason: "unverified" };
    if (!res.ok) {
      log.warn("[intercom-mcp] conversation lookup failed", {
        endpoint,
        version: INTERCOM_API_VERSION,
        status: res.status,
      });
      return { ok: false, reason: "lookup_failed" };
    }
    const body = (await res.json()) as {
      contacts?: { contacts?: Array<{ external_id?: string | null }> };
    };
    contacts = body.contacts?.contacts ?? [];
  } catch (err) {
    log.warn(
      "[intercom-mcp] conversation lookup failed",
      errorAttrs(err, { endpoint, version: INTERCOM_API_VERSION })
    );
    return { ok: false, reason: "lookup_failed" };
  }

  // Exactly one, or we cannot say who is asking.
  if (contacts.length !== 1) return { ok: false, reason: "unverified" };

  const externalId = contacts[0]?.external_id;
  // A contact with no external_id never booted our Messenger (a lead, or an
  // Intercom-native contact), so there is no Person behind it to authorize.
  if (!externalId) return { ok: false, reason: "unverified" };

  // Same revocation check as the id path: Intercom's record can outlive ours.
  const person = await getActivePerson(externalId);
  if (!person) return { ok: false, reason: "unknown_person" };

  return { ok: true, personId: person.id, name: person.name };
}

/**
 * Turns a claimed Person id into a verified one, or refuses.
 *
 * What this actually proves: a user-role contact with this external_id exists
 * in the workspace (find_by_external_id excludes leads), and the matching
 * Person is still active. That is all. Because the lookup is keyed BY
 * external_id, a 200 response necessarily echoes that same id back -- it
 * cannot detect a claim that has been swapped for a different real member's
 * id. Concretely: an Intercom input left on "let Fin decide" would let the
 * model supply any real member's id, and this function would verify it
 * successfully, because that id genuinely does belong to a real, active
 * contact. Catching that misconfiguration is the job of the audit trail
 * (recordToolCall in ./audit.ts), which is why that module documents itself
 * as the primary detection mechanism -- not this one.
 *
 * A tool that needs to read or act on a DIFFERENT person than the caller
 * cannot rely on this check alone and needs a stronger binding before it
 * ships; nothing here establishes that the claimed id is who is actually in
 * the conversation, only that it names someone real and active.
 *
 * Every failure path returns ok:false. There is deliberately no fallback that
 * answers with reduced scope, because a caller we cannot identify is a caller
 * we cannot authorize.
 */
export async function resolveIntercomIdentity(claimedPersonId: string): Promise<ResolvedIdentity> {
  const token = intercomAccessToken();
  if (!token) return { ok: false, reason: "lookup_failed" };

  const endpoint = "contacts/find_by_external_id";

  let contact: { external_id?: string } | null = null;
  try {
    const res = await fetch(
      `${INTERCOM_API}/contacts/find_by_external_id/${encodeURIComponent(claimedPersonId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Intercom-Version": INTERCOM_API_VERSION,
        },
        cache: "no-store",
      }
    );
    // A 404 is a refusal, not an error: it means the id does not name a contact
    // in this workspace, which is exactly what a forged claim looks like. Any
    // other error status means our lookup broke (bad token, rate limit, outage),
    // so we fail the same way as a fetch exception.
    if (res.status === 404) return { ok: false, reason: "unverified" };
    // 410 Gone means the contact was merged into another one -- Intercom's
    // documented behavior, with a Link header naming the canonical contact.
    // Merges happen during ordinary support work, so this is routine, not an
    // outage; logging it distinctly (instead of folding it into the generic
    // status-number branch below) is what lets an operator tell "a member got
    // merged" apart from "the API is broken" without re-deriving it from a
    // bare number.
    if (res.status === 410) {
      log.warn("[intercom-mcp] contact lookup found a merged contact", {
        endpoint,
        version: INTERCOM_API_VERSION,
        link: res.headers.get("link"),
      });
      return { ok: false, reason: "lookup_failed" };
    }
    if (!res.ok) {
      log.warn("[intercom-mcp] contact lookup failed", {
        endpoint,
        version: INTERCOM_API_VERSION,
        status: res.status,
      });
      return { ok: false, reason: "lookup_failed" };
    }
    contact = (await res.json()) as { external_id?: string };
  } catch (err) {
    log.warn("[intercom-mcp] contact lookup failed", errorAttrs(err, { endpoint, version: INTERCOM_API_VERSION }));
    return { ok: false, reason: "lookup_failed" };
  }

  // A 200 response is, by construction, echoing back the external_id we
  // looked it up by, so this cannot ever catch a genuine mismatch -- it is
  // not the "was the claim swapped for someone else" check the top-level
  // comment used to imply. It exists only as a guard against a malformed or
  // spoofed response body from Intercom's own API.
  if (!contact || contact.external_id !== claimedPersonId) {
    return { ok: false, reason: "unverified" };
  }

  // Second gate: Intercom's record can outlive ours. This is the revocation
  // check, so an offboarded member stops resolving even while their contact
  // still exists in the workspace.
  const person = await getActivePerson(claimedPersonId);
  if (!person) return { ok: false, reason: "unknown_person" };

  return { ok: true, personId: person.id, name: person.name };
}
