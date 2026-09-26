import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ personId: "" }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "hub.test", "x-forwarded-proto": "https" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));
vi.mock("@/platform/oauth/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/oauth/safe-fetch")>()),
  getPublicJson: async () => ({ client_id: "https://claude.ai/oauth/claude-code-client-metadata", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
}));
vi.mock("@/platform/auth/session", () => ({ requirePersonSession: async () => ({ personId: session.personId }) }));

import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { approveAuthorizationAction, denyAuthorizationAction } from "./actions";

const CLIENT = "https://claude.ai/oauth/claude-code-client-metadata";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

beforeEach(async () => {
  await resetDb();
});

function fields(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  const base = {
    response_type: "code",
    client_id: CLIENT,
    redirect_uri: CALLBACK,
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    state: "s1",
    scope: "recruitment:read",
    resource: "https://hub.test/api/mcp/recruitment",
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) fd.set(k, v);
  return fd;
}

async function redirectOf(p: Promise<void>): Promise<URL> {
  const err = (await p.then(() => null, (e: unknown) => e)) as { url?: string } | null;
  if (!err?.url) throw new Error("expected a redirect");
  return new URL(err.url, "https://hub.test");
}

async function member(grant: boolean) {
  const person = await prisma.person.create({ data: { name: "Consenting Member" } });
  if (grant) {
    const role = await prisma.role.create({ data: { name: "API", grants: { create: [{ permission: "recruitment.api_access" }] } } });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: person.id, termId: null } });
  }
  session.personId = person.id;
  return person;
}

describe("consent actions", () => {
  it("approve issues a code to the verified callback, with state and iss", async () => {
    const person = await member(true);
    const url = await redirectOf(approveAuthorizationAction(fields()));

    expect(`${url.origin}${url.pathname}`).toBe(CALLBACK);
    expect(url.searchParams.get("code")).toBeTruthy();
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("iss")).toBe("https://hub.test");
    expect(await prisma.oAuthConnection.findFirst({ where: { personId: person.id } })).toMatchObject({ clientId: CLIENT });
  });

  it("marks a registered client as used, so the unused-registration sweep keeps it", async () => {
    await member(true);
    await prisma.oAuthClient.create({ data: { id: "hub_cli", clientName: "Local agent", redirectUris: ["http://127.0.0.1/callback"] } });
    const url = await redirectOf(
      approveAuthorizationAction(fields({ client_id: "hub_cli", redirect_uri: "http://127.0.0.1:9000/callback" })),
    );
    expect(url.host).toBe("127.0.0.1:9000");
    expect((await prisma.oAuthClient.findUniqueOrThrow({ where: { id: "hub_cli" } })).lastUsedAt).not.toBeNull();
    expect((await prisma.oAuthConnection.findFirstOrThrow({ where: { clientId: "hub_cli" } })).clientName).toBe("Local agent");
  });

  it("re-checks the permission at submit and denies without creating anything", async () => {
    const person = await member(false);
    const url = await redirectOf(approveAuthorizationAction(fields()));

    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(await prisma.oAuthConnection.count({ where: { personId: person.id } })).toBe(0);
  });

  it("does not trust an edited hidden redirect_uri: no code is sent anywhere", async () => {
    const person = await member(true);
    const url = await redirectOf(approveAuthorizationAction(fields({ redirect_uri: "https://evil.example/cb" })));

    expect(url.origin).toBe("https://hub.test");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(await prisma.oAuthConnection.count({ where: { personId: person.id } })).toBe(0);
  });

  it("deny returns access_denied to the client", async () => {
    await member(true);
    const url = await redirectOf(denyAuthorizationAction(fields()));
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("s1");
  });
});
