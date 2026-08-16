import { findMemberRecordByClaim, getActivePerson } from "@/platform/auth/match-person";
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

/**
 * Ceiling on a single Intercom lookup. Fin is waiting on this call
 * synchronously as part of answering the member, and neither fetch below used
 * to set a timeout at all -- a hung Intercom request would block the tool
 * call until the platform itself killed the function, which is a far worse
 * failure mode than a fast, explicit refusal. A few seconds is generous for
 * one REST call and still comfortably inside a serverless function's own
 * timeout.
 */
export const INTERCOM_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * WHICH evidence established a successful identity, so a caller that cares can
 * tell the two apart -- today that is the ticket.created webhook, which audits
 * a ticket attributed by the weaker of the two.
 *
 * "external_id" is the strong form: the contact carries a Person id our own
 * Messenger wrote there after an authenticated Hub session, so Intercom's
 * record is downstream of a real sign-in.
 *
 * "verified_email" is the weaker form, and is only ever reachable by opting in
 * (see ConversationIdentityOptions). The evidence is an email ADDRESS on the
 * contact, which for an email-sourced conversation originates in a `From:`
 * header -- assertable by anyone who can send mail, not by anyone who can sign
 * in. See resolveByContactEmail for the gate that narrows it and for why the
 * one caller that opts in can afford it.
 *
 * Optional purely so a test double can stay terse; both resolvers below always
 * set it.
 */
export type IdentityEvidence = "external_id" | "verified_email";

export type ResolvedIdentity =
  | { ok: true; personId: string; name: string | null; via?: IdentityEvidence }
  | { ok: false; reason: IdentityFailureReason };

/**
 * Every distinct way identity resolution can fail to confirm a caller.
 * UNIDENTIFIED_MESSAGE (below) deliberately returns the same refusal text for
 * all of these -- distinguishing them to the caller is a probe for
 * enumerating real conversations -- but the audit trail is the one place that
 * is allowed to, and is documented as the primary way to detect an
 * Intercom-side misconfiguration (see recordToolCall in ./audit.ts). Without
 * this, a burst of refusals cannot say which failure mode is actually
 * happening.
 */
export type IdentityFailureReason =
  | "no_conversation_id" // the tool call carried no conversation id at all
  | "unverified" // the claimed id or conversation does not check out
  | "no_contact" // the conversation resolved, but not to exactly one Messenger-linked contact
  | "unknown_person" // the contact resolved, but its Person is not active
  | "lookup_failed"; // the Intercom API call itself failed -- network, timeout, non-2xx, bad token

/**
 * Fixed, non-revealing text returned to a caller when identity does not
 * resolve. Shared by every entry point built on resolveIdentityFromConversation
 * (the MCP tool wrapper in ../../app/api/mcp/route.ts, and the ticket-sync
 * endpoint at ../../app/api/support/tickets/from-conversation/route.ts) so a
 * caller can never distinguish "no conversation id", "no such conversation",
 * "that conversation has no contact", and "that contact is not an active
 * member" by comparing wording across the two surfaces. Colocated here,
 * next to IdentityFailureReason, rather than owned by either caller.
 */
export const UNIDENTIFIED_MESSAGE =
  "I could not confirm who you are, so I cannot look that up. Please contact a human on the team.";

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
 *
 * options.allowVerifiedEmailFallback widens this for exactly one caller; the
 * default is the behavior described above, unchanged.
 */
export async function resolveIdentityFromConversation(
  conversationId: string,
  options: ConversationIdentityOptions = {}
): Promise<ResolvedIdentity> {
  const token = intercomAccessToken();
  if (!token) return { ok: false, reason: "lookup_failed" };

  const endpoint = "conversations/:id";
  let contacts: Array<{ id?: string | null; external_id?: string | null }> = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERCOM_LOOKUP_TIMEOUT_MS);
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
        signal: controller.signal,
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
      contacts?: { contacts?: Array<{ id?: string | null; external_id?: string | null }> };
    };
    contacts = body.contacts?.contacts ?? [];
  } catch (err) {
    // Catches a network failure and an abort (the timeout above) alike -- a
    // timed-out lookup is exactly as unable to confirm identity as one that
    // errored outright, so it fails closed the same way. Still logged with
    // the endpoint, so a run of timeouts is distinguishable from a run of
    // some other failure in the log line itself, even though both map to the
    // same reason here.
    log.warn(
      "[intercom-mcp] conversation lookup failed",
      errorAttrs(err, { endpoint, version: INTERCOM_API_VERSION })
    );
    return { ok: false, reason: "lookup_failed" };
  } finally {
    clearTimeout(timeout);
  }

  // Exactly one, or we cannot say who is asking.
  if (contacts.length !== 1) return { ok: false, reason: "no_contact" };

  const contact = contacts[0];
  const externalId = contact?.external_id;

  // The strong path, tried first and always: an external_id our Messenger
  // wrote, naming a Person who is still active. Same revocation check as the
  // id path, because Intercom's record can outlive ours.
  if (externalId) {
    const person = await getActivePerson(externalId);
    if (person) return { ok: true, personId: person.id, name: person.name, via: "external_id" };
  }

  // The opt-in weak path. Reached in two shapes, both of which the strong path
  // above has just failed on: no external_id at all, or one that names nobody
  // active. An Intercom-generated UUID is the second shape -- see
  // resolveByContactEmail for why the old code could not tell it from the
  // first.
  if (options.allowVerifiedEmailFallback && contact?.id) {
    const fallback = await resolveByContactEmail(contact.id);
    if (fallback.ok) {
      return { ok: true, personId: fallback.personId, name: fallback.name, via: "verified_email" };
    }
    // "We could not ask" must not be reported as "they are not a member": the
    // one caller that opts into this fallback treats a permanent refusal as a
    // deliberate no-op and stops retrying, which would silently drop a real
    // member's ticket over a momentary Intercom outage.
    if (fallback.transient) return { ok: false, reason: "lookup_failed" };
  }

  // Refuse with exactly the reason this function returned before the fallback
  // existed, so the audit trail keeps distinguishing "that contact never
  // booted our Messenger" from "it did, but names nobody active".
  if (!externalId) return { ok: false, reason: "no_contact" };
  return { ok: false, reason: "unknown_person" };
}

