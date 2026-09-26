import { clientIpForRateLimit } from "@/platform/auth/client-ip";
import { registerClient } from "@/platform/oauth/registration";
import { log, errorAttrs } from "@/platform/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dynamic client registration (RFC 7591): how an MCP client the Hub has never
 * seen introduces itself before sending a person to /oauth/authorize.
 *
 * Unauthenticated by design -- that is what the protocol is -- and harmless by
 * construction: a registration grants nothing until a person signs in and
 * approves it. See registerClient for the rate limits and cleanup that keep
 * an open endpoint from becoming a way to fill the database.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_client_metadata", error_description: "Body must be JSON." }, { status: 400 });
  }
  try {
    const result = await registerClient(body, clientIpForRateLimit(request.headers));
    if ("error" in result) {
      return Response.json(
        { error: result.error === "rate_limited" ? "temporarily_unavailable" : result.error, error_description: result.description },
        { status: result.error === "rate_limited" ? 429 : 400 },
      );
    }
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    log.error("[oauth] client registration failed", errorAttrs(err));
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
