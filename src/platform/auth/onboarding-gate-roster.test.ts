/**
 * The onboarding gate's roster check.
 *
 * enforceOnboarding sends an uncleared person to /get-started. It used to do so
 * for ANY signed-in person once a term was active, because
 * computeOnboardingForTerm builds the `profile` and `hipaa` tasks
 * unconditionally -- neither consults TermMembership. That made a Hub account
 * with no roster row permanently undeliverable to the app, which is exactly the
 * shape of an attending: faculty hold no TermMembership, and HIPAA for them is
 * tracked by Faculty Relations on AttendingCredentialing, not something they
 * could satisfy from /get-started.
 *
 * The fix is a membership query, NOT an allowlisted path: admitting an (app)
 * path is the trap ONBOARDING_ALLOWLIST documents (the whole AppShell renders
 * around a page every tab then ejects you from).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const perms = vi.hoisted(() => ({ current: new Set<string>() }));
const membership = vi.hoisted(() => ({ found: null as { id: string } | null }));
const onboarding = vi.hoisted(() => ({ status: { hasActiveTerm: true, onboarded: false } }));
const findFirst = vi.hoisted(() => vi.fn(async () => membership.found));
const redirect = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
);

vi.mock("next/navigation", () => ({ redirect }));
// A real page path, so the gate actually runs (a server action has none).
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-pathname": "/schedule" }),
}));
vi.mock("./auth", () => ({ auth: async () => ({ personId: "person-1" }) }));
vi.mock("./match-person", () => ({
  getActivePerson: async (id: string) => ({
    id,
    name: "Ada",
    contactEmail: "ada@example.org",
    themePreference: null,
    photoVersion: 0,
    blockerGateExempt: false,
  }),
  resolvePersonForLogin: vi.fn(),
}));
vi.mock("@/platform/rbac/engine", () => ({
  getEffectivePermissions: async () => perms.current,
  hasPermission: (set: Set<string>, permission: string) => set.has(permission) || set.has("*"),
  can: async (_id: string, permission: string) => perms.current.has(permission) || perms.current.has("*"),
}));
vi.mock("@/platform/terms/active-term", () => ({
  getActiveTerm: async () => ({ id: "term-1", name: "Summer 2026" }),
}));
vi.mock("@/modules/onboarding/services/onboarding", () => ({
  getOnboardingStatus: async () => onboarding.status,
  EXEMPT_PERMISSION: "admin.access",
}));
vi.mock("@/platform/db", () => ({ prisma: { termMembership: { findFirst } } }));

import { requirePersonSession } from "./session";
import { _resetOnboardingGateCache } from "./onboarding-gate-cache";

beforeEach(() => {
  perms.current = new Set<string>();
  membership.found = null;
  onboarding.status = { hasActiveTerm: true, onboarded: false };
  _resetOnboardingGateCache();
  vi.clearAllMocks();
});

describe("enforceOnboarding roster check", () => {
  it("still gates an uncleared member who IS on the term roster", async () => {
    membership.found = { id: "tm-1" };
    await expect(requirePersonSession()).rejects.toThrow("NEXT_REDIRECT:/get-started");
  });

  it("lets a person with no ACTIVE membership through", async () => {
    membership.found = null;
    await expect(requirePersonSession()).resolves.toMatchObject({ personId: "person-1" });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("asks only about ACTIVE memberships in the ACTIVE term", async () => {
    membership.found = null;
    await requirePersonSession();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { personId: "person-1", termId: "term-1", status: "ACTIVE" },
      }),
    );
  });

  /**
   * The exemption short-circuits BEFORE the roster query, which is the point:
   * it reads the per-request-cached permission set and is near-free, while this
   * is a DB round-trip on every page render.
   */
  it("does not query membership for an exempt user", async () => {
    perms.current = new Set(["admin.access"]);
    await requirePersonSession();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("caches the roster-miss decision, so the query does not repeat", async () => {
    membership.found = null;
    await requirePersonSession();
    await requirePersonSession();
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("still clears an on-roster member who is already onboarded", async () => {
    membership.found = { id: "tm-1" };
    onboarding.status = { hasActiveTerm: true, onboarded: true };
    await expect(requirePersonSession()).resolves.toMatchObject({ personId: "person-1" });
  });
});
