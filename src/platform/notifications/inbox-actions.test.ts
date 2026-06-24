// src/platform/notifications/inbox-actions.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

vi.mock("@/platform/auth/session", () => ({ requirePersonSession: vi.fn() }));
import { requirePersonSession } from "@/platform/auth/session";
import { markReadAction, markAllReadAction } from "./inbox-actions";

describe("inbox server actions", () => {
  beforeEach(async () => {
    await resetDb();
    vi.resetAllMocks();
  });

  it("markReadAction marks the signed-in person's notification read", async () => {
    const p = await prisma.person.create({ data: { name: "Sam", contactEmail: "s@x.com" } });
    const n = await prisma.notification.create({
      data: { personId: p.id, type: "t", title: "T", body: "b" },
    });
    (requirePersonSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ personId: p.id });
    await markReadAction(n.id);
    const after = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(after?.readAt).not.toBeNull();
  });

  it("markAllReadAction clears the signed-in person's unread", async () => {
    const p = await prisma.person.create({ data: { name: "Sam", contactEmail: "s2@x.com" } });
    await prisma.notification.create({ data: { personId: p.id, type: "t", title: "1", body: "b" } });
    await prisma.notification.create({ data: { personId: p.id, type: "t", title: "2", body: "b" } });
    (requirePersonSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ personId: p.id });
    await markAllReadAction();
    expect(await prisma.notification.count({ where: { personId: p.id, readAt: null } })).toBe(0);
  });
});
