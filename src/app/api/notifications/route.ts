import { auth } from "@/platform/auth/auth";
import { isDbUnreachableError } from "@/platform/db";
import { getActivePerson } from "@/platform/auth/match-person";
import { log, errorAttrs } from "@/platform/logging";
import { unreadCount, recentNotifications } from "@/platform/notifications/inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only inbox snapshot for the signed-in person: unread count + recent.
 *
 * The bell polls this every 60s from every open tab, so a brief DB outage
 * (server unreachable) would otherwise turn one Neon blip into a burst of 500s
 * and captured exceptions -- one per tab per minute for the length of the blip.
 * There is no safe *content* fallback here (an empty snapshot would clear a
 * real unread badge), so this degrades to 503 instead: the client already
 * leaves its last known state on a non-ok response and retries on the next
 * tick. Non-connectivity errors still throw, so real bugs stay visible.
 *
 * The person lookup stays inside the guard on purpose -- it is the revocation
 * check, and a DB blip must never be allowed to resolve it as "still active".
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.personId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const person = await getActivePerson(session.personId);
    if (!person) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const [count, recent] = await Promise.all([
      unreadCount(person.id),
      recentNotifications(person.id, 10),
    ]);
    return Response.json({ unreadCount: count, recent });
  } catch (err) {
    if (isDbUnreachableError(err)) {
      log.warn("[notifications] database unreachable reading inbox snapshot", errorAttrs(err));
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    throw err;
  }
}
