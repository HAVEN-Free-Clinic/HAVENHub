import { describe, it, expect, beforeEach, vi } from "vitest";

// Mutable config so we can simulate the unconfigured (503) case. vi.hoisted lets the
// vi.mock factory reference this object even though it is declared at top level.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {} as { GITBOOK_JWT_KEY?: string; GITBOOK_SITE_URL?: string },
}));

vi.mock("@/platform/config", () => ({ config: mockConfig }));
vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));
vi.mock("@/platform/gitbook/visitor-token", () => ({ mintVisitorToken: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { mintVisitorToken } from "@/platform/gitbook/visitor-token";

const asMock = (f: unknown) => f as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  mockConfig.GITBOOK_JWT_KEY = "test-key";
  mockConfig.GITBOOK_SITE_URL = "https://docs.example.org";
});

describe("GET /api/gitbook/embed-token", () => {
  it("503 when GitBook is not configured", async () => {
    mockConfig.GITBOOK_JWT_KEY = undefined;
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it("401 when not authenticated", async () => {
    asMock(auth).mockResolvedValue(null);
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mintVisitorToken).not.toHaveBeenCalled();
  });

  it("403 when the session has no active person", async () => {
    asMock(auth).mockResolvedValue({ personId: "p1", user: { email: "j@x.com" } });
    asMock(getActivePerson).mockResolvedValue(null);
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("200 returns { token, expiresAt } with no-store", async () => {
    asMock(auth).mockResolvedValue({ personId: "p1", user: { email: "j@x.com" } });
    asMock(getActivePerson).mockResolvedValue({ id: "p1", name: "Jo", contactEmail: "jo@x.com" });
    asMock(mintVisitorToken).mockResolvedValue({ token: "a.b.c", expiresAt: 1234 });

    const { GET } = await import("./route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ token: "a.b.c", expiresAt: 1234 });
    expect(mintVisitorToken).toHaveBeenCalledWith(
      { id: "p1", name: "Jo", contactEmail: "jo@x.com" },
      { email: "j@x.com" }
    );
  });
});
