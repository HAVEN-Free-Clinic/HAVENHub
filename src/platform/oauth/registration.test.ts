import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { authenticateTokenClient, registerClient, sweepUnusedClients, type RegistrationResponse } from "./registration";

beforeEach(resetDb);

let ipSeq = 0;
/** A fresh IP per call, so the per-IP limiter only fires in the test about it. */
const ip = () => `198.51.100.${++ipSeq % 250}`;

function ok(r: unknown): RegistrationResponse {
  expect(r).toHaveProperty("client_id");
  return r as RegistrationResponse;
}

describe("registerClient", () => {
  it("registers a public client with no secret", async () => {
    const r = ok(
      await registerClient(
        { client_name: "Cursor", redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/callback"], token_endpoint_auth_method: "none" },
        ip(),
      ),
    );
    expect(r.client_id).toMatch(/^hub_/);
    expect(r).not.toHaveProperty("client_secret");
    expect(r.token_endpoint_auth_method).toBe("none");
  });

  it("defaults to client_secret_basic, per RFC 7591, and stores only the secret's hash", async () => {
    const r = ok(await registerClient({ redirect_uris: ["http://127.0.0.1/callback"] }, ip()));
    expect(r.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(r.client_secret).toBeTruthy();
    const row = await prisma.oAuthClient.findUniqueOrThrow({ where: { id: r.client_id } });
    expect(row.secretHash).not.toBe(r.client_secret);
  });

  it.each([
    ["no redirect URIs", { redirect_uris: [] }, "invalid_redirect_uri"],
    ["an http redirect to a remote host", { redirect_uris: ["http://evil.example/cb"] }, "invalid_redirect_uri"],
    ["a javascript redirect", { redirect_uris: ["javascript:alert(1)"] }, "invalid_redirect_uri"],
    ["an unknown auth method", { redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "private_key_jwt" }, "invalid_client_metadata"],
    ["an implicit-flow response type", { redirect_uris: ["https://a.example/cb"], response_types: ["token"] }, "invalid_client_metadata"],
    ["not an object", "hello", "invalid_client_metadata"],
  ])("refuses %s", async (_label, body, error) => {
    expect(await registerClient(body, ip())).toMatchObject({ error });
    expect(await prisma.oAuthClient.count()).toBe(0);
  });

  it("rate-limits one IP", async () => {
    const same = "203.0.113.7";
    for (let i = 0; i < 20; i++) ok(await registerClient({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "none" }, same));
    expect(await registerClient({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "none" }, same)).toMatchObject({
      error: "rate_limited",
    });
  });

  it("truncates an oversized client name rather than storing it whole", async () => {
    const r = ok(await registerClient({ client_name: "x".repeat(500), redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "none" }, ip()));
    expect(r.client_name).toHaveLength(100);
  });
});

describe("sweepUnusedClients", () => {
  it("deletes week-old registrations nobody approved, and keeps approved or recent ones", async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await prisma.oAuthClient.createMany({
      data: [
        { id: "hub_stale", redirectUris: ["https://a.example/cb"], createdAt: old },
        { id: "hub_used", redirectUris: ["https://a.example/cb"], createdAt: old, lastUsedAt: old },
        { id: "hub_new", redirectUris: ["https://a.example/cb"] },
      ],
    });
    expect(await sweepUnusedClients()).toBe(1);
    expect((await prisma.oAuthClient.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((c) => c.id)).toEqual(["hub_new", "hub_used"]);
  });
});

describe("authenticateTokenClient", () => {
  const form = (f: Record<string, string>) => new URLSearchParams(f);
  const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

  it("accepts a metadata-document client and a public registered client by id alone", async () => {
    const pub = ok(await registerClient({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "none" }, ip()));
    expect(await authenticateTokenClient(form({ client_id: "https://claude.ai/oauth/claude-code-client-metadata" }), null)).toEqual({
      clientId: "https://claude.ai/oauth/claude-code-client-metadata",
    });
    expect(await authenticateTokenClient(form({ client_id: pub.client_id }), null)).toEqual({ clientId: pub.client_id });
  });

  it("requires a confidential client's secret, by the method it registered with", async () => {
    const conf = ok(await registerClient({ redirect_uris: ["https://a.example/cb"] }, ip()));
    const secret = conf.client_secret as string;

    expect(await authenticateTokenClient(form({}), basic(conf.client_id, secret))).toEqual({ clientId: conf.client_id });
    expect(await authenticateTokenClient(form({ client_id: conf.client_id }), null)).toMatchObject({ error: "invalid_client" });
    expect(await authenticateTokenClient(form({}), basic(conf.client_id, "wrong"))).toMatchObject({ error: "invalid_client" });
    // Registered for Basic; the same secret in the body is refused.
    expect(await authenticateTokenClient(form({ client_id: conf.client_id, client_secret: secret }), null)).toMatchObject({
      error: "invalid_client",
    });
  });

  it("accepts client_secret_post in the body", async () => {
    const conf = ok(await registerClient({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_post" }, ip()));
    expect(await authenticateTokenClient(form({ client_id: conf.client_id, client_secret: conf.client_secret as string }), null)).toEqual({
      clientId: conf.client_id,
    });
  });

  it("refuses an unknown registered id", async () => {
    expect(await authenticateTokenClient(form({ client_id: "hub_nope" }), null)).toMatchObject({ error: "invalid_client" });
  });
});
