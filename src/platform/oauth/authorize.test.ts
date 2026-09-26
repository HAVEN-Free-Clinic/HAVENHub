import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { clientRedirect, validateAuthorizeRequest, type AuthorizeParams } from "./authorize";

const ORIGIN = "https://hub.test";
const CLIENT = "https://claude.ai/oauth/claude-code-client-metadata";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const fetchMock = vi.fn();

beforeEach(() => {
  dns.lookup.mockResolvedValue([{ address: "160.79.104.10", family: 4 }]);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({ client_id: CLIENT, client_name: "Claude Code", redirect_uris: ["http://localhost/callback", "https://claude.ai/api/mcp/auth_callback"] }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function params(overrides: Partial<AuthorizeParams> = {}): AuthorizeParams {
  return {
    response_type: "code",
    client_id: CLIENT,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "xyz",
    scope: "recruitment:read",
    resource: `${ORIGIN}/api/mcp/recruitment`,
    ...overrides,
  };
}

describe("validateAuthorizeRequest", () => {
  it("accepts a well-formed request, recording the verified document host and the redirect host", async () => {
    const out = await validateAuthorizeRequest(params(), ORIGIN);
    expect(out).toMatchObject({
      kind: "ok",
      client: { kind: "metadata-document", documentHost: "claude.ai", clientName: "Claude Code" },
      redirectHost: "claude.ai",
      resourceUrl: `${ORIGIN}/api/mcp/recruitment`,
      codeChallenge: CHALLENGE,
      state: "xyz",
    });
  });

  it("accepts a metadata document from any public host, not just claude.ai", async () => {
    const other = "https://vscode.dev/oauth/client-metadata.json";
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ client_id: other, redirect_uris: ["https://vscode.dev/redirect"] })));
    const out = await validateAuthorizeRequest(params({ client_id: other, redirect_uri: "https://vscode.dev/redirect" }), ORIGIN);
    expect(out).toMatchObject({ kind: "ok", client: { documentHost: "vscode.dev" } });
  });

  it("never fetches a metadata URL whose host resolves to a private address", async () => {
    dns.lookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    const out = await validateAuthorizeRequest(params({ client_id: "https://internal.example/meta" }), ORIGIN);
    expect(out.kind).toBe("fatal");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails without redirecting for an unknown registered client id", async () => {
    await resetDb();
    expect((await validateAuthorizeRequest(params({ client_id: "hub_nope" }), ORIGIN)).kind).toBe("fatal");
  });

  it("accepts a registered client on one of its registered redirect URIs, and labels it as registered", async () => {
    await resetDb();
    await prisma.oAuthClient.create({
      data: { id: "hub_test", clientName: "Cursor", redirectUris: ["cursor://anysphere.cursor-retrieval/oauth/callback"] },
    });
    const out = await validateAuthorizeRequest(
      params({ client_id: "hub_test", redirect_uri: "cursor://anysphere.cursor-retrieval/oauth/callback" }),
      ORIGIN,
    );
    expect(out).toMatchObject({ kind: "ok", client: { kind: "registered", clientName: "Cursor", documentHost: null } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails without redirecting when the redirect_uri is not one the client registered", async () => {
    const out = await validateAuthorizeRequest(params({ redirect_uri: "https://evil.example/callback" }), ORIGIN);
    expect(out.kind).toBe("fatal");
  });

  it("fails without redirecting when the metadata document cannot be fetched", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    expect((await validateAuthorizeRequest(params(), ORIGIN)).kind).toBe("fatal");
  });

  it.each([
    ["missing PKCE", { code_challenge: null }, "invalid_request"],
    ["plain PKCE", { code_challenge_method: "plain" }, "invalid_request"],
    ["a token response type", { response_type: "token" }, "unsupported_response_type"],
    ["a resource on another origin", { resource: "https://other.test/api/mcp/recruitment" }, "invalid_target"],
    ["a scope this resource lacks", { scope: "recruitment:write" }, "invalid_scope"],
  ])("reports %s back to the verified redirect_uri", async (_label, overrides, error) => {
    const out = await validateAuthorizeRequest(params(overrides as Partial<AuthorizeParams>), ORIGIN);
    expect(out).toMatchObject({ kind: "redirect_error", error, state: "xyz", redirectUri: "https://claude.ai/api/mcp/auth_callback" });
  });

  it("tolerates offline_access alongside the resource scope", async () => {
    expect((await validateAuthorizeRequest(params({ scope: "recruitment:read offline_access" }), ORIGIN)).kind).toBe("ok");
  });

  it("resolves the resource from the scope when the client omits resource", async () => {
    expect(await validateAuthorizeRequest(params({ resource: null }), ORIGIN)).toMatchObject({ kind: "ok" });
  });

  it("refuses redirects when the metadata fetch would follow one", async () => {
    await validateAuthorizeRequest(params(), ORIGIN);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });
});

describe("clientRedirect", () => {
  it("adds iss and echoes state, dropping null values", () => {
    const url = new URL(clientRedirect("https://claude.ai/api/mcp/auth_callback", { code: "c", state: null }, ORIGIN));
    expect(url.searchParams.get("code")).toBe("c");
    expect(url.searchParams.get("iss")).toBe(ORIGIN);
    expect(url.searchParams.has("state")).toBe(false);
  });
});
