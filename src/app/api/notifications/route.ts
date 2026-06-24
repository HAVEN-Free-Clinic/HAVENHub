import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { unreadCount, recentNotifications } from "@/platform/notifications/inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only inbox snapshot for the signed-in person: unread count + recent. */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.personId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const person = await getActivePerson(session.personId);
  if (!person) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [count, recent] = await Promise.all([
    unreadCount(person.id),
    recentNotifications(person.id, 10),
  ]);
  return Response.json({ unreadCount: count, recent });
}
