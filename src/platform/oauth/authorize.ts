import { redirectUriAllowed, resolveClient, type ResolvedClient } from "./client";
import { isValidChallenge } from "./pkce";
import { MCP_RESOURCES, resourceUrl, type McpResource } from "./config";

/** The authorization request as it arrives on /oauth/authorize (and again, as hidden fields, on consent). */
export type AuthorizeParams = {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  state?: string | null;
  scope?: string | null;
  resource?: string | null;
};

export type ValidAuthorizeRequest = {
  kind: "ok";
  client: ResolvedClient;
  /** Where the authorization code (and so the access) goes: the one host a person can check. */
  redirectHost: string;
  resource: McpResource;
  resourceUrl: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
};

export type AuthorizeOutcome =
  | ValidAuthorizeRequest
  /** The client or redirect cannot be trusted: show an error page, never redirect (RFC 6749 section 4.1.2.1). */
  | { kind: "fatal"; message: string }
  /** The client and redirect are verified, the rest of the request is not: report back to the client. */
  | { kind: "redirect_error"; redirectUri: string; error: string; description: string; state: string | null };

/**
 * Validate an authorization request, in the order that decides WHERE an error
 * may be reported.
 *
 * The client and its redirect_uri are checked first, and a failure there is
 * fatal: redirecting to an unverified URI with an error is how an open
 * redirector is built. Everything after that (response type, PKCE, scope,
 * resource) is reported back to the now-verified redirect_uri, which is what
 * lets Claude show the person a useful error instead of a dead tab.
 *
 * Run by the consent page AND again by the consent action, so the action never
 * trusts the hidden fields it posts back.
 */
export async function validateAuthorizeRequest(params: AuthorizeParams, origin: string): Promise<AuthorizeOutcome> {
  const client = await resolveClient(params.client_id ?? "");
  if (!client) {
    return { kind: "fatal", message: "The connecting app could not be verified. Try connecting again." };
  }
  const redirectUri = params.redirect_uri ?? "";
  if (!redirectUri || !redirectUriAllowed(redirectUri, client.redirectUris)) {
    return { kind: "fatal", message: "The connecting app sent an invalid return address." };
  }

  const state = params.state ?? null;
  const fail = (error: string, description: string): AuthorizeOutcome => ({
    kind: "redirect_error",
    redirectUri,
    error,
    description,
    state,
  });

  if (params.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (params.code_challenge_method !== "S256" || !params.code_challenge || !isValidChallenge(params.code_challenge)) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }

  // The resource the client is asking for (RFC 8707). Claude sends it; if a
  // client omits it, a requested scope can still name exactly one resource.
  const resource = params.resource
    ? MCP_RESOURCES.find((r) => resourceUrl(origin, r) === params.resource)
    : MCP_RESOURCES.find((r) => (params.scope ?? "").split(" ").includes(r.scope));
  if (!resource) return fail("invalid_target", "Unknown resource.");

  // Scopes are informational here -- one resource has one scope -- but a
  // request for a scope this resource does not have is refused rather than
  // silently narrowed, so a client never believes it holds something it does not.
  const requested = (params.scope ?? "").split(" ").filter(Boolean);
  if (requested.some((s) => s !== resource.scope && s !== "offline_access")) {
    return fail("invalid_scope", `This resource only supports the ${resource.scope} scope.`);
  }

  return {
    kind: "ok",
    client,
    redirectHost: redirectHostOf(redirectUri),
    resource,
    resourceUrl: resourceUrl(origin, resource),
    redirectUri,
    codeChallenge: params.code_challenge,
    state,
  };
}

/**
 * The redirect back to the client. Always carries `iss` (RFC 9207) so the
 * client can confirm which authorization server answered, and echoes `state`.
 */
export function clientRedirect(redirectUri: string, params: Record<string, string | null>, issuer: string): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  url.searchParams.set("iss", issuer);
  return url.toString();
}

/** A redirect's host for display; a native app scheme has none, so show the scheme. */
function redirectHostOf(uri: string): string {
  const url = new URL(uri);
  return url.host || `${url.protocol}//`;
}
