import { log } from "@/platform/logging";
import { mintMessengerTokenForSession } from "@/platform/intercom/mint-token";

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
 * Minting is shared with the (app) layout's server render (see
 * ./mint-token), which is what removes the token round trip from the
 * launcher's critical path. This route remains the endpoint a long-lived tab
 * calls for a fresh token, instead of booting once with one that silently dies
 * mid-session.
 *
 * The person lookup is the revocation check -- an offboarded member must stop
 * getting tokens even while their hub JWT is still valid -- so a DB blip
 * degrades to 503 rather than resolving as "still active". Same contract as
 * /api/notifications.
 */
export async function GET(): Promise<Response> {
  const result = await mintMessengerTokenForSession();

  if (!result.ok) {
    switch (result.reason) {
      // Feature off looks like the route does not exist, rather than
      // advertising a half-configured integration.
      case "not_configured":
        return Response.json({ error: "Not Found" }, { status: 404 });
      case "unauthorized":
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      case "db_unreachable":
        log.warn("[intercom] database unreachable minting messenger token");
        return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
  }

  return Response.json(
    { token: result.token, expiresInSeconds: result.expiresInSeconds },
    // A bearer token must never sit in a shared or browser cache.
    { headers: { "Cache-Control": "no-store" } }
  );
}
