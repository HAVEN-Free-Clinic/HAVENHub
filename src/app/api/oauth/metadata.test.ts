import { describe, expect, it } from "vitest";
import { GET as asMetadata } from "./authorization-server/route";
import { GET as prMetadata } from "./protected-resource/[[...path]]/route";

function req(path: string, headers: Record<string, string> = { host: "hub.havenfreeclinic.org" }) {
  return new Request(`http://internal${path}`, { headers });
}

describe("OAuth discovery documents", () => {
  it("advertises both ways a client can identify itself: metadata documents and registration", async () => {
    const body = await (await asMetadata(req("/.well-known/oauth-authorization-server"))).json();
    expect(body).toMatchObject({
      issuer: "https://hub.havenfreeclinic.org",
      authorization_endpoint: "https://hub.havenfreeclinic.org/oauth/authorize",
      token_endpoint: "https://hub.havenfreeclinic.org/api/oauth/token",
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
    });
    // Claude uses a metadata document only when "none" is also listed.
    expect(body.token_endpoint_auth_methods_supported).toContain("none");
    expect(body.registration_endpoint).toBe("https://hub.havenfreeclinic.org/api/oauth/register");
  });

  it("names the MCP URL exactly as the resource and lists a single issuer", async () => {
    const res = await prMetadata(req("/.well-known/oauth-protected-resource/api/mcp/recruitment"), {
      params: Promise.resolve({ path: ["api", "mcp", "recruitment"] }),
    });
    expect(await res.json()).toMatchObject({
      resource: "https://hub.havenfreeclinic.org/api/mcp/recruitment",
      authorization_servers: ["https://hub.havenfreeclinic.org"],
      scopes_supported: ["recruitment:read"],
    });
  });

  it("builds URLs from the forwarded host, so a preview deployment advertises itself", async () => {
    const body = await (
      await asMetadata(req("/x", { host: "internal", "x-forwarded-host": "havenhub-pr-9.vercel.app", "x-forwarded-proto": "https" }))
    ).json();
    expect(body.issuer).toBe("https://havenhub-pr-9.vercel.app");
  });

  it("404s a protected-resource path that is not an MCP endpoint", async () => {
    const res = await prMetadata(req("/x"), { params: Promise.resolve({ path: ["api", "mcp"] }) });
    expect(res.status).toBe(404);
  });
});
