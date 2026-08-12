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
 * Audience flags are the deliberate exception to that rule and are always sent
 * in full, false values included. See buildAudienceAttributes for why omitting
 * one would leave a revoked permission granted.
 */
export async function mintIntercomUserJwt(claims: IntercomUserClaims): Promise<string> {
  const secret = intercomMessengerSecret();
  if (!secret) throw new Error("INTERCOM_MESSENGER_SECRET is not set");

  return new SignJWT({
    user_id: claims.personId,
    ...(claims.email ? { email: claims.email } : {}),
    ...(claims.name ? { name: claims.name } : {}),
    ...claims.audience,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${INTERCOM_TOKEN_TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(secret));
}
