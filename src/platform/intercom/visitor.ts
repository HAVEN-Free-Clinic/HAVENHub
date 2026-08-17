/**
 * Attributes attached to an ANONYMOUS Messenger boot, so a support agent can
 * see who a portal visitor signed in as while the Intercom contact itself
 * stays unidentified.
 *
 * WHY NOT JUST IDENTIFY THEM. An identified boot is the strong claim in this
 * codebase: it writes a Person id to the contact's external_id, and
 * resolveIdentityFromConversation (see identity.ts) reads exactly that to
 * decide which member Fin is allowed to answer about. Handing that identity to
 * an applicant -- who by definition holds no active membership, which is the
 * whole reason the /apply mint refuses them -- would put a non-member inside
 * the member identity chain and light up the help-centre audience flags
 * alongside it. The point here is the opposite: keep the contact anonymous,
 * and tell the agent who is on the other end.
 *
 * WHY CUSTOM ATTRIBUTES AND NOT `name`/`email`. Those are Intercom's own
 * identity fields, and identity verification (which this workspace enforces,
 * since every identified boot mints a JWT) rejects any request that carries
 * them without a valid hash. Sending them unsigned is not a weaker option, it
 * is a silently discarded one. Custom attributes are accepted on an anonymous
 * visitor and are what actually renders in the inbox sidebar.
 *
 * WHAT THIS EVIDENCE IS WORTH, stated plainly because the rest of this
 * directory is careful about exactly that. These values are handed to the
 * Messenger by the page, so they travel through the browser and are asserted
 * by it, not proven to Intercom the way a JWT claim is. A visitor who opens
 * devtools can call Intercom('update', ...) and overwrite them. That is
 * affordable here and nowhere else: a visitor has no external_id, so a forged
 * name resolves to nobody and grants no read of anyone's record -- every
 * identity gate in identity.ts fails closed on it exactly as it does today.
 * The realistic worst case is a human agent misled about a name, which is why
 * these keys say "Portal sign-in" rather than anything that reads as a
 * verified member attribute (contrast profile.ts, whose values ride a signed
 * JWT and can be trusted). Do NOT grow this into an authorization input.
 *
 * Absent values are OMITTED rather than sent empty, matching profile.ts: an
 * empty string would render as a blank field in the sidebar, which reads as
 * "we know this and it is nothing" instead of "we do not know this".
 */

/**
 * Keys are display names in the same sentence-case style as
 * HUB_AUDIENCE_ATTRIBUTES and buildProfileAttributes, and are the contract with
 * the Intercom workspace: renaming one here detaches whatever the workspace has
 * built on it. They contain spaces, so they cannot collide with Intercom's own
 * reserved boot keys (app_id, user_id, email, name), which is what keeps a
 * spread of this record into the boot arguments safe.
 */
export const VISITOR_NAME_ATTRIBUTE = "Portal sign-in name";
export const VISITOR_EMAIL_ATTRIBUTE = "Portal sign-in email";

export type VisitorIdentityInput = {
  /** Best-known display name: the stored Person name, else the first name from the sign-in. */
  name: string | null;
  /** The verified address the portal signed them in with. */
  email: string | null;
};

/**
 * Builds the attributes for an anonymous boot, or returns undefined when there
 * is nothing worth sending.
 *
 * Undefined rather than an empty object so a caller can omit the prop entirely
 * and a signed-out visitor's boot stays byte-for-byte what it is today.
 */
export function buildVisitorIdentityAttributes(
  input: VisitorIdentityInput
): Record<string, string> | undefined {
  const attrs: Record<string, string> = {};
  const name = input.name?.trim();
  const email = input.email?.trim();
  if (name) attrs[VISITOR_NAME_ATTRIBUTE] = name;
  if (email) attrs[VISITOR_EMAIL_ATTRIBUTE] = email;
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}
