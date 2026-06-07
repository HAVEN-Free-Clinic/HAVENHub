import {
  afterEach,
  beforeEach,
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
    GRAPH_TENANT_ID: undefined,
    GRAPH_CLIENT_ID: undefined,
    GRAPH_CLIENT_SECRET: undefined,
    EMAIL_SENDER: undefined,
    ...overrides,
  } as AppConfig;
}

/** Build a fetch mock that returns the token response on the first call and
 *  a 202 (no body) on subsequent calls (Graph sendMail returns 202). */
function makeFetchMock(opts: {
  tokenPayload?: object;
  sendStatus?: number;
  sendBody?: string;
} = {}) {
  const {
    tokenPayload = {
      access_token: "tok-abc",
      token_type: "Bearer",
      expires_in: 3600,
    },
    sendStatus = 202,
    sendBody = "",
  } = opts;

  let callCount = 0;
  return vi.fn(async (_url: string | Request, _init?: RequestInit) => {
    callCount += 1;
    if (callCount === 1) {
      // First call is always the token request.
      return new Response(JSON.stringify(tokenPayload), { status: 200 });
    }
    // Subsequent calls are sendMail requests.
    return new Response(sendBody, { status: sendStatus });
  });
}

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

const graphOpts = {
  tenantId: "tenant-abc",
  clientId: "client-abc",
  clientSecret: "secret-abc",
  sender: "noreply@haven.edu",
};

describe("GraphTransport", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = makeFetchMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a token request to the correct tenant URL", async () => {
    const transport = new GraphTransport({ ...graphOpts, fetchImpl: fetchMock as typeof fetch });
    await transport.send(msg);

    const [tokenUrl] = fetchMock.mock.calls[0];
    expect(String(tokenUrl)).toContain("tenant-abc");
    expect(String(tokenUrl)).toContain("oauth2/v2.0/token");
  });

  it("sends the token request with the correct form body fields", async () => {
    const transport = new GraphTransport({ ...graphOpts, fetchImpl: fetchMock as typeof fetch });
    await transport.send(msg);

    const [, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenInit.method?.toUpperCase()).toBe("POST");
    const body = String(tokenInit.body);
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain("client_id=client-abc");
    expect(body).toContain("client_secret=secret-abc");
    expect(body).toContain(encodeURIComponent("https://graph.microsoft.com/.default"));
  });

  it("sends the sendMail request to the correct Graph URL with the sender", async () => {
    const transport = new GraphTransport({ ...graphOpts, fetchImpl: fetchMock as typeof fetch });
    await transport.send(msg);

    const [sendUrl] = fetchMock.mock.calls[1];
    expect(String(sendUrl)).toContain(encodeURIComponent("noreply@haven.edu"));
    expect(String(sendUrl)).toContain("sendMail");
  });

  it("sends the correct JSON body to Graph sendMail", async () => {
    const transport = new GraphTransport({ ...graphOpts, fetchImpl: fetchMock as typeof fetch });
    await transport.send(msg);

    const [, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(sendInit.method?.toUpperCase()).toBe("POST");

    const parsed = JSON.parse(String(sendInit.body));
    expect(parsed.message.subject).toBe(msg.subject);
    expect(parsed.message.body.contentType).toBe("HTML");
    expect(parsed.message.body.content).toBe(msg.html);
    expect(parsed.message.toRecipients[0].emailAddress.address).toBe(msg.to);
    expect(parsed.saveToSentItems).toBe(true);
  });

  it("includes the Bearer token in the Authorization header", async () => {
    const transport = new GraphTransport({ ...graphOpts, fetchImpl: fetchMock as typeof fetch });
    await transport.send(msg);

    const [, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = new Headers(sendInit.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok-abc");
  });

  it("reuses the cached token across two sends (token endpoint called once)", async () => {
    const transport = new GraphTransport({ ...graphOpts, fetchImpl: fetchMock as typeof fetch });
    await transport.send(msg);
    await transport.send(msg);

    // token call = 1, sendMail calls = 2, total = 3
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [tokenUrl] = fetchMock.mock.calls[0];
    // Confirm the first call was the token endpoint, not sendMail.
    expect(String(tokenUrl)).toContain("oauth2/v2.0/token");
  });

  it("re-fetches the token after it expires", async () => {
    vi.useFakeTimers();
    try {
      // Token expires_in=3600; cache window is (3600-60)*1000 = 3,540,000 ms.
      let tokenCallCount = 0;
      const timerFetch = vi.fn(async (_url: string | Request, _init?: RequestInit) => {
        const url = String(_url);
        if (url.includes("oauth2")) {
          tokenCallCount += 1;
          return new Response(
            JSON.stringify({ access_token: "tok-timer", token_type: "Bearer", expires_in: 3600 }),
            { status: 200 }
          );
        }
        return new Response("", { status: 202 });
      });

      const transport = new GraphTransport({ ...graphOpts, fetchImpl: timerFetch as typeof fetch });

      // First send: fetches the token (tokenCallCount -> 1).
      await transport.send(msg);
      expect(tokenCallCount).toBe(1);

      // Second send immediately after: token is still valid, no new fetch.
      await transport.send(msg);
      expect(tokenCallCount).toBe(1);

      // Advance past the cache expiry window (3540 seconds = 3,540,000 ms).
      vi.advanceTimersByTime((3600 - 60) * 1000 + 1);

      // Third send: token has expired, must re-fetch (tokenCallCount -> 2).
      await transport.send(msg);
      expect(tokenCallCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws with the HTTP status when the token request fails", async () => {
    const failFetch = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    const transport = new GraphTransport({ ...graphOpts, fetchImpl: failFetch as typeof fetch });
    await expect(transport.send(msg)).rejects.toThrow(/401/);
  });

  it("throws with the HTTP status when the sendMail request fails", async () => {
    const failSendFetch = makeFetchMock({ sendStatus: 403, sendBody: "Forbidden" });
    const transport = new GraphTransport({ ...graphOpts, fetchImpl: failSendFetch as typeof fetch });
    await expect(transport.send(msg)).rejects.toThrow(/403/);
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

  it("returns a GraphTransport when EMAIL_TRANSPORT is graph", () => {
    const transport = emailTransportFromConfig(
      makeConfig({
        EMAIL_TRANSPORT: "graph",
        GRAPH_TENANT_ID: "t",
        GRAPH_CLIENT_ID: "c",
        GRAPH_CLIENT_SECRET: "s",
        EMAIL_SENDER: "noreply@example.com",
      })
    );
    expect(transport).toBeInstanceOf(GraphTransport);
  });
});
