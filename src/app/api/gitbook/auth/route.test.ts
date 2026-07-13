import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock every dependency so this test is DB-free and deterministic.
vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));
// adaptive-claims.ts also imports hasPermission from this module; stub it with the
// real (pure, DB-free) implementation so buildAdaptiveClaims resolves correctly.
vi.mock("@/platform/rbac/engine", () => ({
  getEffectivePermissions: vi.fn(),
  hasPermission: (perms: Set<string>, permission: string) => perms.has(permission) || perms.has("*"),
}));
vi.mock("@/platform/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/platform/config", () => ({
  config: { GITBOOK_JWT_KEY: "test-key", GITBOOK_SITE_URL: "https://docs.example.org" },
}));

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { getEffectivePermissions } from "@/platform/rbac/engine";

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
});
