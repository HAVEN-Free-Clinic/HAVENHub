import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { verifyPkceS256 } from "./pkce";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_CODE_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "./config";

/**
 * Token lifecycle for the Hub's OAuth server: authorization codes, access
 * tokens, and rotating refresh tokens, all hanging off one OAuthConnection.
 *
 * Every token is 32 random bytes, handed to the client once and stored only
 * as its SHA-256. A database read therefore yields nothing that can be
 * presented as a credential, the same reasoning MemberLoginToken follows.
 */

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function secondsFromNow(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

/** RFC 6749 section 5.2 error codes this server returns. Claude relies on invalid_grant specifically. */
export type TokenError = { error: "invalid_grant" | "invalid_request" | "invalid_client"; description: string };

/**
 * How long after a refresh token is used a second presentation is treated as
 * a benign race rather than theft.
 *
 * Claude refreshes proactively before expiry AND reactively on a 401, so two
 * refreshes with the same token a moment apart is an ordinary thing for it to
 * do. Treating that as a replay would revoke the person's connection for no
 * reason. Inside the window the late request simply fails (the winner already
 * holds the rotated pair); outside it, a replay revokes the whole connection,
 * which is OAuth 2.1's defense against a stolen refresh token.
 */
const REFRESH_REPLAY_GRACE_MS = 60_000;

/** lastUsedAt is written at most this often per connection. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/**
 * Record a person's consent and issue its authorization code.
 *
 * A fresh consent for the same person, client, and resource replaces the old
 * one: prior live connections are revoked in the same transaction, so a person
 * who reconnects never has two sets of tokens alive for one connector.
 */
export async function createAuthorization(input: {
  personId: string;
  clientId: string;
  clientName?: string | null;
  resource: string;
  scope: string;
  redirectUri: string;
  codeChallenge: string;
  now?: Date;
}): Promise<{ code: string; connectionId: string }> {
  const now = input.now ?? new Date();
  const code = newToken();
  const connection = await prisma.$transaction(async (tx) => {
    await tx.oAuthConnection.updateMany({
      where: { personId: input.personId, clientId: input.clientId, resource: input.resource, revokedAt: null },
      data: { revokedAt: now },
    });
    return tx.oAuthConnection.create({
      data: {
        personId: input.personId,
        clientId: input.clientId,
        clientName: input.clientName ?? null,
        resource: input.resource,
        scope: input.scope,
        tokens: {
          create: {
            kind: "AUTH_CODE",
            tokenHash: hashToken(code),
            expiresAt: secondsFromNow(now, AUTH_CODE_TTL_SECONDS),
            codeChallenge: input.codeChallenge,
            redirectUri: input.redirectUri,
          },
        },
      },
    });
  });
  await recordAudit({
    actorPersonId: input.personId,
    action: "oauth.connection_created",
    entityType: "OAuthConnection",
    entityId: connection.id,
    after: { clientId: input.clientId, resource: input.resource, scope: input.scope },
  });
  return { code, connectionId: connection.id };
}

async function issueTokenPair(connectionId: string, scope: string, now: Date): Promise<TokenResponse> {
  const access = newToken();
  const refresh = newToken();
  await prisma.oAuthToken.createMany({
    data: [
      { connectionId, kind: "ACCESS", tokenHash: hashToken(access), expiresAt: secondsFromNow(now, ACCESS_TOKEN_TTL_SECONDS) },
      { connectionId, kind: "REFRESH", tokenHash: hashToken(refresh), expiresAt: secondsFromNow(now, REFRESH_TOKEN_TTL_SECONDS) },
    ],
  });
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    scope,
  };
}

/**
 * Mark a single-use token spent, atomically. Returns false if another request
 * spent it first -- the conditional updateMany is the lock, so two concurrent
 * exchanges of one code can never both succeed.
 */
async function spend(tokenId: string, now: Date): Promise<boolean> {
  const { count } = await prisma.oAuthToken.updateMany({
    where: { id: tokenId, usedAt: null },
    data: { usedAt: now },
  });
  return count === 1;
}

/**
 * The authorization_code grant. Every check the MCP authorization spec asks
 * of a public client: the code exists, is unexpired and unspent, belongs to
 * this client, was issued for this exact redirect_uri, and the PKCE verifier
 * matches its challenge. When the client names a resource (RFC 8707), it must
 * be the one consented to.
 *
 * A code presented a second time is treated as intercepted: the connection it
 * belongs to is revoked, taking with it any tokens the first exchange issued
 * (RFC 6749 section 4.1.2).
 */
