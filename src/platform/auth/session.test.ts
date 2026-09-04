/**
 * requireModuleAccess against the REAL module registry.
 *
 * The registry is deliberately not mocked: the defect this file guards is a
 * disagreement between two readers of the same manifest (the nav asks
 * canAccessModule, the route guard asked only accessPermission), so a fixture
 * manifest would prove nothing about the modules that actually ship.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const perms = vi.hoisted(() => ({ current: new Set<string>() }));
const redirect = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
);

vi.mock("next/navigation", () => ({ redirect }));
// No x-pathname: enforceOnboarding returns immediately, which is the real
// behaviour for a server action and keeps the onboarding gate out of these cases.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
const auth = vi.hoisted(() => vi.fn());
vi.mock("./auth", () => ({ auth }));
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
// Faithful to the real engine (both are one line there); a stub that always
// answered true/false would retire the "*"-satisfies-anything rule from the test.
vi.mock("@/platform/rbac/engine", () => ({
  getEffectivePermissions: async () => perms.current,
  hasPermission: (set: Set<string>, permission: string) => set.has(permission) || set.has("*"),
  can: async (_id: string, permission: string) => perms.current.has(permission) || perms.current.has("*"),
}));
vi.mock("@/platform/terms/active-term", () => ({ getActiveTerm: async () => null }));
vi.mock("@/modules/onboarding/services/onboarding", () => ({
  getOnboardingStatus: async () => ({ hasActiveTerm: false, onboarded: true }),
  EXEMPT_PERMISSION: "admin.access",
}));

import { Prisma } from "@prisma/client";
import { requireModuleAccess, requirePersonSession } from "./session";
import { resolvePersonForLogin } from "./match-person";

beforeEach(() => {
  perms.current = new Set<string>();
  vi.clearAllMocks();
  auth.mockResolvedValue({ personId: "person-1" });
});

/** A PgBouncer-pooled connection closed mid-query: Prisma P1017, seen in prod. */
const poolerClosed = () =>
  new Prisma.PrismaClientKnownRequestError("Server has closed the connection", {
    code: "P1017",
    clientVersion: "x",
  });

describe("requirePersonSession survives a dropped connection", () => {
  // A JWT stamped before recruitment promoted the applicant carries personId
  // null, so the session re-resolves the Person from applicantEmail. That is
  // the call the production P1017 came out of.
  beforeEach(() => {
    auth.mockResolvedValue({ personId: null, applicantEmail: "jc999@yale.edu" });
  });

  it("retries the re-resolution and returns the session", async () => {
    vi.mocked(resolvePersonForLogin)
      .mockRejectedValueOnce(poolerClosed())
      .mockResolvedValueOnce({ id: "person-1" } as never);
    await expect(requirePersonSession()).resolves.toMatchObject({ personId: "person-1" });
    expect(resolvePersonForLogin).toHaveBeenCalledTimes(2);
  });

  it("rethrows once the budget is spent, rather than bouncing to /welcome", async () => {
    // The distinction that matters: a spent budget must NOT look like "no such
    // person". That would redirect a real member out of the hub over a blip.
    vi.mocked(resolvePersonForLogin).mockRejectedValue(poolerClosed());
    await expect(requirePersonSession()).rejects.toThrow("Server has closed the connection");
    expect(redirect).not.toHaveBeenCalledWith("/welcome");
  });

  it("does not retry an error that is not a connectivity fault", async () => {
    vi.mocked(resolvePersonForLogin).mockRejectedValue(new Error("boom"));
    await expect(requirePersonSession()).rejects.toThrow("boom");
    expect(resolvePersonForLogin).toHaveBeenCalledTimes(1);
  });
});

describe("requireModuleAccess", () => {
  it("admits a viewer holding one of the module's additionalAccessPermissions", async () => {
    // learning.manage_courses is granted to Learning Coordinators, who never get
    // learning.access (only the kind-scoped baselines hand that out). The tile,
    // the module row and the ModuleNav all offer them Learning; the route guard
    // consulted accessPermission alone and answered /no-access (audit 14,
    // AUTH-NAV-01).
    perms.current = new Set(["learning.manage_courses"]);
    await expect(requireModuleAccess("learning")).resolves.toMatchObject({ personId: "person-1" });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("still admits a viewer holding the module's own accessPermission", async () => {
    perms.current = new Set(["learning.access"]);
    await expect(requireModuleAccess("learning")).resolves.toMatchObject({ personId: "person-1" });
  });

  it("refuses a viewer holding neither", async () => {
    perms.current = new Set(["schedule.view"]);
    await expect(requireModuleAccess("learning")).rejects.toThrow("NEXT_REDIRECT:/no-access");
  });

  it("does not widen a module that declares no additionalAccessPermissions", async () => {
    perms.current = new Set(["admin.manage_settings"]);
    await expect(requireModuleAccess("admin")).rejects.toThrow("NEXT_REDIRECT:/no-access");
    perms.current = new Set(["admin.access"]);
    await expect(requireModuleAccess("admin")).resolves.toMatchObject({ personId: "person-1" });
  });

  it("lets anyone signed in into a module that declares no accessPermission", async () => {
    await expect(requireModuleAccess("my-info")).resolves.toMatchObject({ personId: "person-1" });
  });

  it("throws for an unknown module id rather than redirecting", async () => {
    await expect(requireModuleAccess("nope")).rejects.toThrow("Unknown module id: nope");
  });
});
