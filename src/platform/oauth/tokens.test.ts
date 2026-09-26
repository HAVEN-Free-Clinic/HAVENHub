import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createAuthorization,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeConnection,
  verifyAccessToken,
  type TokenResponse,
} from "./tokens";

const CLIENT = "https://claude.ai/oauth/claude-code-client-metadata";
const REDIRECT = "http://localhost:4242/callback";
const RESOURCE = "https://hub.test/api/mcp/recruitment";
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

beforeEach(resetDb);

async function authorize(now = new Date()) {
  const person = await prisma.person.create({ data: { name: "Robin Recruiter" } });
  const { code, connectionId } = await createAuthorization({
    personId: person.id,
    clientId: CLIENT,
    resource: RESOURCE,
    scope: "recruitment:read",
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    now,
  });
  return { person, code, connectionId };
}

async function exchange(code: string, overrides: Partial<Parameters<typeof exchangeAuthorizationCode>[0]> = {}) {
  return exchangeAuthorizationCode({ code, clientId: CLIENT, redirectUri: REDIRECT, codeVerifier: VERIFIER, ...overrides });
}

function tokens(r: unknown): TokenResponse {
  expect(r).toHaveProperty("access_token");
  return r as TokenResponse;
}

describe("authorization code exchange", () => {
  it("issues an access and refresh token that act as the consenting person on the consented resource", async () => {
    const { person, code, connectionId } = await authorize();
    const t = tokens(await exchange(code, { resource: RESOURCE }));

    expect(t.token_type).toBe("Bearer");
    expect(t.scope).toBe("recruitment:read");
    expect(await verifyAccessToken(t.access_token, RESOURCE)).toMatchObject({ personId: person.id, connectionId });
  });

  it("stores only hashes, never a presentable token", async () => {
    const { code } = await authorize();
    const t = tokens(await exchange(code));
    const stored = await prisma.oAuthToken.findMany({ select: { tokenHash: true } });
    for (const raw of [code, t.access_token, t.refresh_token]) {
      expect(stored.some((s) => s.tokenHash === raw)).toBe(false);
    }
  });

  it.each([
    ["a wrong PKCE verifier", { codeVerifier: "w".repeat(64) }],
    ["a different redirect_uri", { redirectUri: "http://localhost:4242/other" }],
    ["a different client", { clientId: "https://claude.ai/other-client" }],
    ["a different resource", { resource: "https://hub.test/api/mcp/other" }],
  ])("refuses %s with invalid_grant", async (_label, overrides) => {
    const { code } = await authorize();
    expect(await exchange(code, overrides)).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses an expired code", async () => {
    const { code } = await authorize(new Date(Date.now() - 10 * 60_000));
    expect(await exchange(code)).toMatchObject({ error: "invalid_grant" });
  });

  it("treats a replayed code as intercepted and revokes what the first exchange issued", async () => {
    const { code, connectionId } = await authorize();
    const first = tokens(await exchange(code));

    expect(await exchange(code)).toMatchObject({ error: "invalid_grant" });
    expect(await verifyAccessToken(first.access_token, RESOURCE)).toBeNull();
    expect((await prisma.oAuthConnection.findUniqueOrThrow({ where: { id: connectionId } })).revokedAt).not.toBeNull();
  });

  it("lets only one of two concurrent exchanges of the same code succeed", async () => {
    const { code } = await authorize();
    const results = await Promise.all([exchange(code), exchange(code)]);
    expect(results.filter((r) => "access_token" in r)).toHaveLength(1);
  });
});

