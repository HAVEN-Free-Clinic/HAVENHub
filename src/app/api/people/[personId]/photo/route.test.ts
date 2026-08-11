import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/rbac/engine", () => ({ can: vi.fn() }));
vi.mock("@/platform/photos", () => ({
  resolvePhoto: vi.fn(),
  initialsSvg: vi.fn(() => "<svg></svg>"),
}));
vi.mock("@/platform/db", () => ({
  prisma: { person: { findUnique: vi.fn(async () => ({ name: "Ada Lovelace" })) } },
}));

import { auth } from "@/platform/auth/auth";
import { can } from "@/platform/rbac/engine";
import { resolvePhoto } from "@/platform/photos";
import { GET } from "./route";

function request(): Request {
  return new Request("https://hub.test/api/people/p1/photo?v=3");
}

function context(personId = "p1") {
  return { params: Promise.resolve({ personId }) };
}

describe("GET /api/people/[personId]/photo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({ personId: "p1" } as never);
    vi.mocked(can).mockResolvedValue(false);
    vi.mocked(resolvePhoto).mockResolvedValue({
      bytes: Buffer.from([1, 2, 3]),
      contentType: "image/webp",
    });
  });

  it("serves a member their own photo", async () => {
    const res = await GET(request(), context("p1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  it("marks a real photo immutable, since the URL is versioned", async () => {
    const res = await GET(request(), context("p1"));

    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("sets nosniff and a restrictive CSP on user-supplied bytes", async () => {
    const res = await GET(request(), context("p1"));

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("refuses an unauthenticated request", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    expect((await GET(request(), context("p1"))).status).toBe(401);
  });

  it("refuses one member reading another's photo", async () => {
    const res = await GET(request(), context("p2"));

    expect(res.status).toBe(403);
    expect(vi.mocked(resolvePhoto)).not.toHaveBeenCalled();
  });

  it("allows a people admin to read another's photo", async () => {
    vi.mocked(can).mockResolvedValue(true);

    expect((await GET(request(), context("p2"))).status).toBe(200);
    expect(vi.mocked(can)).toHaveBeenCalledWith("p1", "admin.manage_people");
  });

  it("falls back to an initials SVG when there is no photo", async () => {
    vi.mocked(resolvePhoto).mockResolvedValue(null);

    const res = await GET(request(), context("p1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
  });

  it("never caches the initials fallback", async () => {
    vi.mocked(resolvePhoto).mockResolvedValue(null);

    const res = await GET(request(), context("p1"));

    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("falls back to initials when the photo lookup throws", async () => {
    vi.mocked(resolvePhoto).mockRejectedValue(new Error("database unreachable"));

    const res = await GET(request(), context("p1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
  });
});
