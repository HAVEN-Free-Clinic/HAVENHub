import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `config` is a singleton parsed from process.env at module load (see
// src/platform/config.ts), so vi.stubEnv after that first import never
// reaches it. Mock the module instead with a mutable object, matching the
// pattern in src/app/api/gitbook/embed-token/route.test.ts.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {} as { WALLETWALLET_API_KEY?: string },
}));
vi.mock("@/platform/config", () => ({ config: mockConfig }));

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

describe("wallet client", () => {
  beforeEach(() => {
    mockConfig.WALLETWALLET_API_KEY = "ww_live_test";
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
    expect(url).toContain("/api/passes");
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
    expect(url).toContain("/api/passes/ser_123");
    expect(init.method).toBe("DELETE");
  });

  it("treats a revoke failure as false rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    expect(await revokePass("ser_123")).toBe(false);
  });

  it("updates by serial", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    expect(await updatePass("ser_123", INPUT)).toBe(true);
    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
  });
});
