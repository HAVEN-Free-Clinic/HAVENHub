/**
 * Delegated OAuth helper for Microsoft Graph. Provides the token used for
 * Mail.Send (the Mailer) and Channel.ReadBasic.All (the clinic Teams channel
 * link) -- both ride the one scope request and the one cached access token.
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

/**
 * What the mailer cannot work without: sign-in, a refresh token, and the two
 * send scopes (Shared because we send AS the shared mailbox, not as the signed-in
 * service account).
 */
const MAIL_SCOPES =
  "openid profile email offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Send.Shared";

/** The clinic Teams channel link, the triage group chats, and Teams DMs. */
const TEAMS_SCOPES =
  "https://graph.microsoft.com/Channel.ReadBasic.All https://graph.microsoft.com/Chat.Create https://graph.microsoft.com/ChatMessage.Send";

/**
 * Read per call rather than frozen into a module constant: GRAPH_OAUTH_MAIL_ONLY
 * decides it, and the whole point of that flag is to be flipped between two app
 * registrations without a code change.
 */
function scopes(): string {
  return config.GRAPH_OAUTH_MAIL_ONLY ? MAIL_SCOPES : `${MAIL_SCOPES} ${TEAMS_SCOPES}`;
}

function tokenEndpoint(): string {
  const tenant = config.GRAPH_OAUTH_TENANT_ID ?? "common";
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

function authorizeEndpoint(): string {
  const tenant = config.GRAPH_OAUTH_TENANT_ID ?? "common";
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`;
}

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
    scope: scopes(),
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
    scope: scopes(),
  });

  const res = await fetchImpl(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    // Bound the Entra token request so a hung endpoint can't block the caller/drain
    // up to the function limit.
    signal: AbortSignal.timeout(8000),
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
    scope: scopes(),
  });

  const res = await fetchImpl(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    // Bound the Entra token request so a hung endpoint can't block the caller/drain
    // up to the function limit.
    signal: AbortSignal.timeout(8000),
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

  // Persist the rotated refresh token when Entra returns one -- but only while the
  // token we redeemed is still the stored one (optimistic concurrency). A concurrent
  // refresh may have already rotated it; unconditionally overwriting could persist a
  // superseded token over a newer one and brick the mailer. If our redeemed token is
  // stale, another refresh won the race, so leave its newer token in place.
  if (json.refresh_token) {
    await prisma.mailCredential.updateMany({
      where: { id: "mailer", refreshToken: row.refreshToken },
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

/**
 * Return the current mail connection status for the admin UI.
 */
export async function mailConnectionStatus(): Promise<{
  connected: boolean;
  healthy: boolean;
  account: string | null;
  connectedAt: Date | null;
}> {
  const row = await prisma.mailCredential.findUnique({ where: { id: "mailer" } });
  if (!row) return { connected: false, healthy: false, account: null, connectedAt: null };
  // A stored credential is NOT proof the token still works: consent revocation, a
  // password reset, or ~90-day inactivity all silently break a delegated refresh
  // token. Probe it -- a cache hit is free, and a real refresh only fires when the
  // cached token is near expiry, which is exactly when a broken token surfaces. Report
  // healthy:false so the admin UI can prompt a reconnect instead of showing a green
  // "Connected" over a dead mailer that is failing every send.
  let healthy = true;
  try {
    await getAccessToken();
  } catch {
    healthy = false;
  }
  return { connected: true, healthy, account: row.account, connectedAt: row.connectedAt };
}

/**
 * The singleton MailCredential, as the two facts ROUTING needs from it: whether
 * an admin has connected a Graph mailbox at all, and which address that is.
 *
 * Separate from mailConnectionStatus above, which probes the token to answer the
 * admin panel's "is this connection healthy". Routing must not probe: it runs
 * once per drain tick and a network round trip to Entra to decide which
 * transport carries a message would be a cost with no answer attached, since a
 * dead token is GraphTransport's problem to report per message.
 *
 * One read for both facts. They were two questions until the connected mailbox
 * became Graph-routed implicitly (it is the one address Graph can always send
 * as, on any deployment), and asking them separately would double a per-drain
 * query for no gain.
 */
export async function connectedGraphMailbox(): Promise<{
  connected: boolean;
  account: string | null;
}> {
  try {
    const row = await prisma.mailCredential.findUnique({
      where: { id: "mailer" },
      select: { account: true },
    });
    return { connected: row !== null, account: row?.account ?? null };
  } catch {
    // A brief database problem must NOT be read as "not connected": that would
    // refuse every Graph-routed send for the whole tick on the strength of one
    // failed read. Assume connected and let GraphTransport produce the real
    // per-message error, which is the direction every other degraded read in the
    // send path already takes.
    //
    // The ACCOUNT degrades the other way, to null, because there is nothing safe
    // to invent: the implicit mailbox rule then simply does not fire, and the
    // mailbox's own mail routes by GRAPH_SENDER_ADDRESSES and SENDING_DOMAINS
    // like every other address. Guessing an address here would route mail to
    // Graph on the strength of a failed read.
    return { connected: true, account: null };
  }
}

/**
 * True when the stored credential scope string already includes every Teams
 * scope the app needs. Used by the admin UI to prompt for a reconnect after the
 * scopes grew.
 */
export function teamsScopesGranted(scope: string | null): boolean {
  if (!scope) return false;
  return (
    scope.includes("Chat.Create") &&
    scope.includes("ChatMessage.Send")
  );
}

/**
 * True when the stored credential scope string includes the Channel.ReadBasic.All
 * scope the clinic channel-link resolver needs. The granted scope is fixed at
 * consent, so a mailbox connected before the scope was added, or under a mail-only
 * app registration, never carries it, and every Graph channels call 403s until an
 * admin reconnects.
 */
export function channelReadScopeGranted(scope: string | null): boolean {
  return scope != null && scope.includes("Channel.ReadBasic.All");
}

/** The scope string the connected mailbox was granted, or null when the mailbox
 *  is not connected (or the grant predates scope recording). */
export async function loadGrantedScope(): Promise<string | null> {
  const row = await prisma.mailCredential.findUnique({ where: { id: "mailer" } });
  return row?.scope ?? null;
}
