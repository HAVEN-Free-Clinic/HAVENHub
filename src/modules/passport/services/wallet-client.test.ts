import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `config` is a singleton parsed from process.env at module load (see
// src/platform/config.ts), so vi.stubEnv after that first import never
// reaches it. Mock the module instead with a mutable object, matching the
// pattern in src/app/api/gitbook/embed-token/route.test.ts.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {} as { WALLETWALLET_API_KEY?: string; WALLETWALLET_PRO?: boolean },
}));
vi.mock("@/platform/config", () => ({ config: mockConfig }));

import { log } from "@/platform/logging";
import { createPass, revokePass, updatePass } from "./wallet-client";

const OK = {
  serialNumber: "ser_123",
  googleSaveUrl: "https://pay.google.com/save/abc",
  applePass: "BASE64",
  shareUrl: "https://walletwallet.dev/p/ser_123",
};

const INPUT = {
  organizationName: "HAVEN Free Clinic",
  logoText: "HAVEN Free Clinic",
  description: "Volunteer badge",
  expirationDays: 90,
  primaryFields: [{ key: "role", label: "Role", value: "Volunteer" }],
  secondaryFields: [{ key: "dept", label: "Department", value: "Internal Medicine" }],
  barcodeValue: null,
};

const BRANDED = {
  ...INPUT,
  brandColor: "#00356b",
  logoUrl: "https://hub.example.org/api/branding/logo",
  iconUrl: "https://hub.example.org/api/branding/favicon",
};

describe("wallet client", () => {
  beforeEach(() => {
    mockConfig.WALLETWALLET_API_KEY = "ww_live_test";
    mockConfig.WALLETWALLET_PRO = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the created pass on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => OK });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createPass(INPUT);

    expect(result).toEqual(OK);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.walletwallet.dev/api/passes");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer ww_live_test");
  });

  it("returns null on a 429 rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "quota" }));

    expect(await createPass(INPUT)).toBeNull();
  });

  it("returns null on a network failure rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

    expect(await createPass(INPUT)).toBeNull();
  });

  it("returns null on a 200 with a body that is not valid JSON rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      }),
    );

    expect(await createPass(INPUT)).toBeNull();
  });

  it("returns null on a 200 whose body has no serialNumber", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));

    expect(await createPass(INPUT)).toBeNull();
  });

  it("returns null when no API key is configured", async () => {
    mockConfig.WALLETWALLET_API_KEY = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await createPass(INPUT)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revokes by serial and reports success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    expect(await revokePass("ser_123")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.walletwallet.dev/api/passes/ser_123");
    expect(init.method).toBe("DELETE");
  });

  it("treats a revoke failure as false rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    expect(await revokePass("ser_123")).toBe(false);
  });

  it("updates by serial and returns the refresh acknowledgement", async () => {
    // NOT the pass: the vendor's PUT carries no install URLs, so updatePass
    // deliberately returns a RefreshResult and callers read the URLs from the
    // stored WalletPass row instead.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        serialNumber: "ser_123",
        lastUpdated: 1786389325159,
        notifiedDevices: 0,
        unchanged: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await updatePass("ser_123", INPUT)).toEqual({
      serialNumber: "ser_123",
      notifiedDevices: 0,
      unchanged: false,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.walletwallet.dev/api/passes/ser_123");
    expect(init.method).toBe("PUT");
  });

  it("returns null from an update whose body carries no usable pass", async () => {
    // The caller must not fall back to createPass here: a duplicate serial is
    // unrevocable, so no badge beats an orphan.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));

    expect(await updatePass("ser_123", INPUT)).toBeNull();
  });

  it("bounds every request with an abort signal", async () => {
    // "Never throws" is not "never hangs": both a member's /my-info request and
    // the offboard path await these calls.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => OK });
    vi.stubGlobal("fetch", fetchMock);

    await createPass(INPUT);
    await updatePass("ser_123", INPUT);
    await revokePass("ser_123");

    for (const call of fetchMock.mock.calls) {
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("returns null when the request is aborted rather than propagating", async () => {
    // What AbortSignal.timeout produces when it fires: fetch rejects with a
    // TimeoutError DOMException, which the client's catch must swallow.
    const aborted = vi
      .fn()
      .mockRejectedValue(new DOMException("The operation was aborted.", "TimeoutError"));
    vi.stubGlobal("fetch", aborted);

    expect(await createPass(INPUT)).toBeNull();
    expect(await updatePass("ser_123", INPUT)).toBeNull();
    expect(await revokePass("ser_123")).toBe(false);
  });
});

describe("Pro-tier branding gating", () => {
  beforeEach(() => {
    mockConfig.WALLETWALLET_API_KEY = "ww_live_test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    return JSON.parse(fetchMock.mock.calls[0][1].body as string);
  }

  it("sends the brand colour and image URLs on Pro", async () => {
    mockConfig.WALLETWALLET_PRO = true;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => OK });
    vi.stubGlobal("fetch", fetchMock);

    await createPass(BRANDED);

    const sent = sentBody(fetchMock);
    expect(sent.color).toBe("#00356b");
    expect(sent.logoURL).toBe("https://hub.example.org/api/branding/logo");
    expect(sent.iconURL).toBe("https://hub.example.org/api/branding/favicon");
    // colorPreset rides along regardless: it is the free tier's fallback and
    // costs nothing to keep, so a lapsed trial still yields a styled card.
    expect(sent.colorPreset).toBe("blue");
  });

  it("drops every Pro field when the trial has lapsed, keeping the preset", async () => {
    // This is the trial-expiry path. Sending Pro fields on a free account is at
    // best ignored, so they must not be sent hopefully; the card degrades to the
    // preset rather than the request changing behaviour silently.
    mockConfig.WALLETWALLET_PRO = false;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => OK });
    vi.stubGlobal("fetch", fetchMock);

    await createPass(BRANDED);

    const sent = sentBody(fetchMock);
    expect(sent.color).toBeUndefined();
    expect(sent.logoURL).toBeUndefined();
    expect(sent.iconURL).toBeUndefined();
    expect(sent.stripURL).toBeUndefined();
    expect(sent.colorPreset).toBe("blue");
  });
});

