/**
 * Delegated OAuth helper for Microsoft Graph. Provides the token used for
 * Mail.Send (the Mailer) and Channel.ReadBasic.All (the clinic Teams channel
 * link) -- both ride the single SCOPES string and the one cached access token.
 *
 * Flow overview:
 *   1. Admin visits the consent URL built by buildAuthorizeUrl().
 *   2. After consent, Microsoft redirects with a one-time code; call exchangeCode().
 *   3. exchangeCode() POSTs the code to the token endpoint, receives an access token
 *      AND a refresh token, and persists the refresh token to the singleton
 *      MailCredential row (id "mailer").
 *   4. Every outbound send calls getAccessToken() which:
 *        a) returns the in-memory cached access token if it has not expired (minus a
 *           60-second safety window), OR
 *        b) redeems the stored refresh token for a new access token, persists the
 *           NEW refresh token returned by Entra ID (rotation -- Entra rotates the
 *           refresh token on every redemption), updates the in-memory cache, and
 *           returns the fresh access token.
 */

import { config } from "@/platform/config";
import { prisma } from "@/platform/db";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOPES =
  "openid profile email offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Send.Shared https://graph.microsoft.com/Channel.ReadBasic.All https://graph.microsoft.com/Chat.Create https://graph.microsoft.com/ChatMessage.Send";

