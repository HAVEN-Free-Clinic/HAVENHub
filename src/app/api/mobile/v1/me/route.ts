import { mobileHandler } from "@/platform/mobile/api";
import { accountEmailForPerson } from "@/platform/auth/match-person";
import { getAccessibleModules } from "@/platform/modules/access";
import { unreadCount } from "@/platform/notifications/inbox";
import { displayNameOf } from "@/platform/person-name";
import { getMyInfo } from "@/modules/my-info/services/my-info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The app's home screen in one call: who is signed in, their memberships in
 * the active term, their unread count, and the Hub modules they can open.
 *
 * `modules` drives the app's "More" tab, which opens each one on the website:
 * the app covers the everyday screens natively and hands off the rest, so the
 * list must be exactly the modules the Hub's own nav would show this person.
 */
export const GET = mobileHandler(async (_request, { personId, origin }) => {
  const [{ person, activeTerm, memberships }, unread, modules] = await Promise.all([
    getMyInfo(personId),
    unreadCount(personId),
    getAccessibleModules(personId),
  ]);
  return Response.json({
    person: {
      id: person.id,
      name: displayNameOf(person),
      email: accountEmailForPerson(person),
    },
    activeTerm: activeTerm ? { id: activeTerm.id, code: activeTerm.code, name: activeTerm.name } : null,
    memberships: memberships
      .map((m) => ({ departmentCode: m.department.code, departmentName: m.department.name, kind: m.kind }))
      .sort((a, b) => a.departmentName.localeCompare(b.departmentName)),
    unreadCount: unread,
    modules: modules.map((m) => ({ id: m.id, title: m.title, url: `${origin}${m.href}` })),
  });
});
