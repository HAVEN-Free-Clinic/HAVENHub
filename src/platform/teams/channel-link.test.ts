import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  selectCurrentClinicDate,
  formatClinicDate,
  matchChannel,
  getCurrentClinicChannelLink,
  __resetChannelCache,
  GRAPH_TOTAL_BUDGET_MS,
  type ClinicChannelLink,
} from "./channel-link";

// Clinic dates are anchored at 12:00 UTC like Term.clinicDates.
function clinic(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

const dates = [clinic(2026, 6, 6), clinic(2026, 6, 13), clinic(2026, 6, 20)];

describe("selectCurrentClinicDate", () => {
  it("picks the upcoming clinic mid-week (Mon)", () => {
    // Mon 2026-06-08 12:00 UTC -> upcoming is Sat 06-13.
    const now = new Date(Date.UTC(2026, 5, 8, 12, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toEqual(clinic(2026, 6, 13));
  });

  it("still shows that day's clinic on the clinic Saturday", () => {
    // Sat 2026-06-13 18:00 UTC = 14:00 ET, same NY calendar day.
    const now = new Date(Date.UTC(2026, 5, 13, 18, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toEqual(clinic(2026, 6, 13));
  });

  it("rolls to the next clinic once it is Sunday in New_York", () => {
    // Sun 2026-06-14 05:00 UTC = Sun 01:00 ET -> 06-13 is past, pick 06-20.
    const now = new Date(Date.UTC(2026, 5, 14, 5, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toEqual(clinic(2026, 6, 20));
  });

  it("does NOT roll while it is still Saturday night in New_York", () => {
    // Sun 2026-06-14 03:00 UTC = Sat 23:00 ET -> still 06-13.
    const now = new Date(Date.UTC(2026, 5, 14, 3, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toEqual(clinic(2026, 6, 13));
  });

  it("returns null when all clinic dates are past", () => {
    const now = new Date(Date.UTC(2026, 6, 1, 12, 0, 0));
    expect(selectCurrentClinicDate(dates, now)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(selectCurrentClinicDate([], new Date())).toBeNull();
  });

  it("returns today's clinic when now equals the clinic instant", () => {
    // now == the 06-13 clinic instant (12:00 UTC) -> NY dates equal -> 06-13.
    const now = clinic(2026, 6, 13);
    expect(selectCurrentClinicDate(dates, now)).toEqual(clinic(2026, 6, 13));
  });
});

describe("formatClinicDate", () => {
  it("formats as zero-padded MM-DD-YY", () => {
    expect(formatClinicDate(clinic(2026, 6, 13))).toBe("06-13-26");
  });

  it("zero-pads single-digit month and day", () => {
    expect(formatClinicDate(clinic(2026, 1, 3))).toBe("01-03-26");
  });
});

describe("matchChannel", () => {
  const channels = [
    { id: "1", displayName: "General", webUrl: "https://x/general" },
    { id: "2", displayName: "06-13-26 Clinic", webUrl: "https://x/0613" },
    { id: "3", displayName: "06-20-26 Clinic", webUrl: "https://x/0620" },
  ];

  it("matches the channel whose name starts with the date string", () => {
    expect(matchChannel(channels, "06-13-26")?.id).toBe("2");
  });

  it("is case- and whitespace-tolerant", () => {
    const odd = [{ id: "9", displayName: "  06-13-26 clinic ", webUrl: "u" }];
    expect(matchChannel(odd, "06-13-26")?.id).toBe("9");
  });

  it("returns null when no channel matches", () => {
    expect(matchChannel(channels, "07-04-26")).toBeNull();
  });
});

/**
 * In-memory stand-in for the durable last-known-good store, so the resolver
 * tests exercise the fallback without touching the database.
 */
function memLastGood() {
  const rows = new Map<string, ClinicChannelLink>();
  // In-memory twin of the two durable Setting rows the resolver keeps: the
  // last-known-good link and the consecutive-failure counter. Both are injected
  // so these tests never touch the database.
  let failure: { count: number; at: string } | null = null;
  return {
    loadLastGood: async (g: string, d: string) => rows.get(`${g}|${d}`) ?? null,
    saveLastGood: async (g: string, d: string, link: ClinicChannelLink) => {
      rows.set(`${g}|${d}`, link);
    },
    clearLastGood: async (g: string, d: string) => {
      rows.delete(`${g}|${d}`);
    },
    loadFailure: async () => failure,
    recordFailure: async (at: Date) => {
      failure = { count: (failure?.count ?? 0) + 1, at: at.toISOString() };
    },
    clearFailure: async () => {
      failure = null;
    },
    // A mailbox consented with the channel scope: the resolver proceeds to Graph.
    loadScope: async () =>
      "https://graph.microsoft.com/Channel.ReadBasic.All",
  };
}

let lastGood: ReturnType<typeof memLastGood>;

beforeEach(() => {
  __resetChannelCache();
  lastGood = memLastGood();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("getCurrentClinicChannelLink", () => {
  const groupId = "4796e633-27e4-4053-8631-d3b4fe64ebe6";
  const now = new Date(Date.UTC(2026, 5, 8, 12, 0, 0)); // Mon -> upcoming 06-13
  const clinicDates = [clinic(2026, 6, 6), clinic(2026, 6, 13), clinic(2026, 6, 20)];

  function okChannelsFetch() {
    return vi.fn(async () =>
      new Response(
        JSON.stringify({
          value: [
            { id: "1", displayName: "General", webUrl: "https://x/general" },
            { id: "2", displayName: "06-13-26 Clinic", webUrl: "https://x/0613" },
          ],
        }),
        { status: 200 }
      )
    );
  }

  it("returns the matched channel's webUrl for the current week", async () => {
    const fetchImpl = okChannelsFetch();
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId,
      loadClinicDates: async () => clinicDates,
      ...lastGood,
});
    expect(result).toEqual<ClinicChannelLink>({
      webUrl: "https://x/0613",
      displayName: "06-13-26 Clinic",
      clinicDate: clinic(2026, 6, 13),
    });
    const firstCall = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const init = firstCall[1];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok"
    );
  });

  // The root cause of the production outage. Without $select, Graph populates
  // each channel's `email`, which Microsoft documents as an expensive operation;
  // on a Team that gains a channel every clinic week that cost pushed every list
  // call past the 8s budget, so the resolve never once succeeded and the
  // last-known-good fallback was never seeded either.
  it("lists channels with $select so Graph skips the slow email field", async () => {
    const fetchImpl = okChannelsFetch();
    await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId,
      loadClinicDates: async () => clinicDates,
      ...lastGood,
    });
    const url = (fetchImpl.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("$select=id,displayName,webUrl");
    expect(url).not.toContain("email");
  });

  it("returns null when groupId is unset (no Graph call)", async () => {
    const fetchImpl = vi.fn();
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId: undefined,
      loadClinicDates: async () => clinicDates,
      ...lastGood,
});
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when there is no active term / no clinic dates", async () => {
    const fetchImpl = vi.fn();
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId,
      loadClinicDates: async () => null,
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when no channel matches the current week", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ value: [{ id: "1", displayName: "General", webUrl: "u" }] }), {
        status: 200,
      })
    );
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId,
      loadClinicDates: async () => clinicDates,
      ...lastGood,
});
    expect(result).toBeNull();
  });

  it("returns null (never throws) on a non-2xx Graph response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId,
      loadClinicDates: async () => clinicDates,
      ...lastGood,
});
    expect(result).toBeNull();
  });

  // The current production failure: the connected mailbox was consented without
  // Channel.ReadBasic.All, so every list call 403s. The resolver must skip the
  // doomed token + Graph round trip and degrade to null, without the counted
  // `error` line, rather than paying for a call it knows will be forbidden.
  it("skips Graph and hides the card when the channel scope is not granted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn();
    const getToken = vi.fn(async () => "tok");
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken,
      now,
      groupId,
      loadClinicDates: async () => clinicDates,
      ...lastGood,
      loadScope: async () => "https://graph.microsoft.com/Mail.Send",
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it("still calls Graph when the granted scope is unknown (null)", async () => {
    const fetchImpl = okChannelsFetch();
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId,
      loadClinicDates: async () => clinicDates,
      ...lastGood,
      loadScope: async () => null,
    });
    expect(result?.webUrl).toBe("https://x/0613");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns null (never throws) when the token getter throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn();
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => {
        throw new Error("MailNotConnected");
      },
      now,
      groupId,
      loadClinicDates: async () => clinicDates,
      ...lastGood,
});
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caches within the TTL: a second call does not re-fetch", async () => {
    const fetchImpl = okChannelsFetch();
    const deps = {
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId,
      loadClinicDates: async () => clinicDates,
      ...lastGood,
};
    await getCurrentClinicChannelLink(deps);
    await getCurrentClinicChannelLink(deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-resolves within the same week when the clinic group id changes (#138)", async () => {
    const fetchImpl = okChannelsFetch();
    const base = { fetchImpl, getToken: async () => "tok", now, loadClinicDates: async () => clinicDates, ...lastGood };
    // Warm the cache against the original group id for this clinic week.
    await getCurrentClinicChannelLink({ ...base, groupId });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The admin repoints the clinic at a NEW Teams team (same clinic week). The
    // warm entry must NOT be served: group id is part of the cache key now, so a
    // fresh Graph call resolves the new team's channel.
    const newGroupId = "00000000-1111-2222-3333-444444444444";
    await getCurrentClinicChannelLink({ ...base, groupId: newGroupId });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondCall = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(secondCall[0]).toContain(newGroupId);
  });

  it("keeps a found link cached for the week (well past the old 30-min TTL)", async () => {
    const fetchImpl = okChannelsFetch();
    const base = { fetchImpl, getToken: async () => "tok", groupId, loadClinicDates: async () => clinicDates, ...lastGood };
    await getCurrentClinicChannelLink({ ...base, now });
    // Two hours later, same clinic week: still served from cache, no Graph call.
    await getCurrentClinicChannelLink({ ...base, now: new Date(now.getTime() + 2 * 60 * 60 * 1000) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a null result after the short miss window", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ value: [{ id: "1", displayName: "General", webUrl: "u" }] }), { status: 200 })
    );
    const base = { fetchImpl, getToken: async () => "tok", groupId, loadClinicDates: async () => clinicDates, ...lastGood };
    expect(await getCurrentClinicChannelLink({ ...base, now })).toBeNull();
    // Within the miss window: cached, not retried.
    await getCurrentClinicChannelLink({ ...base, now: new Date(now.getTime() + 60 * 1000) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // After the miss window: retried.
    await getCurrentClinicChannelLink({ ...base, now: new Date(now.getTime() + 6 * 60 * 1000) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("getCurrentClinicChannelLink Graph retries", () => {
  const groupId = "4796e633-27e4-4053-8631-d3b4fe64ebe6";
  const now = new Date(Date.UTC(2026, 5, 8, 12, 0, 0));
  const clinicDates = [clinic(2026, 6, 6), clinic(2026, 6, 13), clinic(2026, 6, 20)];

  function timeoutError() {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    return err;
  }

  function okResponse() {
    return new Response(
      JSON.stringify({
        value: [{ id: "2", displayName: "06-13-26 Clinic", webUrl: "https://x/0613" }],
      }),
      { status: 200 }
    );
  }

  const base = () => ({
    getToken: async () => "tok",
    now,
    groupId,
    loadClinicDates: async () => clinicDates,
    sleep: async () => {},
    ...lastGood,
  });

  it("recovers from a single timeout instead of hiding the card", async () => {
    // The reported production failure: one transient Graph timeout blanked the
    // clinic channel card for the whole miss window.
    const fetchImpl = vi.fn().mockRejectedValueOnce(timeoutError()).mockResolvedValueOnce(okResponse());
    const result = await getCurrentClinicChannelLink({ ...base(), fetchImpl });
    expect(result?.webUrl).toBe("https://x/0613");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a 429, which is transient too", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(okResponse());
    const result = await getCurrentClinicChannelLink({ ...base(), fetchImpl });
    expect(result?.webUrl).toBe("https://x/0613");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 403, which will not fix itself", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    expect(await getCurrentClinicChannelLink({ ...base(), fetchImpl })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the WHOLE resolve inside one budget, however many attempts it takes", async () => {
    // The point of the retry is a better success rate, NOT a longer wait. This
    // renders inside <Suspense> on the hub, so a slow resolve holds a serverless
    // invocation open showing an empty rail. Retrying with a fresh full-length
    // timeout per attempt would triple that; the budget is shared instead.
    const timeouts: number[] = [];
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      // Read back the per-attempt budget the resolver asked for.
      timeouts.push((init as { __timeoutMs?: number } | undefined)?.__timeoutMs ?? 0);
      throw timeoutError();
    });
    await getCurrentClinicChannelLink({ ...base(), fetchImpl });

    expect(timeouts.length).toBeGreaterThan(1);
    const total = timeouts.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(GRAPH_TOTAL_BUDGET_MS);
    // Every attempt gets a usable slice rather than a vanishing tail.
    expect(Math.min(...timeouts)).toBeGreaterThan(0);
  });

  it("degrades to null when every attempt times out and nothing was ever saved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw timeoutError();
    });
    // lastGood is empty in this test, so there is nothing to fall back to.
    expect(await getCurrentClinicChannelLink({ ...base(), fetchImpl })).toBeNull();
  });

  it("logs the clinic week and the attempts spent, so a repeat is diagnosable", async () => {
    // The report's actual complaint: the existing log named neither the channel
    // being resolved nor whether it eventually succeeded, so nobody could tell
    // how many clinic weeks were affected.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw timeoutError();
    });
    await getCurrentClinicChannelLink({ ...base(), fetchImpl });

    const logged = spy.mock.calls.map((c) => JSON.stringify(c)).join(" ");
    expect(logged).toContain("06-13-26");
    expect(logged).toMatch(/attempts/i);
  });
});

describe("getCurrentClinicChannelLink failure telemetry", () => {
  const groupId = "4796e633-27e4-4053-8631-d3b4fe64ebe6";
  const now = new Date(Date.UTC(2026, 5, 8, 12, 0, 0));
  const clinicDates = [clinic(2026, 6, 6), clinic(2026, 6, 13), clinic(2026, 6, 20)];

  function timeoutError() {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    return err;
  }

  const base = () => ({
    now,
    groupId,
    loadClinicDates: async () => clinicDates,
    sleep: async () => {},
    ...lastGood,
  });

  /** The single JSON blob of everything console.error was handed. */
  function loggedJson(spy: { mock: { calls: unknown[] } }): string {
    return spy.mock.calls.map((c) => JSON.stringify(c)).join(" ");
  }

  it("reports the REAL attempt count, not a constant", async () => {
    // The regression this pins: attempts was only assigned on the SUCCESS path,
    // so the failure log -- the only one anyone reads -- always printed the
    // hardcoded attempt cap. Production "attempts=2" lines were that constant,
    // and two rounds of budget tuning were argued from them.
    //
    // A 403 is the discriminator: it is not transient, so exactly ONE attempt
    // runs. The old code still claimed two.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await getCurrentClinicChannelLink({ ...base(), getToken: async () => "tok", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(loggedJson(spy)).toContain('"attempts":1');
  });

  it("blames the token half, with zero Graph attempts, when the token call is what failed", async () => {
    // getAccessToken bounds the Entra refresh with its OWN 8s AbortSignal, and
    // the elapsed clock starts before it -- so a hung token refresh threw the
    // very same TimeoutError at the very same ~8s and was logged as "resolve
    // channel failed". The two are only separable by stage + attempts.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn();
    const result = await getCurrentClinicChannelLink({
      ...base(),
      getToken: async () => {
        throw timeoutError();
      },
      fetchImpl,
    });

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    const logged = loggedJson(spy);
    expect(logged).toContain("acquire token");
    expect(logged).not.toContain("resolve channel");
    expect(logged).toContain('"attempts":0');
  });

  it("splits the elapsed time into tokenMs and graphMs", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw timeoutError();
    });
    await getCurrentClinicChannelLink({ ...base(), getToken: async () => "tok", fetchImpl });

    const logged = loggedJson(spy);
    expect(logged).toMatch(/"tokenMs":\d+/);
    expect(logged).toMatch(/"graphMs":\d+/);
  });
});

