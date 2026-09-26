import { mobileHandler } from "@/platform/mobile/api";
import { listNotifications, NOTIFICATIONS_PAGE_SIZE, unreadCount } from "@/platform/notifications/inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One page of the person's notifications, newest first, plus the unread count.
 *
 * `link` is made absolute: in the Hub it is a site path, and the app opens it
 * on the website.
 */
export const GET = mobileHandler(async (request, { personId, origin }) => {
  const page = Number.parseInt(new URL(request.url).searchParams.get("page") ?? "1", 10);
  const [{ rows, total, page: current }, unread] = await Promise.all([
    listNotifications(personId, { page: Number.isFinite(page) ? page : 1 }),
    unreadCount(personId),
  ]);
  return Response.json({
    unreadCount: unread,
    page: current,
    hasMore: current * NOTIFICATIONS_PAGE_SIZE < total,
    notifications: rows.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      url: n.link ? new URL(n.link, origin).toString() : null,
      read: n.readAt !== null,
      createdAt: n.createdAt.toISOString(),
    })),
  });
});
