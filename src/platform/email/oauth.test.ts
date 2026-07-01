import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { config } from "@/platform/config";
import {
  buildAuthorizeUrl,
  exchangeCode,
  getAccessToken,
  mailConnectionStatus,
  MailNotConnectedError,
  __resetTokenCache,
  teamsScopesGranted,
} from "./oauth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal base64url-encoded JWT with a preferred_username claim.
 * The signature segment is fake -- we never verify it.
 */
function makeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.fakesig`;
}

/**
 * Build a fetch stub that always returns a 200 JSON body.
 */
function makeOkFetch(body: object): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

/**
 * Build a fetch stub that always returns a non-2xx response.
 */
function makeFailFetch(status: number, text = "error"): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(text, { status }));
}

// ---------------------------------------------------------------------------
// DB isolation
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await resetDb();
  __resetTokenCache();
});

describe("buildAuthorizeUrl", () => {
  // buildAuthorizeUrl throws when the OAuth app is unconfigured, so provide
  // test values for the client id and tenant (restored after).
  const prevClientId = config.GRAPH_OAUTH_CLIENT_ID;
  const prevTenantId = config.GRAPH_OAUTH_TENANT_ID;
  beforeAll(() => {
    config.GRAPH_OAUTH_CLIENT_ID = "test-client-id";
    config.GRAPH_OAUTH_TENANT_ID = "test-tenant-id";
  });
  afterAll(() => {
    config.GRAPH_OAUTH_CLIENT_ID = prevClientId;
    config.GRAPH_OAUTH_TENANT_ID = prevTenantId;
  });

  it("throws when the OAuth app is not configured", () => {
    const saved = config.GRAPH_OAUTH_CLIENT_ID;
    config.GRAPH_OAUTH_CLIENT_ID = undefined;
    expect(() => buildAuthorizeUrl({ state: "s" })).toThrow(/not configured/);
    config.GRAPH_OAUTH_CLIENT_ID = saved;
  });

  it("returns a URL pointing at the Microsoft authorize endpoint", () => {
    const url = buildAuthorizeUrl({ state: "test-state" });
    expect(url).toContain("login.microsoftonline.com");
    expect(url).toContain("oauth2/v2.0/authorize");
  });

  it("includes response_type=code", () => {
    const url = buildAuthorizeUrl({ state: "s1" });
    expect(url).toContain("response_type=code");
  });

  it("includes response_mode=query", () => {
    const url = buildAuthorizeUrl({ state: "s1" });
    expect(url).toContain("response_mode=query");
  });

  it("includes the state parameter verbatim", () => {
    const url = buildAuthorizeUrl({ state: "my-csrf-token" });
    expect(url).toContain("state=my-csrf-token");
  });

  it("includes offline_access in the scope", () => {
    const url = buildAuthorizeUrl({ state: "s1" });
    expect(decodeURIComponent(url)).toContain("offline_access");
  });

  it("includes Mail.Send in the scope", () => {
    const url = buildAuthorizeUrl({ state: "s1" });
    expect(decodeURIComponent(url)).toContain("Mail.Send");
  });

  it("includes Mail.Send.Shared in the scope", () => {
    const url = buildAuthorizeUrl({ state: "s1" });
    expect(decodeURIComponent(url)).toContain("Mail.Send.Shared");
  });

  it("includes Channel.ReadBasic.All in the scope", () => {
    const url = buildAuthorizeUrl({ state: "xyz" });
    expect(decodeURIComponent(url)).toContain("Channel.ReadBasic.All");
  });

  it("includes the client_id param key", () => {
    const url = buildAuthorizeUrl({ state: "s1" });
    // Value may be undefined in test env but the key must be present.
    expect(url).toContain("client_id=");
  });

  it("includes the redirect_uri param key", () => {
    const url = buildAuthorizeUrl({ state: "s1" });
    expect(url).toContain("redirect_uri=");
  });

  it("includes Chat.Create in the scope", () => {
    const url = buildAuthorizeUrl({ state: "s1" });
    expect(decodeURIComponent(url)).toContain("Chat.Create");
  });

  it("includes ChatMessage.Send in the scope", () => {
    const url = buildAuthorizeUrl({ state: "s1" });
    expect(decodeURIComponent(url)).toContain("ChatMessage.Send");
  });
});

describe("teamsScopesGranted", () => {
  it("returns false for null", () => {
    expect(teamsScopesGranted(null)).toBe(false);
  });

  it("returns false when only Mail.Send is present", () => {
    expect(teamsScopesGranted("Mail.Send")).toBe(false);
  });

  it("returns false when only Chat.Create is present", () => {
    expect(teamsScopesGranted("Mail.Send Chat.Create")).toBe(false);
  });

  it("returns false when only ChatMessage.Send is present", () => {
    expect(teamsScopesGranted("Mail.Send ChatMessage.Send")).toBe(false);
  });

  it("returns true when both Chat.Create and ChatMessage.Send are present", () => {
    expect(teamsScopesGranted("Mail.Send Chat.Create ChatMessage.Send")).toBe(true);
  });
});

describe("exchangeCode", () => {
  it("upserts a MailCredential row with the returned refresh token", async () => {
    const idToken = makeIdToken({ preferred_username: "admin@haven.edu" });
    const fetchStub = makeOkFetch({
      refresh_token: "r1",
      access_token: "a0",
      expires_in: 3600,
      scope: "Mail.Send offline_access",
      id_token: idToken,
    });

    await exchangeCode("auth-code-123", fetchStub as typeof fetch);

    const row = await prisma.mailCredential.findUnique({ where: { id: "mailer" } });
    expect(row).not.toBeNull();
    expect(row!.refreshToken).toBe("r1");
  });

  it("parses the preferred_username from the id_token and stores it as account", async () => {
    const idToken = makeIdToken({ preferred_username: "admin@haven.edu" });
    const fetchStub = makeOkFetch({
      refresh_token: "r1",
      access_token: "a0",
      expires_in: 3600,
      id_token: idToken,
    });

    await exchangeCode("auth-code-123", fetchStub as typeof fetch);

    const row = await prisma.mailCredential.findUnique({ where: { id: "mailer" } });
    expect(row!.account).toBe("admin@haven.edu");
  });

  it("falls back to the email claim when preferred_username is absent", async () => {
    const idToken = makeIdToken({ email: "fallback@haven.edu" });
    const fetchStub = makeOkFetch({
      refresh_token: "r2",
      access_token: "a0",
      expires_in: 3600,
      id_token: idToken,
    });

    await exchangeCode("auth-code-456", fetchStub as typeof fetch);

    const row = await prisma.mailCredential.findUnique({ where: { id: "mailer" } });
    expect(row!.account).toBe("fallback@haven.edu");
  });

  it("stores null account when no id_token is present", async () => {
    const fetchStub = makeOkFetch({
      refresh_token: "r3",
      access_token: "a0",
      expires_in: 3600,
    });

    await exchangeCode("auth-code-789", fetchStub as typeof fetch);

    const row = await prisma.mailCredential.findUnique({ where: { id: "mailer" } });
    expect(row!.account).toBeNull();
  });

  it("stores null account when id_token payload cannot be parsed", async () => {
    const fetchStub = makeOkFetch({
      refresh_token: "r4",
      access_token: "a0",
      expires_in: 3600,
      id_token: "not.a.valid.jwt",
    });

    await exchangeCode("auth-code-bad", fetchStub as typeof fetch);

    const row = await prisma.mailCredential.findUnique({ where: { id: "mailer" } });
    expect(row!.account).toBeNull();
  });

  it("upserts (overwrites) an existing credential row", async () => {
    // Seed a row.
    await prisma.mailCredential.create({
      data: { id: "mailer", refreshToken: "old-token" },
    });

    const fetchStub = makeOkFetch({ refresh_token: "new-token", access_token: "a0", expires_in: 3600 });
    await exchangeCode("code-xyz", fetchStub as typeof fetch);

    const row = await prisma.mailCredential.findUnique({ where: { id: "mailer" } });
    expect(row!.refreshToken).toBe("new-token");
  });

  it("sends the token request as x-www-form-urlencoded POST with the correct fields", async () => {
    const fetchStub = makeOkFetch({ refresh_token: "r1", access_token: "a0", expires_in: 3600 });
    await exchangeCode("the-code", fetchStub as typeof fetch);

    expect(fetchStub).toHaveBeenCalledOnce();
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(init.method?.toUpperCase()).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    const body = String(init.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=the-code");
    expect(body).toContain("redirect_uri=");
  });

  it("throws when the token endpoint returns a non-2xx status", async () => {
    const fetchStub = makeFailFetch(400, "bad_request");
    await expect(exchangeCode("bad-code", fetchStub as typeof fetch)).rejects.toThrow(/400/);
  });
});

describe("getAccessToken", () => {
  it("throws MailNotConnectedError when no MailCredential row exists", async () => {
    const fetchStub = vi.fn();
    await expect(getAccessToken(fetchStub as typeof fetch)).rejects.toThrow(
      MailNotConnectedError
    );
  });

  it("redeems the stored refresh token and returns the access token", async () => {
    await prisma.mailCredential.create({ data: { id: "mailer", refreshToken: "r1" } });

    const fetchStub = makeOkFetch({
      access_token: "a1",
      expires_in: 3600,
      refresh_token: "r2",
    });

    const token = await getAccessToken(fetchStub as typeof fetch);
    expect(token).toBe("a1");
  });

  it("persists the rotated refresh token returned by the token endpoint", async () => {
    await prisma.mailCredential.create({ data: { id: "mailer", refreshToken: "r1" } });

    const fetchStub = makeOkFetch({
      access_token: "a1",
      expires_in: 3600,
      refresh_token: "r2",
    });

    await getAccessToken(fetchStub as typeof fetch);

    const row = await prisma.mailCredential.findUnique({ where: { id: "mailer" } });
    expect(row!.refreshToken).toBe("r2");
  });

  it("does NOT update the row when the token endpoint omits refresh_token", async () => {
    await prisma.mailCredential.create({ data: { id: "mailer", refreshToken: "r1" } });

    const fetchStub = makeOkFetch({
      access_token: "a1",
      expires_in: 3600,
      // no refresh_token field
    });

    await getAccessToken(fetchStub as typeof fetch);

    const row = await prisma.mailCredential.findUnique({ where: { id: "mailer" } });
    expect(row!.refreshToken).toBe("r1");
  });

  it("caches the access token and does not call fetch on a second immediate call", async () => {
    await prisma.mailCredential.create({ data: { id: "mailer", refreshToken: "r1" } });

    const fetchStub = makeOkFetch({
      access_token: "a1",
      expires_in: 3600,
      refresh_token: "r2",
    });

    const first = await getAccessToken(fetchStub as typeof fetch);
    const second = await getAccessToken(fetchStub as typeof fetch);

    expect(first).toBe("a1");
    expect(second).toBe("a1");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("uses the rotated refresh token on a subsequent redemption after cache reset", async () => {
    await prisma.mailCredential.create({ data: { id: "mailer", refreshToken: "r1" } });

    const fetchStub = makeOkFetch({
      access_token: "a1",
      expires_in: 3600,
      refresh_token: "r2",
    });

    await getAccessToken(fetchStub as typeof fetch);
    __resetTokenCache();

    // Second redemption should use "r2" (the rotated token).
    const fetchStub2 = makeOkFetch({
      access_token: "a2",
      expires_in: 3600,
      refresh_token: "r3",
    });

    const token = await getAccessToken(fetchStub2 as typeof fetch);
    expect(token).toBe("a2");

    // Confirm the row now holds "r3".
    const row = await prisma.mailCredential.findUnique({ where: { id: "mailer" } });
    expect(row!.refreshToken).toBe("r3");

    // And first fetch was only used once (the second call used fetchStub2).
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub2).toHaveBeenCalledTimes(1);
  });

  it("sends grant_type=refresh_token in the POST body", async () => {
    await prisma.mailCredential.create({ data: { id: "mailer", refreshToken: "r1" } });

    const fetchStub = makeOkFetch({ access_token: "a1", expires_in: 3600 });
    await getAccessToken(fetchStub as typeof fetch);

    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).toContain("grant_type=refresh_token");
    expect(String(init.body)).toContain("refresh_token=r1");
  });

  it("throws when the token endpoint returns a non-2xx status", async () => {
    await prisma.mailCredential.create({ data: { id: "mailer", refreshToken: "r1" } });

    const fetchStub = makeFailFetch(401, "Unauthorized");
    await expect(getAccessToken(fetchStub as typeof fetch)).rejects.toThrow(/401/);
  });

  it("re-fetches after reconnect: exchangeCode invalidates the stale cache", async () => {
    // Seed a credential and populate the cache with a1.
    await prisma.mailCredential.create({ data: { id: "mailer", refreshToken: "r1" } });
    const fetchFirst = makeOkFetch({ access_token: "a1", expires_in: 3600, refresh_token: "r2" });
    const cachedToken = await getAccessToken(fetchFirst as typeof fetch);
    expect(cachedToken).toBe("a1");
    expect(fetchFirst).toHaveBeenCalledTimes(1);

    // Admin reconnects with a new code (possibly a different account).
    const exchangeFetch = makeOkFetch({
      refresh_token: "r-new",
      access_token: "a-unused",
      expires_in: 3600,
    });
    await exchangeCode("new-auth-code", exchangeFetch as typeof fetch);

    // Now getAccessToken must hit the network again -- not return the stale a1.
    const fetchSecond = makeOkFetch({ access_token: "a2", expires_in: 3600, refresh_token: "r-new2" });
    const freshToken = await getAccessToken(fetchSecond as typeof fetch);

    expect(freshToken).toBe("a2");
    expect(fetchSecond).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 60-second skew boundary
// ---------------------------------------------------------------------------

describe("getAccessToken -- 60-second skew boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    __resetTokenCache();
  });

  it("serves from cache before the skew window and re-fetches inside it", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    await prisma.mailCredential.create({ data: { id: "mailer", refreshToken: "r1" } });

    // expires_in = 120 s  => token expires at now + 120 000 ms
    // skew window starts at now + 120 000 - 60 000 = now + 60 000 ms
    const fetchFirst = makeOkFetch({ access_token: "a1", expires_in: 120, refresh_token: "r2" });
    const first = await getAccessToken(fetchFirst as typeof fetch);
    expect(first).toBe("a1");
    expect(fetchFirst).toHaveBeenCalledTimes(1);

    // Advance to 59 s after issue -- still outside the 60 s skew window; cache hit.
    vi.setSystemTime(now + 59_000);
    const cached = await getAccessToken(fetchFirst as typeof fetch);
    expect(cached).toBe("a1");
    expect(fetchFirst).toHaveBeenCalledTimes(1); // no new network call

    // Advance to 61 s after issue -- inside the skew window; must re-fetch.
    vi.setSystemTime(now + 61_000);
    const fetchSecond = makeOkFetch({ access_token: "a2", expires_in: 120, refresh_token: "r3" });
    const refreshed = await getAccessToken(fetchSecond as typeof fetch);
    expect(refreshed).toBe("a2");
    expect(fetchSecond).toHaveBeenCalledTimes(1);
  });
});

describe("mailConnectionStatus", () => {
  it("returns connected=false when no credential row exists", async () => {
    const status = await mailConnectionStatus();
    expect(status.connected).toBe(false);
    expect(status.account).toBeNull();
    expect(status.connectedAt).toBeNull();
  });

  it("returns connected=true with account and connectedAt when a row exists", async () => {
    await prisma.mailCredential.create({
      data: { id: "mailer", refreshToken: "r1", account: "admin@haven.edu" },
    });

    const status = await mailConnectionStatus();
    expect(status.connected).toBe(true);
    expect(status.account).toBe("admin@haven.edu");
    expect(status.connectedAt).toBeInstanceOf(Date);
  });

  it("returns account=null when the row has no account", async () => {
    await prisma.mailCredential.create({
      data: { id: "mailer", refreshToken: "r1" },
    });

    const status = await mailConnectionStatus();
    expect(status.connected).toBe(true);
    expect(status.account).toBeNull();
  });
});
