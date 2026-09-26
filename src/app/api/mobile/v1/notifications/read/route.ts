import { z } from "zod";
import { mobileHandler } from "@/platform/mobile/api";
import { markAllRead, markRead, unreadCount } from "@/platform/notifications/inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.union([z.object({ id: z.string().min(1) }), z.object({ all: z.literal(true) })]);

/**
 * Mark one notification (`{ id }`) or all of them (`{ all: true }`) read.
 * Both are owner-scoped in the inbox service, so an id belonging to someone
 * else is a silent no-op. Returns the new unread count for the tab badge.
 */
export const POST = mobileHandler(async (request, { personId }) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", error_description: "Send { id } or { all: true }." }, { status: 400 });
  }
  if ("all" in parsed.data) await markAllRead(personId);
  else await markRead(personId, parsed.data.id);
  return Response.json({ unreadCount: await unreadCount(personId) });
});
