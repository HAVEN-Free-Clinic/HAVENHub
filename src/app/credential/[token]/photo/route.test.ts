import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/platform/storage", () => ({ getObject: vi.fn() }));

// Keep the real isDbUnreachableError (it's pure: an instanceof check against
// Prisma's error classes) while replacing prisma itself with a manual mock.
// Mirrors src/app/api/people/[personId]/photo/route.test.ts and
// src/app/api/calendar/[token]/route.test.ts.
vi.mock("@/platform/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/db")>();
  return {
    ...actual,
    prisma: { serviceCredential: { findUnique: vi.fn() } },
  };
});

// Keep the real PHOTO_CONTENT_TYPE (a plain string constant the route imports
// directly) while replacing resolvePhoto with a spy this suite asserts against.
vi.mock("@/platform/photos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/photos")>();
  return { ...actual, resolvePhoto: vi.fn() };
});

import { prisma } from "@/platform/db";
import { getObject } from "@/platform/storage";
import { resolvePhoto } from "@/platform/photos";
import { GET } from "./route";

function request(): Request {
  return new Request("https://hub.test/credential/tok123/photo?v=2");
}

const context = { params: Promise.resolve({ token: "tok123" }) };

/** A published, non-revoked credential whose person has a photo. */
function published(overrides: Record<string, unknown> = {}) {
  return {
    revokedAt: null,
    person: { id: "p1", photoKey: "people/p1" },
    ...overrides,
  };
}

describe("GET /credential/[token]/photo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.serviceCredential.findUnique).mockResolvedValue(published() as never);
    vi.mocked(getObject).mockResolvedValue(Buffer.from([1, 2, 3]));
  });

  it("serves the stored photo for a published credential", async () => {
    const res = await GET(request(), context);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  it("caches publicly, since the URL is versioned", async () => {
    const res = await GET(request(), context);

    expect(res.headers.get("Cache-Control")).toContain("public");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("sets nosniff and a restrictive CSP", async () => {
    const res = await GET(request(), context);

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("404s for an unknown or unpublished token", async () => {
    vi.mocked(prisma.serviceCredential.findUnique).mockResolvedValue(null as never);

    expect((await GET(request(), context)).status).toBe(404);
  });

  it("404s for a revoked credential", async () => {
    vi.mocked(prisma.serviceCredential.findUnique).mockResolvedValue(
      published({ revokedAt: new Date() }) as never
    );

    expect((await GET(request(), context)).status).toBe(404);
  });

  it("404s when the person has no photo", async () => {
    vi.mocked(prisma.serviceCredential.findUnique).mockResolvedValue(
      published({ person: { id: "p1", photoKey: null } }) as never
    );

    expect((await GET(request(), context)).status).toBe(404);
  });

  it("404s when the stored object is missing", async () => {
    vi.mocked(getObject).mockResolvedValue(null);

    expect((await GET(request(), context)).status).toBe(404);
  });

  it("never triggers a Yalies pull", async () => {
    await GET(request(), context);

    expect(vi.mocked(resolvePhoto)).not.toHaveBeenCalled();
  });

  it("returns 503, not a crash, when the database is unreachable resolving the token", async () => {
    vi.mocked(prisma.serviceCredential.findUnique).mockRejectedValue(
      new Prisma.PrismaClientInitializationError(
        "Can't reach database server at ep-broad-brook.neon.tech:5432",
        "5.0.0"
      )
    );

    const res = await GET(request(), context);

    expect(res.status).toBe(503);
    expect(vi.mocked(getObject)).not.toHaveBeenCalled();
  });

  it("rethrows a non-connectivity error from the credential lookup", async () => {
    vi.mocked(prisma.serviceCredential.findUnique).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "5.0.0",
      })
    );

    await expect(GET(request(), context)).rejects.toThrow("Unique constraint failed");
  });
});