export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string | null;
  now?: Date;
}): Promise<TokenResponse | TokenError> {
  const now = input.now ?? new Date();
  const row = await prisma.oAuthToken.findUnique({
    where: { tokenHash: hashToken(input.code) },
    include: { connection: true },
  });
  if (!row || row.kind !== "AUTH_CODE") return { error: "invalid_grant", description: "Unknown authorization code." };

  if (row.usedAt) {
    await revokeConnection(row.connectionId, null, "authorization code replayed", now);
    return { error: "invalid_grant", description: "Authorization code already used." };
  }
  const c = row.connection;
  if (row.expiresAt <= now || c.revokedAt) return { error: "invalid_grant", description: "Authorization code expired." };
  if (c.clientId !== input.clientId) return { error: "invalid_grant", description: "Code was issued to a different client." };
  if (row.redirectUri !== input.redirectUri) return { error: "invalid_grant", description: "redirect_uri does not match." };
  if (!row.codeChallenge || !verifyPkceS256(input.codeVerifier, row.codeChallenge)) {
    return { error: "invalid_grant", description: "PKCE verification failed." };
  }
  if (input.resource && input.resource !== c.resource) {
    return { error: "invalid_grant", description: "resource does not match the authorization." };
  }
  if (!(await spend(row.id, now))) return { error: "invalid_grant", description: "Authorization code already used." };

  return issueTokenPair(c.id, c.scope, now);
}

/** The refresh_token grant, with rotation: the presented token is spent and a new pair issued. */
export async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
  resource?: string | null;
  now?: Date;
}): Promise<TokenResponse | TokenError> {
  const now = input.now ?? new Date();
  const row = await prisma.oAuthToken.findUnique({
    where: { tokenHash: hashToken(input.refreshToken) },
    include: { connection: true },
  });
  if (!row || row.kind !== "REFRESH") return { error: "invalid_grant", description: "Unknown refresh token." };

  if (row.usedAt) {
    if (now.getTime() - row.usedAt.getTime() > REFRESH_REPLAY_GRACE_MS) {
      await revokeConnection(row.connectionId, null, "refresh token replayed", now);
    }
    return { error: "invalid_grant", description: "Refresh token already used." };
  }
  const c = row.connection;
  if (row.expiresAt <= now || c.revokedAt) return { error: "invalid_grant", description: "Refresh token expired or revoked." };
  if (c.clientId !== input.clientId) return { error: "invalid_grant", description: "Token was issued to a different client." };
  if (input.resource && input.resource !== c.resource) {
    return { error: "invalid_grant", description: "resource does not match the authorization." };
  }
  if (!(await spend(row.id, now))) return { error: "invalid_grant", description: "Refresh token already used." };

  return issueTokenPair(c.id, c.scope, now);
}

export type VerifiedAccess = { personId: string; connectionId: string; scope: string };

/**
 * Resolve a presented access token to the person it acts as, or null.
 *
 * `resource` is the URL of the endpoint being called. A token is honored only
 * on the resource it was consented for (the audience check the MCP spec
 * requires), so a recruitment token cannot be replayed against some future
 * second MCP endpoint, and a token issued on one deployment's origin is not
 * honored on another's even though they share a database.
 */
export async function verifyAccessToken(raw: string, resource: string, now: Date = new Date()): Promise<VerifiedAccess | null> {
  if (!raw) return null;
  const row = await prisma.oAuthToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { connection: true },
  });
  if (!row || row.kind !== "ACCESS" || row.expiresAt <= now) return null;
  const c = row.connection;
  if (c.revokedAt || c.resource !== resource) return null;

  if (!c.lastUsedAt || now.getTime() - c.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    await prisma.oAuthConnection.update({ where: { id: c.id }, data: { lastUsedAt: now } });
  }
  return { personId: c.personId, connectionId: c.id, scope: c.scope };
}

/**
 * Revoke a connection and, by extension, every token issued under it: the
 * token checks above all refuse a token whose connection is revoked, so there
 * is nothing to delete. Idempotent; revoking an already-revoked connection
 * leaves its original revokedAt and revoker in place.
 *
 * `actorId` is null for automatic revocations (a replayed code or refresh
 * token), which is why the reason travels into the audit row.
 */
export async function revokeConnection(
  connectionId: string,
  actorId: string | null,
  reason: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await prisma.oAuthConnection.updateMany({
    where: { id: connectionId, revokedAt: null },
    data: { revokedAt: now, revokedById: actorId },
  });
  if (count === 1) {
    await recordAudit({
      actorPersonId: actorId,
      action: "oauth.connection_revoked",
      entityType: "OAuthConnection",
      entityId: connectionId,
      after: { reason },
    });
  }
  return count === 1;
}
