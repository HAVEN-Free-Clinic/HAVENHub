import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  LogTransport,
  GraphTransport,
  emailTransportFromConfig,
  type EmailMessage,
} from "./transport";
import type { AppConfig } from "../config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const msg: EmailMessage = {
  to: "volunteer@example.com",
  subject: "Test subject",
  html: "<p>Hello</p>",
};

/** Minimal AppConfig stub -- only the fields transport.ts cares about. */
function makeConfig(
  overrides: Partial<AppConfig> = {}
): AppConfig {
  return {
    DATABASE_URL: "postgresql://x:y@localhost/db",
    AUTH_SECRET: "secret",
    NODE_ENV: "development",
    AZURE_AD_CLIENT_ID: undefined,
    AZURE_AD_CLIENT_SECRET: undefined,
    AZURE_AD_TENANT_ID: undefined,
    AIRTABLE_PAT: undefined,
    HAVEN_MGMT_BASE_ID: "appkxTQ19GmaHgW1O",
    ALL_PEOPLE_TABLE_ID: "tblnHgBpknuqWvx9c",
    SU26_ROSTER_TABLE_ID: "tbl2VrP1uqwFt7QNQ",
    AIRTABLE_MIRROR_ENABLED: false,
    AIRTABLE_MIRROR_BASE_ID: undefined,
    AIRTABLE_MIRROR_PEOPLE_TABLE_ID: undefined,
    AIRTABLE_MIRROR_FIELD_MAP: undefined,
    AIRTABLE_MIRROR_HIPAA_FIELD_ID: undefined,
    AIRTABLE_MIRROR_STATUS_FIELD_ID: undefined,
    UPLOAD_DIR: "./uploads",
    MAX_UPLOAD_MB: 5,
    EMAIL_TRANSPORT: "log",
    GRAPH_OAUTH_TENANT_ID: undefined,
    GRAPH_OAUTH_CLIENT_ID: undefined,
    GRAPH_OAUTH_CLIENT_SECRET: undefined,
    GRAPH_OAUTH_REDIRECT_URI: "http://localhost:3000/admin/email/oauth/callback",
    EMAIL_SENDER: undefined,
    COMPLIANCE_REMINDER_INTERVAL_DAYS: 7,
    COMPLIANCE_ESCALATION_THRESHOLD: 3,
    ...overrides,
  } as AppConfig;
}

const fakeGetAccessToken = () => Promise.resolve("test-token");

// ---------------------------------------------------------------------------
// LogTransport
// ---------------------------------------------------------------------------

describe("LogTransport", () => {
  it("logs to console and resolves", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const transport = new LogTransport();
      await transport.send(msg);
      expect(spy).toHaveBeenCalledOnce();
      const [line] = spy.mock.calls[0];
      expect(line).toContain("volunteer@example.com");
      expect(line).toContain("Test subject");
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// GraphTransport
// ---------------------------------------------------------------------------

describe("GraphTransport", () => {
  it("sends to the correct Graph URL with the encoded sender", async () => {
    const sender = "hfc.it@yale.edu";
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));

    const transport = new GraphTransport({
      getAccessToken: fakeGetAccessToken,
      sender,
      fetchImpl: fetchMock as typeof fetch,
    });
    await transport.send(msg);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain(encodeURIComponent(sender));
    expect(String(url)).toContain("sendMail");
  });

  it("sends POST with Authorization Bearer token and correct JSON body", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));

    const transport = new GraphTransport({
      getAccessToken: fakeGetAccessToken,
      sender: "hfc.it@yale.edu",
      fetchImpl: fetchMock as typeof fetch,
    });
    await transport.send(msg);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method?.toUpperCase()).toBe("POST");

    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-token");

    const parsed = JSON.parse(String(init.body));
    expect(parsed.message.subject).toBe(msg.subject);
    expect(parsed.message.body.contentType).toBe("HTML");
    expect(parsed.message.body.content).toBe(msg.html);
    expect(parsed.message.toRecipients[0].emailAddress.address).toBe(msg.to);
    expect(parsed.saveToSentItems).toBe(true);
  });

  it("throws with status and response text on non-2xx, without exposing the token", async () => {
    const fetchMock = vi.fn(
      async () => new Response("denied", { status: 403 })
    );

    const transport = new GraphTransport({
      getAccessToken: fakeGetAccessToken,
      sender: "hfc.it@yale.edu",
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(transport.send(msg)).rejects.toThrow(/403/);
    await expect(transport.send(msg)).rejects.toThrow(/denied/);
    // The token must not appear in the error message.
    try {
      await transport.send(msg);
    } catch (err) {
      expect(String(err)).not.toContain("test-token");
    }
  });

  it("rejects without calling fetch when getAccessToken throws", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));

    const transport = new GraphTransport({
      getAccessToken: () => Promise.reject(new Error("no credential")),
      sender: "hfc.it@yale.edu",
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(transport.send(msg)).rejects.toThrow("no credential");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// emailTransportFromConfig
// ---------------------------------------------------------------------------

describe("emailTransportFromConfig", () => {
  it("returns a LogTransport when EMAIL_TRANSPORT is log", () => {
    const transport = emailTransportFromConfig(makeConfig({ EMAIL_TRANSPORT: "log" }));
    expect(transport).toBeInstanceOf(LogTransport);
  });

  it("returns a GraphTransport when EMAIL_TRANSPORT is graph with EMAIL_SENDER set", () => {
    const transport = emailTransportFromConfig(
      makeConfig({
        EMAIL_TRANSPORT: "graph",
        GRAPH_OAUTH_TENANT_ID: "t",
        GRAPH_OAUTH_CLIENT_ID: "c",
        GRAPH_OAUTH_CLIENT_SECRET: "s",
        EMAIL_SENDER: "noreply@example.com",
      })
    );
    expect(transport).toBeInstanceOf(GraphTransport);
  });
});
