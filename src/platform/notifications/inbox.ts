import type { Prisma, PrismaClient, Notification } from "@prisma/client";
import { prisma } from "@/platform/db";

type Db = PrismaClient | Prisma.TransactionClient;

export const NOTIFICATIONS_PAGE_SIZE = 20;

export type CreateNotificationInput = {
  personId: string;
  type: string;
  title: string;
  body: string;
  link?: string | null;
};

/** Append an in-app notification. Accepts any Db handle (joins a surrounding tx). */
export async function createNotification(
  db: Db,
  input: CreateNotificationInput
): Promise<Notification> {
  return db.notification.create({
    data: {
      personId: input.personId,
      type: input.type,
      title: input.title,
      body: input.body,
      link: input.link ?? null,
    },
  });
}

/** Count unread notifications for a person. */
export async function unreadCount(personId: string): Promise<number> {
  return prisma.notification.count({ where: { personId, readAt: null } });
}

/** The most recent notifications for a person, newest-first. */
export async function recentNotifications(
  personId: string,
  limit = 10
): Promise<Notification[]> {
  return prisma.notification.findMany({
    where: { personId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Paginated full list for a person, newest-first. */
export async function listNotifications(
  personId: string,
  params: { page?: number } = {}
): Promise<{ rows: Notification[]; total: number; page: number }> {
  const page = Math.max(1, params.page ?? 1);
  const [rows, total] = await Promise.all([
    prisma.notification.findMany({
      where: { personId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * NOTIFICATIONS_PAGE_SIZE,
      take: NOTIFICATIONS_PAGE_SIZE,
    }),
    prisma.notification.count({ where: { personId } }),
  ]);
  return { rows, total, page };
}

/**
 * Mark one notification read. Owner-scoped via updateMany: the personId is in the
 * where clause, so a mismatched owner (or an already-read row) is a silent no-op
 * rather than touching another person's data.
 */
export async function markRead(personId: string, id: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id, personId, readAt: null },
    data: { readAt: new Date() },
  });
}

/** Mark all of a person's unread notifications read. */
export async function markAllRead(personId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { personId, readAt: null },
    data: { readAt: new Date() },
  });
}
