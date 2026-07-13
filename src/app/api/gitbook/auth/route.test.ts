import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock every dependency so this test is DB-free and deterministic.
vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));
// adaptive-claims.ts also imports hasPermission from this module; use importOriginal to keep
// the real (pure, DB-free) implementation so buildAdaptiveClaims resolves correctly.
vi.mock("@/platform/rbac/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/rbac/engine")>();
  return { ...actual, getEffectivePermissions: vi.fn() };
});
vi.mock("@/platform/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/platform/config", () => ({
  config: { GITBOOK_JWT_KEY: "test-key", GITBOOK_SITE_URL: "https://docs.example.org" },
}));
// The schedule Builder/Attendings capability gates are data-driven (DB-backed);
// mock them so this route test stays DB-free.
vi.mock("@/modules/schedule/services/builder", () => ({ canManageAnyScheduleDept: vi.fn() }));
vi.mock("@/modules/schedule/services/attendings", () => ({ canManageAnyRhdDept: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { canManageAnyScheduleDept } from "@/modules/schedule/services/builder";
import { canManageAnyRhdDept } from "@/modules/schedule/services/attendings";

const asMock = (f: unknown) => f as ReturnType<typeof vi.fn>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodePayload(token: string): Record<string, any> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}

describe("GET /api/gitbook/auth adaptive claims", () => {
  beforeEach(() => vi.resetAllMocks());

  it("signs the person's `can` permissions into the returned jwt_token", async () => {
    asMock(auth).mockResolvedValue({ personId: "p1", user: { email: "j@x.com" } });
    asMock(getActivePerson).mockResolvedValue({ id: "p1", name: "Jo", contactEmail: "jo@x.com" });
    asMock(getEffectivePermissions).mockResolvedValue(new Set(["schedule.view"]));
    asMock(canManageAnyScheduleDept).mockResolvedValue(false);
    asMock(canManageAnyRhdDept).mockResolvedValue(false);

    const { GET } = await import("./route");
    const req = new Request("https://hub.example.org/api/gitbook/auth?location=/schedule");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any);

    const loc = res.headers.get("location");
    expect(loc).toBeTruthy();
    const token = new URL(loc as string).searchParams.get("jwt_token");
    expect(token).toBeTruthy();
    const payload = decodePayload(token as string);
    expect(payload.can.schedule.view).toBe(true);
    expect(payload.can.schedule.edit_all).toBe(false);
    expect(payload.can.admin.access).toBe(false);
    expect(payload.name).toBe("Jo");
  });

  it("signs the data-driven schedule capability claims from the service gates", async () => {
    // A plain schedule.view holder who nonetheless directs a department: manages a
    // schedule dept (Builder docs) but not an RHD dept (Attendings docs).
    asMock(auth).mockResolvedValue({ personId: "p2", user: { email: "d@x.com" } });
    asMock(getActivePerson).mockResolvedValue({ id: "p2", name: "Dee", contactEmail: "dee@x.com" });
    asMock(getEffectivePermissions).mockResolvedValue(new Set(["schedule.view"]));
    asMock(canManageAnyScheduleDept).mockResolvedValue(true);
    asMock(canManageAnyRhdDept).mockResolvedValue(false);

    const { GET } = await import("./route");
    const req = new Request("https://hub.example.org/api/gitbook/auth?location=/schedule");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(req as any);

    const token = new URL(res.headers.get("location") as string).searchParams.get("jwt_token");
    const payload = decodePayload(token as string);
    expect(payload.can.schedule.manages_any_dept).toBe(true);
    expect(payload.can.schedule.manages_any_rhd_dept).toBe(false);
  });
});
