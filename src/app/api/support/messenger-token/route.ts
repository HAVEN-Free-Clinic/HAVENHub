import { auth } from "@/platform/auth/auth";
import { isDbUnreachableError } from "@/platform/db";
import { getActivePerson } from "@/platform/auth/match-person";
import { log, errorAttrs } from "@/platform/logging";
import { isIntercomConfigured } from "@/platform/intercom/config";
import { mintIntercomUserJwt, INTERCOM_TOKEN_TTL_SECONDS } from "@/platform/intercom/jwt";
import { buildAudienceAttributes } from "@/platform/intercom/audience";
import { getEffectivePermissions } from "@/platform/rbac/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mints the signed-in person's Intercom Messenger identity-verification JWT.
 *
 * Identity verification is the entire point of this route. Without it the
 * Messenger boots on browser-supplied attributes, so anyone could open devtools
 * and open a support conversation as another member. Every claim here is taken
 * from the server session and the live Person row; nothing comes from the
 * request body or query.
 *
 * Minting lives in a route handler rather than the (app) layout for two
 * reasons. Stamping `exp` needs the wall clock, which the lint purity rule
 * keeps out of render. And a long-lived tab needs somewhere to go for a fresh
 * token, instead of booting once with one that silently dies mid-session.
 *
 * The person lookup is the revocation check -- an offboarded member must stop
 * getting tokens even while their hub JWT is still valid -- so a DB blip
 * degrades to 503 rather than resolving as "still active". Same contract as
 * /api/notifications.
 */
export async function GET(): Promise<Response> {
  // Feature off (either env var unset) looks like the route does not exist,
  // rather than advertising a half-configured integration.
  if (!isIntercomConfigured()) {
    return Response.json({ error: "Not Found" }, { status: 404 });
  }

  const session = await auth();
  if (!session?.personId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const person = await getActivePerson(session.personId);
    if (!person) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Audience flags ride on the token rather than being pushed to Intercom by a
    // separate sync job, so they are recomputed from live permissions on every
    // Messenger boot and cannot drift into a stale copy.
    const perms = await getEffectivePermissions(person.id);

    const token = await mintIntercomUserJwt({
      personId: person.id,
      name: person.name,
      email: person.contactEmail ?? null,
      audience: buildAudienceAttributes(perms),
    });

    return Response.json(
      { token, expiresInSeconds: INTERCOM_TOKEN_TTL_SECONDS },
      // A bearer token must never sit in a shared or browser cache.
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    if (isDbUnreachableError(err)) {
      log.warn("[intercom] database unreachable minting messenger token", errorAttrs(err));
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    throw err;
  }
}
