import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

// Mock the auth + person resolution the route depends on.
vi.mock("@/platform/auth/auth", () => ({ auth: vi.fn() }));
vi.mock("@/platform/auth/match-person", () => ({ getActivePerson: vi.fn() }));

import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";

describe("GET /api/notifications", () => {
  beforeEach(async () => {
    await resetDb();
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the signed-in person's unread count and recent items", async () => {
    const p = await prisma.person.create({ data: { name: "Sam", contactEmail: "sam@x.com" } });
    await prisma.notification.create({
      data: { personId: p.id, type: "t", title: "Hi", body: "b" },
    });
    (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ personId: p.id });
    (getActivePerson as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: p.id });

    const { GET } = await import("./route");
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.unreadCount).toBe(1);
    expect(json.recent[0].title).toBe("Hi");
  });
});
