import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";

// Config is a fixed object here (the helper only reads GITBOOK_JWT_KEY).
vi.mock("@/platform/config", () => ({
  config: { GITBOOK_JWT_KEY: "test-key", GITBOOK_SITE_URL: "https://docs.example.org" },
}));
// Keep the real (pure) hasPermission so buildAdaptiveClaims resolves; mock only the DB call.
vi.mock("@/platform/rbac/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/rbac/engine")>();
  return { ...actual, getEffectivePermissions: vi.fn() };
});
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { mintVisitorToken } from "./visitor-token";

const asMock = (f: unknown) => f as ReturnType<typeof vi.fn>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodePayload(token: string): Record<string, any> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}
function signatureVerifies(token: string, key: string): boolean {
  const [h, p, sig] = token.split(".");
  const expected = createHmac("sha256", key).update(`${h}.${p}`).digest("base64url");
  return sig === expected;
}

describe("mintVisitorToken", () => {
  beforeEach(() => vi.resetAllMocks());

  it("mints an HS256 token with `can` claims, email, and a 1h expiry", async () => {
    asMock(getEffectivePermissions).mockResolvedValue(new Set(["schedule.view"]));

    const { token, expiresAt } = await mintVisitorToken(
      { id: "p1", name: "Jo", contactEmail: "jo@x.com" },
      { email: "fallback@x.com" }
    );

    expect(signatureVerifies(token, "test-key")).toBe(true);
    const payload = decodePayload(token);
    expect(payload.name).toBe("Jo");
    expect(payload.email).toBe("jo@x.com"); // contactEmail wins over the fallback
    expect(payload.can.schedule.view).toBe(true);
    expect(payload.can.admin.access).toBe(false);
    expect(payload.exp - payload.iat).toBe(3600);
    expect(expiresAt).toBe(payload.exp * 1000);
  });

  it("forwards the caller-supplied derived claims and omits a null email", async () => {
    asMock(getEffectivePermissions).mockResolvedValue(new Set(["schedule.view"]));

    const { token } = await mintVisitorToken(
      { id: "p2", name: "Dee", contactEmail: null },
      {
        derived: {
          "schedule.manages_any_dept": true,
          "schedule.manages_any_rhd_dept": false,
        },
      }
    );
    const payload = decodePayload(token);
    expect(payload.can.schedule.manages_any_dept).toBe(true);
    expect(payload.can.schedule.manages_any_rhd_dept).toBe(false);
    expect(payload.email).toBeUndefined(); // null contactEmail + no fallback -> key omitted
  });
});