describe("getCurrentClinicChannelLink last-known-good fallback", () => {
  const groupId = "4796e633-27e4-4053-8631-d3b4fe64ebe6";
  const now = new Date(Date.UTC(2026, 5, 8, 12, 0, 0));
  const clinicDates = [clinic(2026, 6, 6), clinic(2026, 6, 13), clinic(2026, 6, 20)];
  const link: ClinicChannelLink = {
    webUrl: "https://x/0613",
    displayName: "06-13-26 Clinic",
    clinicDate: clinic(2026, 6, 13),
  };

  function timeoutError() {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    return err;
  }

  const base = () => ({
    getToken: async () => "tok",
    now,
    groupId,
    loadClinicDates: async () => clinicDates,
    sleep: async () => {},
    ...lastGood,
  });

  it("saves a resolved link so a later cold start has something to fall back to", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ value: [{ id: "2", displayName: link.displayName, webUrl: link.webUrl }] }),
          { status: 200 }
        )
    );
    await getCurrentClinicChannelLink({ ...base(), fetchImpl });
    expect(await lastGood.loadLastGood(groupId, "06-13-26")).toEqual(link);
  });

  it("serves the saved link instead of hiding the card when the whole resolve times out", async () => {
    // The recurring production symptom. The module cache cannot cover this: it
    // does not survive the serverless cold start that causes it.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await lastGood.saveLastGood(groupId, "06-13-26", link);
    const fetchImpl = vi.fn(async () => {
      throw timeoutError();
    });

    const result = await getCurrentClinicChannelLink({ ...base(), fetchImpl });

    expect(result).toEqual(link);
    // Recovered, so NOT the counted error line -- but still fully queryable.
    expect(errorSpy).not.toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => JSON.stringify(c)).join(" ");
    expect(warned).toContain("last-known-good");
    expect(warned).toContain("TimeoutError");
    expect(warned).toContain('"attempts":2');
  });

  it("ignores a saved link from a different clinic week", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await lastGood.saveLastGood(groupId, "06-06-26", link);
    const fetchImpl = vi.fn(async () => {
      throw timeoutError();
    });
    expect(await getCurrentClinicChannelLink({ ...base(), fetchImpl })).toBeNull();
  });

  it("ignores a saved link from a different Teams group", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await lastGood.saveLastGood("00000000-1111-2222-3333-444444444444", "06-13-26", link);
    const fetchImpl = vi.fn(async () => {
      throw timeoutError();
    });
    expect(await getCurrentClinicChannelLink({ ...base(), fetchImpl })).toBeNull();
  });

  // audit 14 (NOTIF-3). A COMPLETE list with no match means the week's channel was
  // renamed or deleted, so a link saved for that same week now points at a channel
  // that is gone. Keeping it meant the next transient failure served a dead deep
  // link for the rest of the week.
  it("drops a saved link when a complete channel list no longer contains it", async () => {
    await lastGood.saveLastGood(groupId, "06-13-26", link);
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ value: [{ id: "1", displayName: "General", webUrl: "u" }] }), { status: 200 })
    );
    expect(await getCurrentClinicChannelLink({ ...base(), fetchImpl })).toBeNull();
    expect(await lastGood.loadLastGood(groupId, "06-13-26")).toBeNull();
  });

  // ...but this call deliberately does not follow @odata.nextLink, so on a Team
  // with enough channels to page, "no match" can mean "the match is on a page we
  // never asked for". Invalidating a good link on that basis would be strictly
  // worse than keeping it.
  it("keeps a saved link when Graph says the channel list was truncated", async () => {
    await lastGood.saveLastGood(groupId, "06-13-26", link);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            value: [{ id: "1", displayName: "General", webUrl: "u" }],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/teams/x/channels?$skiptoken=abc",
          }),
          { status: 200 }
        )
    );
    expect(await getCurrentClinicChannelLink({ ...base(), fetchImpl })).toBeNull();
    expect(await lastGood.loadLastGood(groupId, "06-13-26")).toEqual(link);
  });
});

