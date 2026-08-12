import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { postConversationNote, INTERCOM_REPLY_TIMEOUT_MS } from "./conversations";

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
  vi.stubEnv("INTERCOM_BOT_ADMIN_ID", "admin-1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("postConversationNote", () => {
  /**
   * message_type is the single string separating an internal annotation from
   * publishing Hub data to the member, so it is asserted exactly rather than
   * loosely. Everything crossing this boundary is assembled from database
   * records; "note" keeps a formatting mistake or an unexpected field visible
   * to the agent working the ticket instead of to the customer.
   */
  it("posts a staff-only note, never a customer-visible comment", async () => {
    mockFetchOnce(200);

    const result = await postConversationNote("conv_1", "Status is now In progress.");

    expect(result).toBe(true);
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/conversations/conv_1/reply");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      message_type: "note",
      type: "admin",
      admin_id: "admin-1",
      body: "Status is now In progress.",
    });
    expect(body.message_type).not.toBe("comment");
  });

  it("pins an explicit Intercom-Version header rather than trusting the workspace default", async () => {
    mockFetchOnce(200);

    await postConversationNote("conv_1", "hi");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Intercom-Version"]).toBe("2.14");
  });

  it("fails closed (returns false, does not throw) on a non-2xx response", async () => {
    mockFetchOnce(422);

    const result = await postConversationNote("conv_1", "hi");

    expect(result).toBe(false);
  });

  it("fails closed when the network throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await postConversationNote("conv_1", "hi");

    expect(result).toBe(false);
  });

  it("fails closed when no access token is configured", async () => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "");
    vi.stubGlobal("fetch", vi.fn());

    const result = await postConversationNote("conv_1", "hi");

    expect(result).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when no bot admin id is configured", async () => {
    vi.stubEnv("INTERCOM_BOT_ADMIN_ID", "");
    vi.stubGlobal("fetch", vi.fn());

    const result = await postConversationNote("conv_1", "hi");

    expect(result).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  /** Same simulation approach as identity.test.ts's timeout tests: a fetch that only settles on abort. */
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

    const pending = postConversationNote("conv_1", "hi");
    await vi.advanceTimersByTimeAsync(INTERCOM_REPLY_TIMEOUT_MS);
    const result = await pending;

    expect(result).toBe(false);
    vi.useRealTimers();
  });
});
