import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ run: undefined as undefined | ((args: Record<string, unknown>) => Promise<unknown>) }));

// Stands in for mcp-handler: registers the first tool and invokes it, the way
// the real SDK would on a tools/call. What is under test is the route's three
// gates and that the tool runs as the token's person, not the MCP transport.
vi.mock("mcp-handler", () => ({
  createMcpHandler: vi.fn((init: (server: unknown) => void) => async () => {
    init({
      registerTool: (_n: string, _c: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
        captured.run ??= handler;
      },
    });
    return Response.json(await captured.run?.({}));
  }),
}));

vi.mock("./tools", async () => {
  const { z } = await import("zod");
  return {
    RECRUITMENT_TOOLS: [
      {
        name: "whoami",
        title: "Who am I",
        description: "test",
        inputSchema: z.object({}),
        run: async (ctx: { personId: string }) => `person:${ctx.personId}`,
      },
    ],
  };
});

import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { createAuthorization, exchangeAuthorizationCode } from "@/platform/oauth/tokens";
import { POST } from "./route";

const CLIENT = "https://claude.ai/oauth/claude-code-client-metadata";
const VERIFIER = "z".repeat(60);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const HOST = "hub.havenfreeclinic.org";

beforeEach(async () => {
  await resetDb();
  captured.run = undefined;
});

async function personWithToken(opts: { grant: boolean; resource?: string }) {
  const person = await prisma.person.create({ data: { name: "Connector User" } });
  if (opts.grant) {
    const role = await prisma.role.create({
      data: { name: "Recruitment API", grants: { create: [{ permission: "recruitment.api_access" }] } },
    });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: person.id, termId: null } });
  }
  const { code } = await createAuthorization({
    personId: person.id,
    clientId: CLIENT,
    resource: opts.resource ?? `https://${HOST}/api/mcp/recruitment`,
    scope: "recruitment:read",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    codeChallenge: CHALLENGE,
  });
  const t = await exchangeAuthorizationCode({
    code,
    clientId: CLIENT,
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    codeVerifier: VERIFIER,
  });
  if (!("access_token" in t)) throw new Error("exchange failed");
  return { person, token: t.access_token };
}

function call(token?: string) {
  return POST(
    new Request(`https://${HOST}/api/mcp/recruitment`, {
      method: "POST",
      headers: { host: HOST, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: "{}",
    }),
  );
}

describe("/api/mcp/recruitment", () => {
  it("answers a tokenless request with the 401 challenge Claude needs to start sign-in", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="https://${HOST}/.well-known/oauth-protected-resource/api/mcp/recruitment"`);
    expect(challenge).toContain('scope="recruitment:read"');
  });

  it("rejects a token consented for a different origin's endpoint", async () => {
    const { token } = await personWithToken({ grant: true, resource: "https://preview.test/api/mcp/recruitment" });
    expect((await call(token)).status).toBe(401);
  });

  it("runs tools as the token's person, and audits the call", async () => {
    const { person, token } = await personWithToken({ grant: true });
    const res = await call(token);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain(`person:${person.id}`);
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment_mcp.ok", actorPersonId: person.id } });
    expect(audit?.entityId).toBe("whoami");
  });

  it("refuses with a terminal 403, not a sign-in loop, once recruitment.api_access is gone", async () => {
    const { token } = await personWithToken({ grant: false });
    const res = await call(token);
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(captured.run).toBeUndefined();
  });

  it("stops an offboarded person's live token immediately", async () => {
    const { person, token } = await personWithToken({ grant: true });
    await prisma.person.update({ where: { id: person.id }, data: { status: "OFFBOARDED" } });
    expect((await call(token)).status).toBe(401);
  });
});