function tokenEndpoint(): string {
  const tenant = config.GRAPH_OAUTH_TENANT_ID ?? "common";
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

function authorizeEndpoint(): string {
  const tenant = config.GRAPH_OAUTH_TENANT_ID ?? "common";
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`;
}

// ---------------------------------------------------------------------------
// MailNotConnectedError
// ---------------------------------------------------------------------------

export class MailNotConnectedError extends Error {
  constructor() {
    super(
      "Mail account is not connected. An admin must connect the mailbox in Admin > Email."
    );
    this.name = "MailNotConnectedError";
  }
}

// ---------------------------------------------------------------------------
// Module-level token cache
// ---------------------------------------------------------------------------

interface TokenCache {
  token: string;
  expiresAt: number; // ms epoch
}

let tokenCache: TokenCache | null = null;

/**
 * Clear the in-memory access-token cache. Exported for test isolation only.
 * Production code should never call this.
 */
export function __resetTokenCache(): void {
  tokenCache = null;
}

// ---------------------------------------------------------------------------
// buildAuthorizeUrl
// ---------------------------------------------------------------------------

/**
 * Build the Microsoft authorize URL for the one-time admin consent.
 * The admin visits this URL, signs in, and Microsoft redirects back with a
 * one-time code that exchangeCode() then redeems.
 */
export function buildAuthorizeUrl(opts: { state: string }): string {
  // Guard: a missing client id or tenant means the OAuth app is not configured;
  // throw so the connect action surfaces a clear error instead of redirecting
  // the admin to a malformed Microsoft URL.
  if (!config.GRAPH_OAUTH_CLIENT_ID || !config.GRAPH_OAUTH_TENANT_ID) {
    throw new Error("Mailer OAuth is not configured.");
  }
  const params = new URLSearchParams({
    client_id: config.GRAPH_OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: config.GRAPH_OAUTH_REDIRECT_URI,
    response_mode: "query",
    scope: SCOPES,
    state: opts.state,
  });
  return `${authorizeEndpoint()}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// extractAccount -- decode the id_token payload (no signature verification)
// ---------------------------------------------------------------------------

/**
 * Attempt to extract the user principal from the id_token JWT payload.
 * We trust the token endpoint response over TLS so signature verification is
 * not required here -- this value is only used as a human-readable label in
 * the admin UI.
 *
 * Returns null on any error (missing token, malformed base64, bad JSON, etc.).
 */
function extractAccount(idToken: string | undefined | null): string | null {
  if (!idToken) return null;
  try {
    const segments = idToken.split(".");
    if (segments.length < 2) return null;
    // The middle segment is the payload; base64url-decode it.
    const padded = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const claims = JSON.parse(json) as Record<string, unknown>;
    const account =
      (claims["preferred_username"] as string | undefined) ??
      (claims["email"] as string | undefined) ??
      (claims["upn"] as string | undefined) ??
      null;
    return account ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// exchangeCode
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for tokens and persist the refresh token.
 *
 * POSTs to the Microsoft token endpoint with grant_type=authorization_code.
 * The response includes an access token (discarded here -- getAccessToken will
 * fetch a fresh one via the refresh token), a refresh token (persisted), and
 * optionally an id_token (used to extract the account label).
 *
 * Upserts the singleton MailCredential row (id "mailer").
 */
export async function exchangeCode(
  code: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  // Invalidate any cached access token so the next getAccessToken redeems the
  // freshly connected credential rather than serving a stale token from a
  // previously connected (possibly different) account.
  tokenCache = null;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.GRAPH_OAUTH_CLIENT_ID ?? "",
    client_secret: config.GRAPH_OAUTH_CLIENT_SECRET ?? "",
    code,
    redirect_uri: config.GRAPH_OAUTH_REDIRECT_URI,
    scope: SCOPES,
  });

  const res = await fetchImpl(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `OAuth token exchange failed with status ${res.status}: ${text}`
    );
  }

  const json = (await res.json()) as {
    refresh_token: string;
    scope?: string;
    id_token?: string;
  };

  const account = extractAccount(json.id_token);

  await prisma.mailCredential.upsert({
    where: { id: "mailer" },
    create: {
      id: "mailer",
      refreshToken: json.refresh_token,
      account,
      scope: json.scope ?? null,
    },
    update: {
      refreshToken: json.refresh_token,
      account,
      scope: json.scope ?? null,
      // Refresh the connection timestamp so the admin UI shows the latest connect.
      connectedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// getAccessToken
// ---------------------------------------------------------------------------

/**
 * Return a valid access token, using the module-level cache when possible.
 *
 * Cache hit: returns immediately if the cached token has more than 60 seconds
 * of remaining lifetime.
 *
 * Cache miss (or expired): loads the MailCredential row, redeems the stored
 * refresh token via grant_type=refresh_token, persists the rotated refresh
 * token that Entra ID returns (Entra rotates on every redemption), updates
 * the cache, and returns the new access token.
 *
 * Throws MailNotConnectedError when no MailCredential row exists.
 */
export async function getAccessToken(
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  // Cache hit: return the cached token if it will not expire within 60 seconds.
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  // Load the credential row.
  const row = await prisma.mailCredential.findUnique({ where: { id: "mailer" } });
  if (!row) {
    throw new MailNotConnectedError();
  }

  // Redeem the refresh token.
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.GRAPH_OAUTH_CLIENT_ID ?? "",
    client_secret: config.GRAPH_OAUTH_CLIENT_SECRET ?? "",
    refresh_token: row.refreshToken,
    scope: SCOPES,
  });

  const res = await fetchImpl(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `OAuth refresh failed with status ${res.status}: ${text}`
    );
  }

  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  // Persist the rotated refresh token when Entra returns one.
  if (json.refresh_token) {
    await prisma.mailCredential.update({
      where: { id: "mailer" },
      data: { refreshToken: json.refresh_token },
    });
  }

  // Update the module-level cache. The safety window (60 s) is subtracted so
  // we never hand out a token that is about to expire.
  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };

  return json.access_token;
}

// ---------------------------------------------------------------------------
// mailConnectionStatus
// ---------------------------------------------------------------------------

/**
 * Return the current mail connection status for the admin UI.
 */
export async function mailConnectionStatus(): Promise<{
  connected: boolean;
  account: string | null;
  connectedAt: Date | null;
}> {
  const row = await prisma.mailCredential.findUnique({ where: { id: "mailer" } });
  return {
    connected: row != null,
    account: row?.account ?? null,
    connectedAt: row?.connectedAt ?? null,
  };
}

/**
 * True when the stored credential scope string already includes both Teams chat
 * scopes. Used by the admin UI to prompt for a reconnect after the scopes grew.
 */
export function teamsScopesGranted(scope: string | null): boolean {
  if (!scope) return false;
  return scope.includes("Chat.Create") && scope.includes("ChatMessage.Send");
}
