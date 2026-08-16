import { SignJWT } from "jose";
import { intercomMessengerSecret } from "./config";

/**
 * Lifetime of a minted Messenger JWT.
 *
 * Intercom's guidance is to match the token lifetime to the app's session, but
 * a 7-day hub session is far too long for a bearer token sitting in a browser.
 * This is deliberately short and the client refreshes it in the background (see
 * messenger.tsx), so a leaked token expires quickly while a clinic tab left
 * open all day keeps working.
 */
export const INTERCOM_TOKEN_TTL_SECONDS = 60 * 60;

export type IntercomUserClaims = {
  personId: string;
  name: string | null;
  email: string | null;
  /**
   * Help-centre audience flags (see audience.ts). Required, not optional: an
   * omitted attribute is not "unset" to Intercom, it keeps its previous value,
   * so forgetting to pass these would silently leave revoked permissions
   * granted on the contact.
   */
  audience: Record<string, boolean>;
  /**
   * Member-context attributes for the contact profile a human agent reads
   * (see profile.ts) -- Epic ID, Yale NetID, Departments, Member status,
   * Active term, Clearance at last sign-in. Optional, and each key is sent
   * only when profile.ts resolved a value: unlike audience above, an absent
   * key here is left alone deliberately (see mintIntercomUserJwt's doc
   * comment for why the two claim groups use opposite rules).
   */
  profile?: Record<string, string>;
};

/**
 * Signs the identity-verification JWT the Messenger boots with.
 *
 * HS256 with the workspace Messenger secret is what Intercom verifies against.
 * `user_id` is the claim Intercom keys the contact on, so it MUST be our stable
 * Person id, resolved server-side -- never a value the browser supplied. Every
 * downstream decision (which member Fin is talking to, and therefore what it is
 * allowed to answer) inherits its trust from this one claim.
 *
 * Optional claims are omitted rather than sent as null: Intercom treats a
 * present-but-null attribute as an instruction to clear it on the contact.
 *
 * Two claim groups ride alongside the identity claims above, and they
 * deliberately follow OPPOSITE rules -- both are assembled right here, so the
 * asymmetry is explained once, at the one place it would otherwise look like
 * an inconsistency:
 *
 *   - `audience` (see audience.ts) is always sent IN FULL, false values
 *     included. Intercom MERGES custom attributes onto the contact rather
 *     than replacing them, so an omitted flag keeps whatever value it had
 *     before -- a demoted director whose flag simply stopped being sent would
 *     keep seeing admin articles forever. Sending `false` explicitly is the
 *     only thing that revokes access.
 *   - `profile` (see profile.ts) is the reverse: a key is included only when
 *     profile.ts resolved a value, and OMITTED rather than sent as null when
 *     it did not. These attributes accumulate the Hub's best-known context
 *     about a member (Epic ID, department, clearance) rather than toggle a
 *     permission, and some of that context is deliberately retained after it
 *     would otherwise look stale -- offboarding never clears Person.epicId,
 *     for instance (see epic.ts's completeRequest). Sending null on absence
 *     would erase something the Hub chose to keep, the opposite failure from
 *     the one `audience` guards against.
 */
export async function mintIntercomUserJwt(claims: IntercomUserClaims): Promise<string> {
  const secret = intercomMessengerSecret();
  if (!secret) throw new Error("INTERCOM_MESSENGER_SECRET is not set");

  return new SignJWT({
    user_id: claims.personId,
    ...(claims.email ? { email: claims.email } : {}),
    ...(claims.name ? { name: claims.name } : {}),
    ...claims.audience,
    ...(claims.profile ?? {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${INTERCOM_TOKEN_TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(secret));
}
