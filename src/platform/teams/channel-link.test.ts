import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  selectCurrentClinicDate,
  formatClinicDate,
  matchChannel,
  getCurrentClinicChannelLink,
  __resetChannelCache,
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

beforeEach(() => {
  __resetChannelCache();
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

  it("returns null when groupId is unset (no Graph call)", async () => {
    const fetchImpl = vi.fn();
    const result = await getCurrentClinicChannelLink({
      fetchImpl,
      getToken: async () => "tok",
      now,
      groupId: undefined,
      loadClinicDates: async () => clinicDates,
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
    });
    expect(result).toBeNull();
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
    };
    await getCurrentClinicChannelLink(deps);
    await getCurrentClinicChannelLink(deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a found link cached for the week (well past the old 30-min TTL)", async () => {
    const fetchImpl = okChannelsFetch();
    const base = { fetchImpl, getToken: async () => "tok", groupId, loadClinicDates: async () => clinicDates };
    await getCurrentClinicChannelLink({ ...base, now });
    // Two hours later, same clinic week: still served from cache, no Graph call.
    await getCurrentClinicChannelLink({ ...base, now: new Date(now.getTime() + 2 * 60 * 60 * 1000) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a null result after the short miss window", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ value: [{ id: "1", displayName: "General", webUrl: "u" }] }), { status: 200 })
    );
    const base = { fetchImpl, getToken: async () => "tok", groupId, loadClinicDates: async () => clinicDates };
    expect(await getCurrentClinicChannelLink({ ...base, now })).toBeNull();
    // Within the miss window: cached, not retried.
    await getCurrentClinicChannelLink({ ...base, now: new Date(now.getTime() + 60 * 1000) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // After the miss window: retried.
    await getCurrentClinicChannelLink({ ...base, now: new Date(now.getTime() + 6 * 60 * 1000) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
