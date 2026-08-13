import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  pushTicketNumber,
  pushTicketState,
  fetchTicketState,
  extractTicketStateInternalLabel,
  normalizeTicketStateLabel,
  resetTicketStateCache,
  INTERCOM_TICKET_WRITE_TIMEOUT_MS,
  INTERCOM_TICKET_READ_TIMEOUT_MS,
} from "./tickets";

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
  // The label -> state id map is module-level and survives between cases by
  // design (see TICKET_STATE_CACHE_TTL_MS), so it has to be cleared here or one
  // test's workspace fixture would answer another's lookup.
  resetTicketStateCache();
});

describe("normalizeTicketStateLabel", () => {
  it("folds case, surrounding space, and a typographic apostrophe", () => {
    expect(normalizeTicketStateLabel("  Won’t Fix ")).toBe("won't fix");
    expect(normalizeTicketStateLabel("Won't fix")).toBe("won't fix");
  });
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
  /**
   * The workspace's real state list, trimmed to the fields this code reads
   * (GET /ticket_states on 2026-08-13). From API 2.12 the update-ticket
   * endpoint takes `ticket_state_id`, not the `state` label the code used to
   * send, so every push now resolves the label through this list first.
   */
  const TICKET_STATES = [
    { type: "ticket_state", id: "4706543", category: "submitted", internal_label: "Submitted", archived: false },
    { type: "ticket_state", id: "4706544", category: "in_progress", internal_label: "In progress", archived: false },
    { type: "ticket_state", id: "4706546", category: "resolved", internal_label: "Resolved", archived: false },
    { type: "ticket_state", id: "4706550", category: "resolved", internal_label: "Won't fix", archived: false },
  ];

  /** GET /ticket_states answers first, then PUT /tickets/{id} with `putStatus`. */
  function mockStateListThen(putStatus: number, states: unknown[] = TICKET_STATES) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ type: "list", data: states }) });
      }
      return Promise.resolve({
        ok: putStatus >= 200 && putStatus < 300,
        status: putStatus,
        json: async () => ({}),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function putCall(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT") as [
      string,
      RequestInit,
    ];
  }

  beforeEach(() => {
    resetTicketStateCache();
  });

  it("resolves the label to a state id and PUTs that id onto the ticket", async () => {
    const fetchMock = mockStateListThen(200);

    const result = await pushTicketState("ticket_1", "In progress");

    expect(result).toBe(true);
    const [url, init] = putCall(fetchMock);
    expect(url).toContain("/tickets/ticket_1");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // NOT { state: "In progress" }: that key is a pre-2.12 contract, and 2.12+
    // ignores unrecognized body properties rather than rejecting them, so
    // sending it returned 200 while the ticket's state never moved.
    expect(body).toEqual({ ticket_state_id: "4706544" });
  });

  it("matches on the label, not the category, so two states sharing one category stay distinct", async () => {
    const fetchMock = mockStateListThen(200);

    await pushTicketState("ticket_1", "Won't fix");

    const body = JSON.parse(putCall(fetchMock)[1].body as string) as Record<string, unknown>;
    expect(body).toEqual({ ticket_state_id: "4706550" });
  });

  it("folds a typographic apostrophe, so an edited label still matches", async () => {
    const fetchMock = mockStateListThen(200, [
      { type: "ticket_state", id: "4706550", category: "resolved", internal_label: "Won’t fix", archived: false },
    ]);

    const result = await pushTicketState("ticket_1", "Won't fix");

    expect(result).toBe(true);
    const body = JSON.parse(putCall(fetchMock)[1].body as string) as Record<string, unknown>;
    expect(body).toEqual({ ticket_state_id: "4706550" });
  });

  it("skips an archived state that shadows a live one with the same label", async () => {
    const fetchMock = mockStateListThen(200, [
      { type: "ticket_state", id: "old-resolved", category: "resolved", internal_label: "Resolved", archived: true },
      { type: "ticket_state", id: "4706546", category: "resolved", internal_label: "Resolved", archived: false },
    ]);

    await pushTicketState("ticket_1", "Resolved");

    const body = JSON.parse(putCall(fetchMock)[1].body as string) as Record<string, unknown>;
    expect(body).toEqual({ ticket_state_id: "4706546" });
  });

  it("reuses the resolved state list across pushes rather than re-fetching it", async () => {
    const fetchMock = mockStateListThen(200);

    await pushTicketState("ticket_1", "In progress");
    await pushTicketState("ticket_2", "Resolved");

    const listCalls = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== "PUT");
    expect(listCalls).toHaveLength(1);
  });

  // A rejected id is the one signal available that the cached map describes a
  // workspace that has moved on, so the next push must re-resolve rather than
  // re-send the same dead id for the rest of the TTL.
  it("drops the cached state list when Intercom rejects the write", async () => {
    const fetchMock = mockStateListThen(422);

    await pushTicketState("ticket_1", "In progress");
    await pushTicketState("ticket_1", "In progress");

    const listCalls = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== "PUT");
    expect(listCalls).toHaveLength(2);
  });

  // Refuses rather than falling back to a nearest state, exactly as the inbound
  // half refuses a label it cannot map.
  it("fails closed, without writing, when the workspace has no state by that label", async () => {
    const fetchMock = mockStateListThen(200);

    const result = await pushTicketState("ticket_1", "Some Brand New State");

    expect(result).toBe(false);
    expect(putCall(fetchMock)).toBeUndefined();
  });

  it("fails closed, without writing, when the state list cannot be read", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pushTicketState("ticket_1", "In progress");

    expect(result).toBe(false);
    expect(putCall(fetchMock)).toBeUndefined();
  });

  it("pins an explicit Intercom-Version header rather than trusting the workspace default", async () => {
    const fetchMock = mockStateListThen(200);

    await pushTicketState("ticket_1", "In progress");

    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>)["Intercom-Version"]).toBe("2.14");
    }
  });

  it("fails closed (returns false, does not throw) on a non-2xx response", async () => {
    mockStateListThen(422);

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
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        if ((init.method ?? "GET") === "GET") {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ type: "list", data: TICKET_STATES }) });
        }
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      })
    );

    const pending = pushTicketState("ticket_1", "In progress");
    await vi.advanceTimersByTimeAsync(INTERCOM_TICKET_WRITE_TIMEOUT_MS);
    const result = await pending;

    expect(result).toBe(false);
    vi.useRealTimers();
  });
});

