import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pushTicketNumber, pushTicketState, INTERCOM_TICKET_WRITE_TIMEOUT_MS } from "./tickets";

function mockFetchOnce(status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({}),
    })
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("INTERCOM_ACCESS_TOKEN", "access-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("pushTicketNumber", () => {
  it("PUTs the Hub ticket number onto the ticket's attribute namespace", async () => {
    mockFetchOnce(200);

    const result = await pushTicketNumber("ticket_1", 42);

    expect(result).toBe(true);
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/tickets/ticket_1");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ ticket_attributes: { "Hub ticket number": 42 } });
  });

  it("pins an explicit Intercom-Version header rather than trusting the workspace default", async () => {
    mockFetchOnce(200);

    await pushTicketNumber("ticket_1", 42);

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Intercom-Version"]).toBe("2.14");
  });

  it("fails closed (returns false, does not throw) on a non-2xx response", async () => {
    mockFetchOnce(422);

    const result = await pushTicketNumber("ticket_1", 42);

    expect(result).toBe(false);
  });

  it("fails closed when the network throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await pushTicketNumber("ticket_1", 42);

    expect(result).toBe(false);
  });

  it("fails closed when no access token is configured", async () => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "");
    vi.stubGlobal("fetch", vi.fn());

    const result = await pushTicketNumber("ticket_1", 42);

    expect(result).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  /** Same simulation approach as identity.test.ts's and conversations.test.ts's timeout tests. */
  it("fails closed when the fetch times out", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      )
    );

    const pending = pushTicketNumber("ticket_1", 42);
    await vi.advanceTimersByTimeAsync(INTERCOM_TICKET_WRITE_TIMEOUT_MS);
    const result = await pending;

    expect(result).toBe(false);
    vi.useRealTimers();
  });
});

describe("pushTicketState", () => {
  it("PUTs the new state onto the ticket", async () => {
    mockFetchOnce(200);

    const result = await pushTicketState("ticket_1", "In progress");

    expect(result).toBe(true);
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/tickets/ticket_1");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ state: "In progress" });
  });

  it("pins an explicit Intercom-Version header rather than trusting the workspace default", async () => {
    mockFetchOnce(200);

    await pushTicketState("ticket_1", "In progress");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Intercom-Version"]).toBe("2.14");
  });

  it("fails closed (returns false, does not throw) on a non-2xx response", async () => {
    mockFetchOnce(422);

    const result = await pushTicketState("ticket_1", "In progress");

    expect(result).toBe(false);
  });

  it("fails closed when the network throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await pushTicketState("ticket_1", "In progress");

    expect(result).toBe(false);
  });

  it("fails closed when no access token is configured", async () => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "");
    vi.stubGlobal("fetch", vi.fn());

    const result = await pushTicketState("ticket_1", "In progress");

    expect(result).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  /** Same simulation approach as pushTicketNumber's timeout test above. */
  it("fails closed when the fetch times out", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      )
    );

    const pending = pushTicketState("ticket_1", "In progress");
    await vi.advanceTimersByTimeAsync(INTERCOM_TICKET_WRITE_TIMEOUT_MS);
    const result = await pending;

    expect(result).toBe(false);
    vi.useRealTimers();
  });
});
