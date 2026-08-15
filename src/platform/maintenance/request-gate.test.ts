/**
 * The maintenance gate's decision table. The two failure directions are the
 * interesting part and are asserted explicitly: a broken settings read must
 * never take a healthy hub down, and a broken identity read during a real
 * window must never let the hub back up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getToken = vi.hoisted(() => vi.fn(async () => null as { personId?: string | null } | null));
const getSetting = vi.hoisted(() => vi.fn(async (_key: string) => false as unknown));
const getEffectivePermissions = vi.hoisted(() => vi.fn(async () => new Set<string>()));

vi.mock("next-auth/jwt", () => ({ getToken }));
vi.mock("@/platform/settings/service", () => ({ getSetting }));
vi.mock("@/platform/rbac/engine", () => ({ getEffectivePermissions }));
vi.mock("@/platform/config", () => ({ config: { AUTH_SECRET: "test-secret" } }));
vi.mock("@/platform/logging", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  errorAttrs: () => ({}),
}));

import { isBlockedByMaintenance } from "./request-gate";

function req(path: string): NextRequest {
  return new NextRequest(`https://hub.example.org${path}`, { headers: { host: "hub.example.org" } });
}

/** Maintenance on, and nobody signed in, unless a case says otherwise. */
function maintenanceOn(): void {
  getSetting.mockImplementation(async (key: string) => (key === "maintenance.enabled" ? true : ""));
}

beforeEach(() => {
  getSetting.mockImplementation(async () => false);
  getToken.mockImplementation(async () => null);
  getEffectivePermissions.mockImplementation(async () => new Set<string>());
});

afterEach(() => vi.clearAllMocks());

describe("isBlockedByMaintenance", () => {
  it("blocks nothing while the switch is off, and never reads the session", async () => {
    expect(await isBlockedByMaintenance(req("/dashboard"))).toBe(false);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("blocks a signed-out visitor while the switch is on", async () => {
    maintenanceOn();
    expect(await isBlockedByMaintenance(req("/"))).toBe(true);
  });

  it("blocks a signed-in member who does not hold the bypass grant", async () => {
    maintenanceOn();
    getToken.mockImplementation(async () => ({ personId: "person-1" }));
    getEffectivePermissions.mockImplementation(async () => new Set(["schedule.view", "admin.access"]));
    expect(await isBlockedByMaintenance(req("/schedule"))).toBe(true);
  });

  it("lets a Platform Admin through", async () => {
    maintenanceOn();
    getToken.mockImplementation(async () => ({ personId: "person-1" }));
    getEffectivePermissions.mockImplementation(async () => new Set(["*"]));
    expect(await isBlockedByMaintenance(req("/schedule"))).toBe(false);
  });

  it("never blocks an exempt path, even signed out with the switch on", async () => {
    maintenanceOn();
    for (const p of ["/login", "/maintenance", "/credential/abc", "/brand/logo.webp"]) {
      expect(await isBlockedByMaintenance(req(p)), p).toBe(false);
    }
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("falls back to the unprefixed session cookie when the secure one is absent", async () => {
    maintenanceOn();
    // First call (secureCookie: true) finds no cookie; the http-deploy name does.
    getToken
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => ({ personId: "person-1" }));
    getEffectivePermissions.mockImplementation(async () => new Set(["*"]));
    expect(await isBlockedByMaintenance(req("/"))).toBe(false);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("serves the site when the switch itself cannot be read", async () => {
    // A settings-layer bug must not be able to take down a hub nobody took down.
    getSetting.mockImplementation(async () => {
      throw new Error("settings exploded");
    });
    expect(await isBlockedByMaintenance(req("/dashboard"))).toBe(false);
  });

  it("holds the gate when the visitor cannot be resolved during a real window", async () => {
    // Opposite call to the one above: past the switch, an admin has deliberately
    // taken the hub down, so an error deciding who may pass resolves to nobody.
    maintenanceOn();
    getToken.mockImplementation(async () => {
      throw new Error("jwt exploded");
    });
    expect(await isBlockedByMaintenance(req("/dashboard"))).toBe(true);
  });
});
