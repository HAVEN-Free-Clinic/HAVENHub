// src/platform/notifications/inbox.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createNotification,
  unreadCount,
  recentNotifications,
  listNotifications,
  markRead,
  markAllRead,
} from "./inbox";

async function person(name = "Sam") {
  return prisma.person.create({ data: { name, contactEmail: `${name}-${Math.random()}@x.com` } });
}

describe("inbox service", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("createNotification writes an unread row", async () => {
    const p = await person();
    const n = await createNotification(prisma, {
      personId: p.id,
      type: "epic-activation",
      title: "T",
      body: "B",
      link: "/volunteers",
    });
    expect(n.readAt).toBeNull();
    expect(await unreadCount(p.id)).toBe(1);
  });

  it("unreadCount only counts unread rows for that person", async () => {
    const a = await person("A");
    const b = await person("B");
    await createNotification(prisma, { personId: a.id, type: "t", title: "1", body: "b" });
    await createNotification(prisma, { personId: a.id, type: "t", title: "2", body: "b" });
    await createNotification(prisma, { personId: b.id, type: "t", title: "3", body: "b" });
    expect(await unreadCount(a.id)).toBe(2);
    expect(await unreadCount(b.id)).toBe(1);
  });

  it("recentNotifications returns newest-first, capped to the limit", async () => {
    const p = await person();
    for (let i = 0; i < 12; i++) {
      await createNotification(prisma, { personId: p.id, type: "t", title: `n${i}`, body: "b" });
    }
    const recent = await recentNotifications(p.id, 10);
    expect(recent).toHaveLength(10);
    expect(recent[0].title).toBe("n11");
  });

  it("listNotifications paginates", async () => {
    const p = await person();
    for (let i = 0; i < 3; i++) {
      await createNotification(prisma, { personId: p.id, type: "t", title: `n${i}`, body: "b" });
    }
    const { rows, total, page } = await listNotifications(p.id, { page: 1 });
    expect(total).toBe(3);
    expect(page).toBe(1);
    expect(rows).toHaveLength(3);
  });

  it("markRead is owner-scoped: it does not touch another person's row", async () => {
    const a = await person("A");
    const b = await person("B");
    const bRow = await createNotification(prisma, { personId: b.id, type: "t", title: "B", body: "b" });
    await markRead(a.id, bRow.id); // wrong owner
    const reloaded = await prisma.notification.findUnique({ where: { id: bRow.id } });
    expect(reloaded?.readAt).toBeNull();
    await markRead(b.id, bRow.id); // correct owner
    const after = await prisma.notification.findUnique({ where: { id: bRow.id } });
    expect(after?.readAt).not.toBeNull();
  });

  it("markAllRead clears all unread for the person only", async () => {
    const a = await person("A");
    const b = await person("B");
    await createNotification(prisma, { personId: a.id, type: "t", title: "1", body: "b" });
    await createNotification(prisma, { personId: a.id, type: "t", title: "2", body: "b" });
    await createNotification(prisma, { personId: b.id, type: "t", title: "3", body: "b" });
    await markAllRead(a.id);
    expect(await unreadCount(a.id)).toBe(0);
    expect(await unreadCount(b.id)).toBe(1);
  });
});
