import { mintMessengerTokenForSession } from "@/modules/support/services/messenger-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mints the signed-in person's Intercom Messenger identity-verification JWT.
 *
 * Deliberately thin: every decision lives in mintMessengerTokenForSession (see
 * its doc comment for identity verification, the offboarding revocation check,
 * and the /apply membership rule), and this file only maps that result onto
 * HTTP. The (app) layout calls the same function during its server render, so a
 * first token and a refreshed token cannot drift apart in claims or TTL.
 *
 * Minting still needs an HTTP entry point even now that the layout can mint
 * directly: a long-lived tab needs somewhere to go for a fresh token, rather
 * than booting once with one that silently dies mid-session.
 *
 * `?requireActiveMembership=1` is the /apply portal's identity rule, enforced
 * server-side rather than by whichever page decided to ask. The flag can only
 * ADD that restriction on top of the checks in the mint, never remove any of
 * them, so a caller cannot use it to get an identified boot it would not
 * already be eligible for.
 */
export async function GET(request: Request): Promise<Response> {
  const requireActiveMembership =
    new URL(request.url).searchParams.get("requireActiveMembership") === "1";

  const result = await mintMessengerTokenForSession({ requireActiveMembership });

  if (!result.ok) {
    switch (result.reason) {
      case "not_configured":
        return Response.json({ error: "Not Found" }, { status: 404 });
      case "unauthorized":
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      case "membership_required":
        // Not a degraded state for the caller -- see IntercomMessenger's doc
        // comment -- so 403 rather than 401: the session and Person are both
        // fine, this specific boot just is not eligible for identity.
        return Response.json(
          { error: "Forbidden" },
          { status: 403, headers: { "Cache-Control": "no-store" } }
        );
      case "db_unreachable":
        // Same contract as /api/notifications: a DB blip degrades to 503 rather
        // than resolving as "still active". Logged by the mint.
        return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
  }

  return Response.json(
    { token: result.token, expiresInSeconds: result.expiresInSeconds },
    // A bearer token must never sit in a shared or browser cache.
    { headers: { "Cache-Control": "no-store" } }
  );
}