describe("refresh", () => {
  it("rotates: the new pair works and the old refresh token is spent", async () => {
    const { code } = await authorize();
    const first = tokens(await exchange(code));
    const second = tokens(await refreshAccessToken({ refreshToken: first.refresh_token, clientId: CLIENT }));

    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await verifyAccessToken(second.access_token, RESOURCE)).not.toBeNull();
    expect(await refreshAccessToken({ refreshToken: first.refresh_token, clientId: CLIENT })).toMatchObject({ error: "invalid_grant" });
  });

  it("does not revoke the connection over a near-simultaneous double refresh (Claude's proactive + reactive refresh)", async () => {
    const { code, connectionId } = await authorize();
    const first = tokens(await exchange(code));
    const second = tokens(await refreshAccessToken({ refreshToken: first.refresh_token, clientId: CLIENT }));

    await refreshAccessToken({ refreshToken: first.refresh_token, clientId: CLIENT });

    expect((await prisma.oAuthConnection.findUniqueOrThrow({ where: { id: connectionId } })).revokedAt).toBeNull();
    expect(await verifyAccessToken(second.access_token, RESOURCE)).not.toBeNull();
  });

  it("revokes the whole connection when a spent refresh token comes back later (theft)", async () => {
    const { code, connectionId } = await authorize();
    const first = tokens(await exchange(code));
    const second = tokens(await refreshAccessToken({ refreshToken: first.refresh_token, clientId: CLIENT }));

    const later = new Date(Date.now() + 5 * 60_000);
    expect(await refreshAccessToken({ refreshToken: first.refresh_token, clientId: CLIENT, now: later })).toMatchObject({
      error: "invalid_grant",
    });
    expect((await prisma.oAuthConnection.findUniqueOrThrow({ where: { id: connectionId } })).revokedAt).not.toBeNull();
    expect(await verifyAccessToken(second.access_token, RESOURCE)).toBeNull();
  });

  it("refuses a refresh token presented by a different client", async () => {
    const { code } = await authorize();
    const first = tokens(await exchange(code));
    expect(await refreshAccessToken({ refreshToken: first.refresh_token, clientId: "https://claude.ai/other" })).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("refuses an access token presented as a refresh token", async () => {
    const { code } = await authorize();
    const first = tokens(await exchange(code));
    expect(await refreshAccessToken({ refreshToken: first.access_token, clientId: CLIENT })).toMatchObject({ error: "invalid_grant" });
  });
});

describe("verifyAccessToken", () => {
  it("honors a token only on the resource it was consented for", async () => {
    const { code } = await authorize();
    const t = tokens(await exchange(code));
    expect(await verifyAccessToken(t.access_token, "https://preview.hub.test/api/mcp/recruitment")).toBeNull();
  });

  it("refuses an expired access token", async () => {
    const { code } = await authorize();
    const t = tokens(await exchange(code));
    expect(await verifyAccessToken(t.access_token, RESOURCE, new Date(Date.now() + 2 * 60 * 60_000))).toBeNull();
  });

  it("refuses a refresh token or an auth code presented as an access token", async () => {
    const { code } = await authorize();
    const t = tokens(await exchange(code));
    expect(await verifyAccessToken(t.refresh_token, RESOURCE)).toBeNull();
    expect(await verifyAccessToken(code, RESOURCE)).toBeNull();
  });

  it("stops working the moment its connection is revoked, and records who revoked it", async () => {
    const { person, code, connectionId } = await authorize();
    const t = tokens(await exchange(code));

    expect(await revokeConnection(connectionId, person.id, "revoked by owner")).toBe(true);
    expect(await verifyAccessToken(t.access_token, RESOURCE)).toBeNull();
    expect(await refreshAccessToken({ refreshToken: t.refresh_token, clientId: CLIENT })).toMatchObject({ error: "invalid_grant" });
    const row = await prisma.auditLog.findFirst({ where: { action: "oauth.connection_revoked", entityId: connectionId } });
    expect(row?.actorPersonId).toBe(person.id);
  });
});

describe("re-consent", () => {
  it("replaces the previous connection for the same person, client, and resource", async () => {
    const { person, code, connectionId } = await authorize();
    const old = tokens(await exchange(code));

    await createAuthorization({
      personId: person.id,
      clientId: CLIENT,
      resource: RESOURCE,
      scope: "recruitment:read",
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
    });

    expect(await verifyAccessToken(old.access_token, RESOURCE)).toBeNull();
    expect((await prisma.oAuthConnection.findUniqueOrThrow({ where: { id: connectionId } })).revokedAt).not.toBeNull();
    expect(await prisma.oAuthConnection.count({ where: { personId: person.id, revokedAt: null } })).toBe(1);
  });
});
