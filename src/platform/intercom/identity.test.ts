import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));

import { getActivePerson } from "@/platform/auth/match-person";
import { resolveIntercomIdentity } from "./identity";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
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

describe("resolveIntercomIdentity", () => {
  it("resolves when the contact's external_id matches and the person is active", async () => {
    mockFetchOnce(200, { external_id: "p1" });
    mocked(getActivePerson).mockResolvedValue({ id: "p1", name: "Sam Rivera" });

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: true, personId: "p1", name: "Sam Rivera" });
  });

  it("refuses when Intercom returns a contact for a different external_id", async () => {
    mockFetchOnce(200, { external_id: "someone-else" });
    mocked(getActivePerson).mockResolvedValue({ id: "p1", name: "Sam Rivera" });

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "unverified" });
  });

  it("refuses when Intercom has no such contact", async () => {
    mockFetchOnce(404, {});

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "unverified" });
  });

  it("fails closed when Intercom returns a non-404 error like 401 (revoked token)", async () => {
    mockFetchOnce(401, {});

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
  });

  it("refuses an offboarded person even though Intercom still knows the contact", async () => {
    mockFetchOnce(200, { external_id: "p1" });
    mocked(getActivePerson).mockResolvedValue(null);

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "unknown_person" });
  });

  it("fails closed when the Intercom lookup throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
  });

  it("fails closed when no access token is configured", async () => {
    vi.stubEnv("INTERCOM_ACCESS_TOKEN", "");

    const result = await resolveIntercomIdentity("p1");

    expect(result).toEqual({ ok: false, reason: "lookup_failed" });
  });
});