describe("updatePass response handling", () => {
  beforeEach(() => {
    mockConfig.WALLETWALLET_API_KEY = "ww_live_test";
    mockConfig.WALLETWALLET_PRO = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts the acknowledgement the vendor actually returns from a PUT", async () => {
    // Verified against the live API on 2026-08-10: a refresh returns only
    // {serialNumber, lastUpdated, notifiedDevices, unchanged}.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          serialNumber: "ser_123",
          lastUpdated: 1786389325159,
          notifiedDevices: 3,
          unchanged: false,
        }),
      }),
    );

    expect(await updatePass("ser_123", INPUT)).toEqual({
      serialNumber: "ser_123",
      notifiedDevices: 3,
      unchanged: false,
    });
  });

  it("returns null when a refresh comes back with no serial", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    );

    expect(await updatePass("ser_123", INPUT)).toBeNull();
  });
});

describe("createPass response validation", () => {
  beforeEach(() => {
    mockConfig.WALLETWALLET_API_KEY = "ww_live_test";
    mockConfig.WALLETWALLET_PRO = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a create response shaped like a refresh acknowledgement", async () => {
    // The bug this guards: a serial-only body passes a serial-only check, and
    // the caller then reads googleSaveUrl/shareUrl off it as undefined while
    // TypeScript still believes they are strings.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ serialNumber: "ser_123", notifiedDevices: 0, unchanged: false }),
      }),
    );

    expect(await createPass(INPUT)).toBeNull();
  });
});

describe("error diagnostics", () => {
  beforeEach(() => {
    mockConfig.WALLETWALLET_API_KEY = "ww_live_test";
    mockConfig.WALLETWALLET_PRO = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the vendor's explanation on a non-2xx, not just the status", async () => {
    // The 400 that reached production said only `status: 400`. The reason was in
    // a body we were discarding: {"error":"logoURL could not be fetched"}.
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => '{"error":"logoURL could not be fetched"}',
      }),
    );

    expect(await createPass(INPUT)).toBeNull();

    const call = errorSpy.mock.calls.find(([msg]) => msg === "[passport] wallet call failed");
    expect(call).toBeDefined();
    expect((call![1] as { detail?: string }).detail).toContain("logoURL could not be fetched");
  });

  it("still degrades to null when the error body itself cannot be read", async () => {
    vi.spyOn(log, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => {
          throw new Error("stream already consumed");
        },
      }),
    );

    expect(await createPass(INPUT)).toBeNull();
  });
});

describe("a vendor 404", () => {
  beforeEach(() => {
    mockConfig.WALLETWALLET_API_KEY = "ww_live_test";
    mockConfig.WALLETWALLET_PRO = false;
    vi.spyOn(log, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a refresh of a missing pass as GONE, distinctly from a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => '{"error":"Pass not found"}',
      }),
    );

    expect(await updatePass("ser_dead", INPUT)).toBe("GONE");
  });

  it("keeps every other refresh failure as null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }),
    );

    expect(await updatePass("ser_1", INPUT)).toBeNull();
  });

  it("counts revoking an already-missing pass as success", async () => {
    // The sweep would otherwise retry that serial forever, and a pass the vendor
    // does not have cannot be live on anyone's phone, which is what revocation
    // is for.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => '{"error":"Pass not found"}',
      }),
    );

    expect(await revokePass("ser_dead")).toBe(true);
  });
});
