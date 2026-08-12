import { describe, expect, it, vi } from "vitest";
import {
  probeContentBlocker,
  CONTROL_URL,
  PROBE_TIMEOUT_MS,
  TOKEN_URL,
  type ProbeDeps,
} from "./blocker-probe";

const APP_ID = "abc123";

/**
 * Maps a URL substring to an outcome: a status number resolves with that
 * status, "reject" throws the way a blocked request does. Anything unmatched
 * resolves 200.
 */
function stub(map: Record<string, number | "reject">) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(map).find((k) => url.includes(k));
    const outcome = key ? map[key] : 200;
    if (outcome === "reject") throw new TypeError("Failed to fetch");
    return new Response(null, { status: outcome });
  });
}

function deps(fetchImpl: ReturnType<typeof stub>, onLine = true): ProbeDeps {
  // delay resolves immediately: the retry timing is not what these assert.
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, onLine: () => onLine, delay: async () => {} };
}

describe("probeContentBlocker", () => {
  it("does not gate when the control probe is unreachable, because that is a network fault", async () => {
    // Everything fails, which is what being offline mid-flight looks like.
    const result = await probeContentBlocker(APP_ID, deps(stub({ "haven-mark": "reject", "messenger-token": "reject", "widget.intercom.io": "reject" })));
    expect(result).toEqual({ blocked: false });
  });

  it("does not gate when the token route 404s, because the integration is switched off", async () => {
    const result = await probeContentBlocker(APP_ID, deps(stub({ "messenger-token": 404 })));
    expect(result).toEqual({ blocked: false });
  });

  it("does not gate on a 401, because a response proves the request left the browser", async () => {
    const result = await probeContentBlocker(APP_ID, deps(stub({ "messenger-token": 401 })));
    expect(result).toEqual({ blocked: false });
  });

  it("does not gate on a 503, because a server outage is not a content blocker", async () => {
    const result = await probeContentBlocker(APP_ID, deps(stub({ "messenger-token": 503 })));
    expect(result).toEqual({ blocked: false });
  });

  it("gates when the token route is blocked but the control gets through", async () => {
    const result = await probeContentBlocker(APP_ID, deps(stub({ "messenger-token": "reject" })));
    expect(result).toEqual({ blocked: true, failed: ["token"] });
  });

  it("gates when the Messenger widget host is blocked", async () => {
    const result = await probeContentBlocker(APP_ID, deps(stub({ "widget.intercom.io": "reject" })));
    expect(result).toEqual({ blocked: true, failed: ["widget"] });
  });

  it("reports both halves when both are blocked", async () => {
    const result = await probeContentBlocker(APP_ID, deps(stub({ "messenger-token": "reject", "widget.intercom.io": "reject" })));
    expect(result).toEqual({ blocked: true, failed: ["token", "widget"] });
  });

  it("does not gate when a single rejection clears on the retry", async () => {
    let tokenCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("messenger-token")) {
        tokenCalls += 1;
        if (tokenCalls === 1) throw new TypeError("Failed to fetch");
      }
      return new Response(null, { status: 200 });
    });
    const result = await probeContentBlocker(APP_ID, deps(fetchImpl as ReturnType<typeof stub>));
    expect(result).toEqual({ blocked: false });
    expect(tokenCalls).toBe(2);
  });

  it("does not gate when the network drops between the first attempt and the retry", async () => {
    let controlCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("haven-mark")) {
        controlCalls += 1;
        // Reachable first time round, gone by the retry.
        if (controlCalls > 1) throw new TypeError("Failed to fetch");
        return new Response(null, { status: 200 });
      }
      if (url.includes("messenger-token")) throw new TypeError("Failed to fetch");
      return new Response(null, { status: 200 });
    });
    const result = await probeContentBlocker(APP_ID, deps(fetchImpl as ReturnType<typeof stub>));
    expect(result).toEqual({ blocked: false });
  });

  it("does not probe at all when the browser reports it is offline", async () => {
    const fetchImpl = stub({});
    const result = await probeContentBlocker(APP_ID, deps(fetchImpl, false));
    expect(result).toEqual({ blocked: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not gate when a probe times out, because a slow network is not a blocker", async () => {
    vi.useFakeTimers();
    try {
      // A firewall that DROPS rather than rejects: no response, no rejection,
      // just silence until something gives up. Only our own deadline ever does.
      const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).includes("messenger-token")) {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });

      const pending = probeContentBlocker(APP_ID, deps(fetchImpl as unknown as ReturnType<typeof stub>));
      // Enough for the retry's deadline too, so a regression that reads a
      // timeout as a block fails this on the assertion rather than by hanging.
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS * 3);

      // The point of the deadline is the disabled button behind it, not the
      // verdict: the verdict must stay "no gate" however long the wait was.
      expect(await pending).toEqual({ blocked: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests the control and token URLs it documents", async () => {
    const fetchImpl = stub({});
    await probeContentBlocker(APP_ID, deps(fetchImpl));
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(CONTROL_URL);
    expect(urls).toContain(TOKEN_URL);
    expect(urls.some((u) => u.includes(APP_ID))).toBe(true);
  });
});