/**
 * Both serializations Intercom uses, captured from the live workspace on
 * 2026-08-13 by fetching one ticket at each API version. 2.12 dropped the flat
 * `ticket_state_internal_label` key in favour of a nested `ticket_state`
 * object, and every reader here was written against the flat one while the
 * module pins 2.14 -- so fetchTicketState returned null for every ticket, which
 * the reconciliation cron reads as "Intercom unreachable" and skips.
 */
describe("extractTicketStateInternalLabel", () => {
  it("reads the nested 2.12+ shape", () => {
    expect(
      extractTicketStateInternalLabel({
        ticket_state: {
          type: "ticket_state",
          id: "4706546",
          category: "resolved",
          internal_label: "Resolved",
          external_label: "Resolved",
        },
      })
    ).toBe("Resolved");
  });

  it("reads the pre-2.12 flat shape", () => {
    expect(
      extractTicketStateInternalLabel({
        ticket_state: "resolved",
        ticket_state_internal_label: "Resolved",
        ticket_state_external_label: "Resolved",
      })
    ).toBe("Resolved");
  });

  it("prefers the internal label over the member-facing external one", () => {
    expect(
      extractTicketStateInternalLabel({
        ticket_state: { internal_label: "Waiting on YNHH ITS", external_label: "Waiting on YNHH Collaboration" },
      })
    ).toBe("Waiting on YNHH ITS");
  });

  // The category is not the label: "Resolved", "Won't fix", and "Cancelled" all
  // report category `resolved` in this workspace while mapping to three
  // different Hub statuses. Mapping one would be the nearest-match guess
  // intercom-sync.ts refuses to make, so this must read as "no label".
  it("returns null for a bare-string state category, rather than guessing", () => {
    expect(extractTicketStateInternalLabel({ ticket_state: "resolved" })).toBeNull();
  });

  it("returns null for an empty or missing label, and for a non-object", () => {
    expect(extractTicketStateInternalLabel({ ticket_state: { internal_label: "  " } })).toBeNull();
    expect(extractTicketStateInternalLabel({ ticket_state: {} })).toBeNull();
    expect(extractTicketStateInternalLabel({})).toBeNull();
    expect(extractTicketStateInternalLabel(null)).toBeNull();
    expect(extractTicketStateInternalLabel("resolved")).toBeNull();
  });
});

describe("fetchTicketState", () => {
  function mockFetchOnceWithLabel(label: string | null) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => (label === null ? {} : { ticket_state: { internal_label: label } }),
      })
    );
  }

  it("GETs the ticket and returns its internal state label", async () => {
    mockFetchOnceWithLabel("In progress");

    const result = await fetchTicketState("ticket_1");

    expect(result).toBe("In progress");
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/tickets/ticket_1");
    expect(init.method).toBe("GET");
  });

  it("pins an explicit Intercom-Version header rather than trusting the workspace default", async () => {
    mockFetchOnceWithLabel("In progress");

    await fetchTicketState("ticket_1");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Intercom-Version"]).toBe("2.14");
  });

  it("returns null when the response has no label at all", async () => {
    mockFetchOnceWithLabel(null);

    const result = await fetchTicketState("ticket_1");

    expect(result).toBeNull();
  });

  it("fails closed (returns null, does not throw) on a non-2xx response", async () => {
    mockFetchOnce(422);

    const result = await fetchTicketState("ticket_1");

    expect(result).toBeNull();
  });

  it("fails closed when the network throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await fetchTicketState("ticket_1");

    expect(result).toBeNull();
  });

  it("fails closed when no access token is configured", async () => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "");
    vi.stubGlobal("fetch", vi.fn());

    const result = await fetchTicketState("ticket_1");

    expect(result).toBeNull();
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

    const pending = fetchTicketState("ticket_1");
    await vi.advanceTimersByTimeAsync(INTERCOM_TICKET_READ_TIMEOUT_MS);
    const result = await pending;

    expect(result).toBeNull();
    vi.useRealTimers();
  });
});
