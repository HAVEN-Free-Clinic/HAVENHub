import { getActivePerson } from "@/platform/auth/match-person";
import { log, errorAttrs } from "@/platform/logging";
import { intercomAccessToken } from "./config";

const INTERCOM_API = "https://api.intercom.io";

export type ResolvedIdentity =
  | { ok: true; personId: string; name: string | null }
  | { ok: false; reason: "unverified" | "unknown_person" | "lookup_failed" };

/**
 * Turns a claimed Person id into a verified one, or refuses.
 *
 * Fin supplies the id by binding a tool input to the contact's user_id
 * attribute, which our Messenger JWT set and the browser cannot forge. That is
 * a strong chain, but its weakest link is configuration in Intercom's UI rather
 * than code: an input left on "let Fin decide" would silently downgrade the id
 * to something the model chose. So the claim is re-verified here against
 * Intercom's own record of the contact, and never taken at face value.
 *
 * Every failure path returns ok:false. There is deliberately no fallback that
 * answers with reduced scope, because a caller we cannot identify is a caller
 * we cannot authorize.
 */
export async function resolveIntercomIdentity(claimedPersonId: string): Promise<ResolvedIdentity> {
  const token = intercomAccessToken();
  if (!token) return { ok: false, reason: "lookup_failed" };

  let contact: { external_id?: string } | null = null;
  try {
    const res = await fetch(
      `${INTERCOM_API}/contacts/find_by_external_id/${encodeURIComponent(claimedPersonId)}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store",
      }
    );
    // A 404 is a refusal, not an error: it means the id does not name a contact
    // in this workspace, which is exactly what a forged claim looks like. Any
    // other error status means our lookup broke (bad token, rate limit, outage),
    // so we fail the same way as a fetch exception.
    if (res.status === 404) return { ok: false, reason: "unverified" };
    if (!res.ok) {
      log.warn("[intercom-mcp] contact lookup failed", { status: res.status });
      return { ok: false, reason: "lookup_failed" };
    }
    contact = (await res.json()) as { external_id?: string };
  } catch (err) {
    log.warn("[intercom-mcp] contact lookup failed", errorAttrs(err));
    return { ok: false, reason: "lookup_failed" };
  }

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
