import { describe, it, expect, afterEach, vi } from "vitest";
import {
  isMcpConfigured,
  isWebhookConfigured,
  intercomAccessToken,
  mcpBearerToken,
  intercomBotAdminId,
} from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
});

function configureAll() {
  vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
  vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
  vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
  vi.stubEnv("INTERCOM_MCP_BEARER_TOKEN", "bearer-token");
}

function configureWebhookAll() {
  vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
  vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
  vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
  vi.stubEnv("INTERCOM_WEBHOOK_SECRET", "webhook-secret");
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

describe("webhook configuration", () => {
  it("is configured only when the webhook secret, access token, and Messenger are all present", () => {
    configureWebhookAll();
    expect(isWebhookConfigured()).toBe(true);
  });

  it("is off without the webhook secret", () => {
    configureWebhookAll();
    vi.stubEnv("INTERCOM_WEBHOOK_SECRET", "");
    expect(isWebhookConfigured()).toBe(false);
  });

  it("is off without the Intercom access token", () => {
    configureWebhookAll();
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "");
    expect(isWebhookConfigured()).toBe(false);
  });

  // Chains through isIntercomConfigured: without the Messenger, no contact
  // ever gets an external_id, so resolveIdentityFromConversation could never
  // succeed and ticket.created would 401 forever -- a partially-configured
  // state that fails obscurely rather than staying off. See config.ts's doc
  // comment on isWebhookConfigured.
  it("is off when the Messenger itself is not configured, even with the webhook secret and access token set", () => {
    configureWebhookAll();
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "");
    expect(isWebhookConfigured()).toBe(false);
  });
});

describe("intercomBotAdminId", () => {
  it("is null when unset, and trimmed when set", () => {
    expect(intercomBotAdminId()).toBeNull();
    vi.stubEnv("INTERCOM_BOT_ADMIN_ID", "  admin-1  ");
    expect(intercomBotAdminId()).toBe("admin-1");
  });
});
