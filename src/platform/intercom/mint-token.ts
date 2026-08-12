import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { isDbUnreachableError } from "@/platform/db";
import { isIntercomConfigured } from "@/platform/intercom/config";
import { mintIntercomUserJwt, INTERCOM_TOKEN_TTL_SECONDS } from "@/platform/intercom/jwt";
import { buildAudienceAttributes } from "@/platform/intercom/audience";

/**
 * Why a discriminated result rather than `string | null`: each refusal means
 * something specific, and both callers need to tell them apart.
 *
 *   not_configured  the integration is off, so the route 404s (looking absent
 *                   rather than half-configured) and the layout mints nothing
 *   unauthorized    no session, OR a session resolving to no active Person.
 *                   That second case IS the offboarding revocation check: an
 *                   offboarded member must stop getting tokens while their hub
 *                   JWT is still valid
 *   db_unreachable  we could not run the revocation check, so we refuse rather
 *                   than resolving as "still active"
 *
 * Collapsing these to null would force each caller to re-derive them, or to
 * skip them silently. Adding an outcome later (a membership gate, say) is a new
 * variant rather than a change to the existing ones.
 */
export type MintResult =
  | { ok: true; token: string; expiresInSeconds: number }
  | { ok: false; reason: "not_configured" | "unauthorized" | "db_unreachable" };

/**
 * Mints the signed-in person's Intercom identity-verification JWT.
 *
 * Every claim comes from the server session and the live Person row; nothing is
 * taken from a request body or query. Shared by the token route and the server
 * render of the (app) layout so a first token and a refreshed token can never
 * drift apart in claims or TTL.
 */
export async function mintMessengerTokenForSession(): Promise<MintResult> {
  if (!isIntercomConfigured()) return { ok: false, reason: "not_configured" };

  const session = await auth();
  if (!session?.personId) return { ok: false, reason: "unauthorized" };

  try {
    const person = await getActivePerson(session.personId);
    if (!person) return { ok: false, reason: "unauthorized" };

    // Audience flags ride on the token rather than being pushed to Intercom by
    // a separate sync job, so they are recomputed from live permissions on
    // every mint and cannot drift into a stale copy.
    const perms = await getEffectivePermissions(person.id);

    const token = await mintIntercomUserJwt({
      personId: person.id,
      name: person.name,
      email: person.contactEmail ?? null,
      audience: buildAudienceAttributes(perms),
    });

    return { ok: true, token, expiresInSeconds: INTERCOM_TOKEN_TTL_SECONDS };
  } catch (err) {
    if (isDbUnreachableError(err)) return { ok: false, reason: "db_unreachable" };
    throw err;
  }
}
