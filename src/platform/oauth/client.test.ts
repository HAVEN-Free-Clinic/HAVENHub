import { describe, expect, it } from "vitest";
import { isFetchableClientIdUrl, isPrivateAddress, isRegistrableRedirectUri, parseClientMetadata, redirectUriAllowed } from "./client";

const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";

describe("isFetchableClientIdUrl", () => {
  it("accepts an https URL on a named host, whoever runs it", () => {
    expect(isFetchableClientIdUrl(CLAUDE_CODE)).toBe(true);
    expect(isFetchableClientIdUrl("https://vscode.dev/oauth/client-metadata.json")).toBe(true);
  });

  it.each([
    ["plain http", "http://claude.ai/oauth/claude-code-client-metadata"],
    ["embedded credentials", "https://user:pw@claude.ai/metadata"],
    ["an explicit port", "https://claude.ai:8443/metadata"],
    ["a fragment", "https://claude.ai/metadata#x"],
    ["an IPv4 literal", "https://169.254.169.254/latest/meta-data"],
    ["an IPv6 literal", "https://[::1]/metadata"],
    ["a single-label host", "https://intranet/metadata"],
    ["not a URL", "claude"],
  ])("refuses %s before any lookup", (_label, id) => {
    expect(isFetchableClientIdUrl(id)).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])(
    "treats %s as private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );

  it.each(["8.8.8.8", "160.79.104.10", "172.32.0.1", "2606:4700::1111"])("treats %s as public", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe("isRegistrableRedirectUri", () => {
  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "https://vscode.dev/redirect",
    "http://127.0.0.1:33418/callback",
    "http://localhost/callback",
    "cursor://anysphere.cursor-retrieval/oauth/callback",
  ])("accepts %s", (uri) => expect(isRegistrableRedirectUri(uri)).toBe(true));

  it.each([
    ["http to a remote host", "http://evil.example/cb"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,hi"],
    ["file", "file:///etc/passwd"],
    ["a fragment", "https://app.example/cb#frag"],
    ["mailto", "mailto:someone@example.com"],
    ["garbage", "not a uri"],
  ])("refuses %s", (_label, uri) => expect(isRegistrableRedirectUri(uri)).toBe(false));
});

describe("parseClientMetadata", () => {
  it("accepts a document naming its own URL", () => {
    const meta = parseClientMetadata(CLAUDE_CODE, {
      client_id: CLAUDE_CODE,
      client_name: "Claude Code",
      redirect_uris: ["http://localhost/callback"],
    });
    expect(meta).toEqual({ clientId: CLAUDE_CODE, clientName: "Claude Code", redirectUris: ["http://localhost/callback"] });
  });

  it("refuses a document that claims to be a different client", () => {
    expect(parseClientMetadata(CLAUDE_CODE, { client_id: "https://claude.ai/other", redirect_uris: [] })).toBeNull();
  });

  it("refuses a document without a string array of redirect_uris", () => {
    expect(parseClientMetadata(CLAUDE_CODE, { client_id: CLAUDE_CODE })).toBeNull();
    expect(parseClientMetadata(CLAUDE_CODE, { client_id: CLAUDE_CODE, redirect_uris: [1] })).toBeNull();
    expect(parseClientMetadata(CLAUDE_CODE, null)).toBeNull();
  });
});

describe("redirectUriAllowed", () => {
  const hosted = ["https://claude.ai/api/mcp/auth_callback"];
  const loopback = ["http://localhost/callback", "http://127.0.0.1/callback"];

  it("matches a hosted callback exactly and nothing else", () => {
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback", hosted)).toBe(true);
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback/", hosted)).toBe(false);
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback?x=1", hosted)).toBe(false);
    expect(redirectUriAllowed("https://evil.example/api/mcp/auth_callback", hosted)).toBe(false);
  });

  it("matches a loopback registration on any port (Claude Code's ephemeral port)", () => {
    expect(redirectUriAllowed("http://localhost:3118/callback", loopback)).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:50123/callback", loopback)).toBe(true);
  });

  it("does not let the port-agnostic rule loosen the path, host, or scheme", () => {
    expect(redirectUriAllowed("http://localhost:3118/other", loopback)).toBe(false);
    expect(redirectUriAllowed("https://localhost:3118/callback", loopback)).toBe(false);
    expect(redirectUriAllowed("http://example.com:3118/callback", loopback)).toBe(false);
  });

  it("never applies the loopback rule to a non-loopback registration", () => {
    expect(redirectUriAllowed("https://claude.ai:444/api/mcp/auth_callback", hosted)).toBe(false);
  });
});
