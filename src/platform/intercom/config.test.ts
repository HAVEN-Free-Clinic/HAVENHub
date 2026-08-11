import { describe, it, expect, afterEach, vi } from "vitest";
import { isMcpConfigured, intercomAccessToken, mcpBearerToken } from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
});

function configureAll() {
  vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
  vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
  vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
  vi.stubEnv("INTERCOM_MCP_BEARER_TOKEN", "bearer-token");
}

describe("MCP configuration", () => {
  it("is configured only when every value is present", () => {
    configureAll();
    expect(isMcpConfigured()).toBe(true);
    expect(intercomAccessToken()).toBe("access-token");
    expect(mcpBearerToken()).toBe("bearer-token");
  });

  it("is off without the Intercom access token, since identity cannot be verified", () => {
    configureAll();
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "");
    expect(isMcpConfigured()).toBe(false);
  });

  it("is off without the MCP bearer token, since the endpoint would be unauthenticated", () => {
    configureAll();
    vi.stubEnv("INTERCOM_MCP_BEARER_TOKEN", "");
    expect(isMcpConfigured()).toBe(false);
  });

  it("is off when the Messenger itself is not configured", () => {
    configureAll();
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "");
    expect(isMcpConfigured()).toBe(false);
  });
});
