import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getActivePerson: vi.fn(),
  getEffectivePermissions: vi.fn(),
  isIntercomConfigured: vi.fn(),
  mintIntercomUserJwt: vi.fn(),
  isDbUnreachableError: vi.fn(),
}));

vi.mock("@/platform/auth/auth", () => ({ auth: mocks.auth }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: mocks.getActivePerson }));
// Deviation from the brief's verbatim mock: mocking only `getEffectivePermissions`
// wipes out `hasPermission`, which the real (unmocked) buildAudienceAttributes also
// imports from this module, so it throws instead of returning. This test is about
// the decision table, not audience-attribute content (never asserted on below), so
// hasPermission is stubbed rather than exercised for real; its value is irrelevant
// to every assertion here.
vi.mock("@/platform/rbac/engine", () => ({
  getEffectivePermissions: mocks.getEffectivePermissions,
  hasPermission: () => false,
}));
vi.mock("@/platform/intercom/config", () => ({ isIntercomConfigured: mocks.isIntercomConfigured }));
vi.mock("@/platform/intercom/jwt", () => ({
  mintIntercomUserJwt: mocks.mintIntercomUserJwt,
  INTERCOM_TOKEN_TTL_SECONDS: 900,
}));
vi.mock("@/platform/db", () => ({ isDbUnreachableError: mocks.isDbUnreachableError }));

import { mintMessengerTokenForSession } from "./mint-token";

const PERSON = { id: "person-1", name: "Test Person", contactEmail: "t@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isIntercomConfigured.mockReturnValue(true);
  mocks.auth.mockResolvedValue({ personId: PERSON.id });
  mocks.getActivePerson.mockResolvedValue(PERSON);
  mocks.getEffectivePermissions.mockResolvedValue([]);
  mocks.mintIntercomUserJwt.mockResolvedValue("signed.jwt.value");
  mocks.isDbUnreachableError.mockReturnValue(false);
});

describe("mintMessengerTokenForSession", () => {
  it("mints a token and reports the real TTL", async () => {
    const result = await mintMessengerTokenForSession();
    expect(result).toEqual({ ok: true, token: "signed.jwt.value", expiresInSeconds: 900 });
  });

  it("reports not_configured when the integration is off, without touching the session", async () => {
    mocks.isIntercomConfigured.mockReturnValue(false);
    const result = await mintMessengerTokenForSession();
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("reports unauthorized when there is no session", async () => {
    mocks.auth.mockResolvedValue(null);
    expect(await mintMessengerTokenForSession()).toEqual({ ok: false, reason: "unauthorized" });
  });

  // This is the offboarding revocation check: a member who has been offboarded
  // must stop getting tokens even while their hub JWT is still valid.
  it("reports unauthorized when the session resolves to no active person", async () => {
    mocks.getActivePerson.mockResolvedValue(null);
    expect(await mintMessengerTokenForSession()).toEqual({ ok: false, reason: "unauthorized" });
    expect(mocks.mintIntercomUserJwt).not.toHaveBeenCalled();
  });

  // A database blip must never resolve as "still active", which would hand a
  // token to someone whose revocation we could not check.
  it("reports db_unreachable rather than minting when the database is down", async () => {
    const boom = new Error("connection refused");
    mocks.getActivePerson.mockRejectedValue(boom);
    mocks.isDbUnreachableError.mockReturnValue(true);
    expect(await mintMessengerTokenForSession()).toEqual({ ok: false, reason: "db_unreachable" });
    expect(mocks.mintIntercomUserJwt).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected error instead of swallowing it as a clean refusal", async () => {
    mocks.getActivePerson.mockRejectedValue(new Error("programmer error"));
    mocks.isDbUnreachableError.mockReturnValue(false);
    await expect(mintMessengerTokenForSession()).rejects.toThrow("programmer error");
  });
});
