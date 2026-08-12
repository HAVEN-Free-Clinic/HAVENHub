/**
 * Decision-table tests for the Messenger token mint: which MintResult comes
 * back for each combination of configuration, session, person, membership, and
 * database health. Mock-driven and deliberately not asserting on token
 * CONTENT -- claim shaping is jwt.ts's and profile.ts's business, and duplicating
 * it here would just pin the same thing twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getActivePerson: vi.fn(),
  getEffectivePermissions: vi.fn(),
  isIntercomConfigured: vi.fn(),
  mintIntercomUserJwt: vi.fn(),
  isDbUnreachableError: vi.fn(),
  getActiveTerm: vi.fn(),
  getOnboardingStatus: vi.fn(),
  findMemberships: vi.fn(),
}));

vi.mock("@/platform/auth/auth", () => ({ auth: mocks.auth }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: mocks.getActivePerson }));
// Deviation from mocking only `getEffectivePermissions`: that wipes out
// `hasPermission`, which the real (unmocked) buildAudienceAttributes also
// imports from this module, so it throws instead of returning. This test is
// about the decision table, not audience-attribute content (never asserted on
// below), so hasPermission is stubbed rather than exercised for real.
vi.mock("@/platform/rbac/engine", () => ({
  getEffectivePermissions: mocks.getEffectivePermissions,
  hasPermission: () => false,
}));
vi.mock("@/platform/intercom/config", () => ({ isIntercomConfigured: mocks.isIntercomConfigured }));
vi.mock("@/platform/intercom/jwt", () => ({
  mintIntercomUserJwt: mocks.mintIntercomUserJwt,
  INTERCOM_TOKEN_TTL_SECONDS: 900,
}));
vi.mock("@/platform/db", () => ({
  isDbUnreachableError: mocks.isDbUnreachableError,
  prisma: { termMembership: { findMany: mocks.findMemberships } },
}));
vi.mock("@/platform/terms/active-term", () => ({ getActiveTerm: mocks.getActiveTerm }));
vi.mock("@/modules/onboarding/services/onboarding", () => ({
  getOnboardingStatus: mocks.getOnboardingStatus,
}));
vi.mock("@/platform/logging", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  errorAttrs: (err: unknown) => ({ "error.message": String(err) }),
}));

import { mintMessengerTokenForSession } from "./messenger-token";

const PERSON = {
  id: "person-1",
  name: "Test Person",
  contactEmail: "t@example.com",
  netId: "tp123",
  epicId: null,
  status: "ACTIVE",
};

const TERM = { id: "term-1", name: "Fall 2026" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isIntercomConfigured.mockReturnValue(true);
  mocks.auth.mockResolvedValue({ personId: PERSON.id });
  mocks.getActivePerson.mockResolvedValue(PERSON);
  mocks.getEffectivePermissions.mockResolvedValue([]);
  mocks.mintIntercomUserJwt.mockResolvedValue("signed.jwt.value");
  mocks.isDbUnreachableError.mockReturnValue(false);
  mocks.getActiveTerm.mockResolvedValue(TERM);
  mocks.getOnboardingStatus.mockResolvedValue({ cleared: true });
  mocks.findMemberships.mockResolvedValue([{ department: { name: "Clinic Ops" } }]);
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
    mocks.getActivePerson.mockRejectedValue(new Error("connection refused"));
    mocks.isDbUnreachableError.mockReturnValue(true);
    expect(await mintMessengerTokenForSession()).toEqual({ ok: false, reason: "db_unreachable" });
    expect(mocks.mintIntercomUserJwt).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected error instead of swallowing it as a clean refusal", async () => {
    mocks.getActivePerson.mockRejectedValue(new Error("programmer error"));
    mocks.isDbUnreachableError.mockReturnValue(false);
    await expect(mintMessengerTokenForSession()).rejects.toThrow("programmer error");
  });

  /**
   * The /apply portal's rule. These matter more than the others, because
   * IntercomMessenger's client-side 401/403 fallback is unreachable on any
   * surface that boots from a server-minted token (initialToken sets `booted`
   * at mount) -- so on such a surface this check is the ONLY thing between a
   * stranger and an identified boot, and its absence produces no error.
   */
  describe("requireActiveMembership", () => {
    it("mints for a member holding an ACTIVE membership this term", async () => {
      const result = await mintMessengerTokenForSession({ requireActiveMembership: true });
      expect(result).toEqual({ ok: true, token: "signed.jwt.value", expiresInSeconds: 900 });
    });

    it("refuses with membership_required when the person holds none, without minting", async () => {
      mocks.findMemberships.mockResolvedValue([]);
      const result = await mintMessengerTokenForSession({ requireActiveMembership: true });
      expect(result).toEqual({ ok: false, reason: "membership_required" });
      expect(mocks.mintIntercomUserJwt).not.toHaveBeenCalled();
    });

    // No active term means no membership can exist, so the gate must refuse
    // rather than fall through to minting on an empty department list.
    it("refuses when there is no active term at all", async () => {
      mocks.getActiveTerm.mockResolvedValue(null);
      const result = await mintMessengerTokenForSession({ requireActiveMembership: true });
      expect(result).toEqual({ ok: false, reason: "membership_required" });
      expect(mocks.mintIntercomUserJwt).not.toHaveBeenCalled();
    });

    /**
     * The hub's carve-out, and the reason the flag is opt-in rather than always
     * on: a member between terms holds no ACTIVE membership but still signs into
     * the hub and must still be identified. Passing nothing must NOT apply the
     * gate -- if this ever fails, every between-terms member silently loses
     * support identity.
     */
    it("does not apply the gate when the caller does not ask for it", async () => {
      mocks.findMemberships.mockResolvedValue([]);
      mocks.getActiveTerm.mockResolvedValue(null);
      const result = await mintMessengerTokenForSession();
      expect(result).toEqual({ ok: true, token: "signed.jwt.value", expiresInSeconds: 900 });
    });
  });
});