export type ConversationIdentityOptions = {
  /**
   * Allow identity to be established from the contact's EMAIL ADDRESS when
   * external_id establishes nothing.
   *
   * Off by default, and deliberately opt-in per call site rather than a
   * blanket widening: this is weaker evidence than the external_id path, and
   * every caller should have to say out loud that its blast radius can afford
   * it.
   *
   * Why it is needed at all: the pre-existing `!external_id` guard encoded the
   * belief that a contact who never booted our Messenger has no external_id to
   * check. Production disproved it on 2026-08-16. A member emailed support from
   * a yale.edu address, Intercom auto-created a LEAD for the sender and stamped
   * it with an external_id of its OWN -- a UUID, not a Person cuid -- so the
   * guard did not fire, getActivePerson was handed a UUID, and the ticket was
   * refused as "unknown_person". Correct, and useless: every email-originated
   * ticket from a real member was invisible to the Hub, and each one left a
   * webhook Intercom retried forever.
   *
   * The trust question this raises is real and is not waved away. On the
   * external_id path Intercom's record is downstream of a Hub sign-in. Here the
   * address is a `From:` header, which is asserted by whoever sent the mail.
   * Two things make it affordable for the ticket.created webhook specifically:
   * the matching runs through findMemberRecordByClaim, whose email step already
   * only accepts a Yale-domain claim (a stored personal address can never be
   * reached this way), and the worst outcome on that route is a ticket filed
   * under the wrong member's NAME -- it grants no read of anyone's data. Do not
   * extend this to the MCP tools on that reasoning: those read a member's own
   * record back to whoever is asking, where the same spoof is a cross-account
   * read.
   */
  allowVerifiedEmailFallback?: boolean;
};

type EmailFallbackResult =
  | { ok: true; personId: string; name: string | null }
  | { ok: false; transient: boolean };

/**
 * Second-chance identity: fetch the contact, and match the email Intercom holds
 * for it against a Person.
 *
 * A second HTTP call, deliberately. The conversation payload's contact entries
 * carry only `type`, `id`, and `external_id` -- verified against the live
 * workspace on 2026-08-16 -- so there is no email on the response the caller
 * already has. It runs only after the external_id path has failed, which on the
 * ticket.created webhook is the uncommon case, so this is not a per-call cost.
 *
 * MATCHING IS NOT IMPLEMENTED HERE. It delegates to findMemberRecordByClaim,
 * which is match-person.ts's single definition of "this claim names that
 * Person" and carries the Yale-domain gate on its email step. That file's own
 * doc comment asks in as many words that the rules be changed only there, and a
 * second hand-rolled copy of a trust gate here is the drift it is warning
 * about. What that function does NOT do is check status -- it is documented as
 * the no-status-gate variant -- so getActivePerson still runs afterwards, which
 * is what keeps an offboarded member from being resolved by an address that is
 * still on their old contact.
 *
 * Distinguishes "no match" from "could not ask": every failure to REACH
 * Intercom returns transient:true, so the caller can refuse in a way that still
 * gets retried. A 404 (no such contact) is a real answer, not an outage.
 */
async function resolveByContactEmail(contactId: string): Promise<EmailFallbackResult> {
  const token = intercomAccessToken();
  if (!token) return { ok: false, transient: true };

  const endpoint = "contacts/:id";
  let email: string | null = null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERCOM_LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(`${INTERCOM_API}/contacts/${encodeURIComponent(contactId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Intercom-Version": INTERCOM_API_VERSION,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (res.status === 404) return { ok: false, transient: false };
    if (!res.ok) {
      log.warn("[intercom] contact lookup failed", {
        endpoint,
        version: INTERCOM_API_VERSION,
        status: res.status,
      });
      return { ok: false, transient: true };
    }
    const body = (await res.json()) as { email?: string | null };
    email = typeof body.email === "string" ? body.email.trim() : null;
  } catch (err) {
    log.warn("[intercom] contact lookup failed", errorAttrs(err, { endpoint, version: INTERCOM_API_VERSION }));
    return { ok: false, transient: true };
  } finally {
    clearTimeout(timeout);
  }

  // A contact with no address on it is a real answer too: there is nothing to
  // match, and nothing a retry would change.
  if (!email) return { ok: false, transient: false };

  const match = await findMemberRecordByClaim({ upn: email, email });
  if (!match) return { ok: false, transient: false };

  const person = await getActivePerson(match.id);
  if (!person) return { ok: false, transient: false };

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERCOM_LOOKUP_TIMEOUT_MS);
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
        signal: controller.signal,
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
    // Catches a network failure and an abort (the timeout above) alike -- see
    // the matching comment in resolveIdentityFromConversation.
    log.warn("[intercom-mcp] contact lookup failed", errorAttrs(err, { endpoint, version: INTERCOM_API_VERSION }));
    return { ok: false, reason: "lookup_failed" };
  } finally {
    clearTimeout(timeout);
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

  return { ok: true, personId: person.id, name: person.name, via: "external_id" };
}
