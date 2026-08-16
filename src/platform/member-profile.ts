/**
 * Who may open another member's profile (/volunteers/compliance/[personId]).
 *
 * The profile shows a member's contact details and, more sensitively, WHY they
 * are not cleared: an outstanding HIPAA certificate, an unfinished course, a
 * missing EHS training. That is exactly what a director needs about their own
 * volunteers and exactly what nobody else's business it is, so the reach is
 * scoped rather than granted by a flat permission:
 *
 *   - volunteers.manage_compliance (the compliance manager) and admin.access
 *     reach everyone. They already have the master roster.
 *   - volunteers.view reaches the ACTIVE members of the departments the viewer
 *     directs, plus the departments those manage by delegation. This is the same
 *     set departmentCompliance already shows them on /volunteers, so the profile
 *     is a detail view of a list they can already read, not new access.
 *   - Everyone else reaches nobody.
 *
 * Lives in platform because both the volunteers module (which owns the page) and
 * the schedule module (whose rosters link into it) need the same answer, and
 * modules may not import each other.
 */

import { cache } from "react";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { manageableDepartmentIds } from "@/platform/departments";
import { getActiveTerm } from "@/platform/terms/active-term";

/**
 * How far the viewer's profile access reaches: "all" for a clinic-wide holder,
 * otherwise the department ids whose ACTIVE members they may look up (empty for
 * someone with no reach at all).
 *
 * React-cached: a roster page asks this once and a page gate asks it again on
 * the way in, and the answer costs several permission resolutions.
 */
export const memberProfileScope = cache(async function memberProfileScope(
  viewerPersonId: string,
): Promise<"all" | string[]> {
  const [master, admin, view] = await Promise.all([
    can(viewerPersonId, "volunteers.manage_compliance"),
    can(viewerPersonId, "admin.access"),
    can(viewerPersonId, "volunteers.view"),
  ]);
  if (master || admin) return "all";
  if (!view) return [];
  return manageableDepartmentIds(viewerPersonId);
});

/**
 * The subset of `personIds` whose profile the viewer may open.
 *
 * For roster pages that must decide, per name, whether to render a link. One
 * query for the whole page rather than one per name, for the same reason
 * loadClearedSet exists: these pages render dozens of names.
 */
export async function viewableMemberIds(
  viewerPersonId: string,
  personIds: string[],
): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();

  const scope = await memberProfileScope(viewerPersonId);
  if (scope === "all") return new Set(personIds);
  if (scope.length === 0) return new Set();

  const activeTerm = await getActiveTerm();
  if (!activeTerm) return new Set();

  const rows = await prisma.termMembership.findMany({
    where: {
      personId: { in: [...new Set(personIds)] },
      termId: activeTerm.id,
      status: "ACTIVE",
      departmentId: { in: scope },
    },
    select: { personId: true },
  });
  return new Set(rows.map((r) => r.personId));
}

/** Whether the viewer may open this one person's profile. The page gate. */
export async function canViewMemberProfile(
  viewerPersonId: string,
  targetPersonId: string,
): Promise<boolean> {
  const allowed = await viewableMemberIds(viewerPersonId, [targetPersonId]);
  return allowed.has(targetPersonId);
}