// ---------------------------------------------------------------------------
// audit 14, finding 2: the failure path was invisible and unbounded in cost.
// ---------------------------------------------------------------------------

describe("getCurrentClinicChannelLink failure handling", () => {
  function timeoutError() {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    return err;
  }

  const groupId = "4796e633-27e4-4053-8631-d3b4fe64ebe6";
  const now = new Date(Date.UTC(2026, 5, 8, 12, 0, 0));
  const clinicDates = [clinic(2026, 6, 13)];
  const link: ClinicChannelLink = {
    webUrl: "https://x/0613",
    displayName: "06-13-26 Clinic",
    clinicDate: clinic(2026, 6, 13),
  };
  const base = () => ({
    getToken: async () => "tok",
    now,
    groupId,
    loadClinicDates: async () => clinicDates,
    sleep: async () => {},
    ...lastGood,
  });

  // A 401/403/404 is Graph saying the configuration is wrong or the Team is gone.
  // Papering over that with a saved link hides the one problem only an operator
  // can fix, and sends people to a channel that may not exist.
  it("does NOT serve the saved link on a permanent Graph error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await lastGood.saveLastGood(groupId, "06-13-26", link);
    const fetchImpl = vi.fn(async () => new Response("Forbidden", { status: 403 }));
    expect(await getCurrentClinicChannelLink({ ...base(), fetchImpl })).toBeNull();
  });

  it("still serves the saved link on a transient failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await lastGood.saveLastGood(groupId, "06-13-26", link);
    const fetchImpl = vi.fn(async () => new Response("Bad gateway", { status: 502 }));
    expect(await getCurrentClinicChannelLink({ ...base(), fetchImpl })).toEqual(link);
  });

  // Production ran thirty days without a single success, paying the full 8s budget
  // on every cold instance to render nothing.
  it("stops calling Graph once failures trip the threshold", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw timeoutError();
    });

    for (let i = 0; i < 4; i++) {
      __resetChannelCache(); // simulate a fresh serverless instance each time
      await getCurrentClinicChannelLink({ ...base(), fetchImpl });
    }

    // Three attempts, then the breaker trips and the fourth never reaches Graph.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3 * 2);
    const before = fetchImpl.mock.calls.length;
    __resetChannelCache();
    await getCurrentClinicChannelLink({ ...base(), fetchImpl });
    expect(fetchImpl.mock.calls.length).toBe(before);
  });

  it("recovers on the first success after the cooldown, with no deploy", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(async () => {
      throw timeoutError();
    });
    for (let i = 0; i < 3; i++) {
      __resetChannelCache();
      await getCurrentClinicChannelLink({ ...base(), fetchImpl: failing });
    }

    const later = new Date(now.getTime() + 31 * 60 * 1000);
    const ok = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ value: [{ id: "2", displayName: "06-13-26 Clinic", webUrl: "https://x/0613" }] }),
          { status: 200 }
        )
    );
    __resetChannelCache();
    const resolved = await getCurrentClinicChannelLink({ ...base(), now: later, fetchImpl: ok });
    expect(resolved?.webUrl).toBe("https://x/0613");
    // Counter cleared, so the next failure starts from zero rather than tripping.
    expect(await lastGood.loadFailure()).toBeNull();
  });
});
