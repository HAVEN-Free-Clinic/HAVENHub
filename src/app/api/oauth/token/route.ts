import { authenticateTokenClient } from "@/platform/oauth/registration";
import { exchangeAuthorizationCode, refreshAccessToken, type TokenError } from "@/platform/oauth/tokens";
import { log, errorAttrs } from "@/platform/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Token responses carry credentials, so no cache anywhere may keep one
 * (RFC 6749 section 5.1).
 */
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

function errorResponse(e: TokenError): Response {
  // invalid_client is 401 per RFC 6749 section 5.2; everything else is 400.
  return Response.json(
    { error: e.error, error_description: e.description },
    { status: e.error === "invalid_client" ? 401 : 400, headers: NO_STORE },
  );
}

/**
 * The OAuth token endpoint: authorization_code (always with PKCE) and
 * refresh_token grants.
 *
 * Reads application/x-www-form-urlencoded, which is what every client sends for
 * both grants (RFC 6749 section 4.1.3). Public clients (a metadata-document
 * client, or one registered with "none") are identified by client_id alone and
 * proven by PKCE; a registered confidential client must also present its
 * secret. Either way the code and tokens are bound to that client_id.
 */
export async function POST(request: Request): Promise<Response> {
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    return errorResponse({ error: "invalid_request", description: "Malformed body." });
  }

  try {
    const client = await authenticateTokenClient(form, request.headers.get("authorization"));
    if ("error" in client) return errorResponse(client);
    const { clientId } = client;

    const grantType = form.get("grant_type");
    let result;
    if (grantType === "authorization_code") {
      const code = form.get("code");
      const redirectUri = form.get("redirect_uri");
      const codeVerifier = form.get("code_verifier");
      if (!code || !redirectUri || !codeVerifier) {
        return errorResponse({ error: "invalid_request", description: "code, redirect_uri and code_verifier are required." });
      }
      result = await exchangeAuthorizationCode({ code, clientId, redirectUri, codeVerifier, resource: form.get("resource") });
    } else if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token");
      if (!refreshToken) return errorResponse({ error: "invalid_request", description: "refresh_token is required." });
      result = await refreshAccessToken({ refreshToken, clientId, resource: form.get("resource") });
    } else {
      return Response.json(
        { error: "unsupported_grant_type", error_description: "Only authorization_code and refresh_token are supported." },
        { status: 400, headers: NO_STORE },
      );
    }

    if ("error" in result) return errorResponse(result);
    return Response.json(result, { headers: NO_STORE });
  } catch (err) {
    // Never echo the error: during a database outage its message names the
    // database host (see db-unreachable-degradation).
    log.error("[oauth] token endpoint failed", errorAttrs(err));
    return Response.json({ error: "server_error" }, { status: 500, headers: NO_STORE });
  }
}
