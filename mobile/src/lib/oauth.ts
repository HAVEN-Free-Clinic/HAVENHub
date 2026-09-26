import { MOBILE_RESOURCE, REGISTER_URL, TOKEN_URL } from "./config";

/**
 * The token half of the Hub's OAuth flow, as plain fetch calls.
 *
 * The browser half (PKCE, the consent screen, the redirect back into the app)
 * is expo-auth-session's AuthRequest; see auth.tsx. Everything here talks to
 * the same endpoints the Claude connector uses: src/app/api/oauth in the web app.
 */

export type Tokens = {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
};

/** The Hub no longer honors this sign-in (revoked, expired, or the person was offboarded). */
export class SessionExpiredError extends Error {
  constructor(message = "Your session has ended. Sign in again.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/** The Hub could not be reached or answered with something other than JSON (e.g. a firewall page). */
export class NetworkError extends Error {
  constructor(message = "Can't reach the HAVEN Hub. Check your connection and try again.") {
    super(message);
    this.name = "NetworkError";
  }
}

async function postForm(url: string, body: Record<string, string>): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(body).toString(),
    });
  } catch {
    throw new NetworkError();
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new NetworkError();
  }
}

/**
 * Register this install as a public OAuth client (RFC 7591) for one redirect
 * URI. Registration grants nothing by itself; the person still signs in and
 * approves the app on the Hub's consent screen.
 */
export async function registerClient(redirectUri: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "HAVEN Hub mobile app",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
  } catch {
    throw new NetworkError();
  }
  const body = await readJson(res);
  if (!res.ok || typeof body.client_id !== "string") {
    throw new Error(
      typeof body.error_description === "string" ? body.error_description : "The Hub would not register this app.",
    );
  }
  return body.client_id;
}

async function tokenRequest(params: Record<string, string>, now: number): Promise<Tokens> {
  const res = await postForm(TOKEN_URL, { ...params, resource: MOBILE_RESOURCE });
  const body = await readJson(res);
  if (!res.ok) {
    // invalid_grant: the code or refresh token is spent, expired, or revoked.
    // invalid_client: the registration is gone. Either way, only signing in fixes it.
    if (body.error === "invalid_grant" || body.error === "invalid_client") throw new SessionExpiredError();
    throw new NetworkError("The Hub had a problem signing you in. Try again in a minute.");
  }
  const { access_token, refresh_token, expires_in } = body;
  if (typeof access_token !== "string" || typeof refresh_token !== "string") {
    throw new NetworkError("The Hub sent an unexpected sign-in response.");
  }
  const lifetime = typeof expires_in === "number" ? expires_in : 3600;
  return { accessToken: access_token, refreshToken: refresh_token, expiresAt: now + lifetime * 1000 };
}

export function exchangeCode(
  input: { clientId: string; code: string; redirectUri: string; codeVerifier: string },
  now: number = Date.now(),
): Promise<Tokens> {
  return tokenRequest(
    {
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    },
    now,
  );
}

/** Refresh tokens rotate on every use: always store the pair this returns. */
export function refreshTokens(input: { clientId: string; refreshToken: string }, now: number = Date.now()): Promise<Tokens> {
  return tokenRequest({ grant_type: "refresh_token", client_id: input.clientId, refresh_token: input.refreshToken }, now);
}

/** Refresh a minute early, so a token never expires between the check and the request. */
export function needsRefresh(tokens: Tokens, now: number = Date.now()): boolean {
  return tokens.expiresAt - now < 60_000;
}
