/**
 * Department delegation helpers.
 *
 * A director's compliance scope extends beyond their own department(s) by one
 * hop through DepartmentDelegation edges. For example, a PCAR director also
 * oversees SCTP and JCTP because PCAR manages those departments.
 */

import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";

/**
 * Departments to offer in a "scope" editor -- a form that replace-sets a
 * department assignment (learning course assignment, EHS training scope, etc.).
 *
 * Returns every ACTIVE department PLUS any already-assigned department that has
 * since been deactivated, ordered by name. Departments have no hard delete; the
 * only removal is `isActive=false`, and a deactivated department can still hold
 * an assignment whose members keep ACTIVE memberships. If the editor listed only
 * active departments, that deactivated-but-assigned row would be absent from the
 * form and silently dropped by the next replace-set save -- taking a required
 * course/training away from those members and flipping them to "cleared" without
 * completion (#21/#29). Callers render `isActive:false` rows distinctly so the
 * manager can see (and deliberately uncheck) what they would drop. Mirrors the
 * guard in admin/departments/[id]/page.tsx.
 */
export async function scopeEditorDepartments(
  assignedIds: string[],
): Promise<Array<{ id: string; code: string; name: string; isActive: boolean }>> {
  return prisma.department.findMany({
    where: { OR: [{ isActive: true }, { id: { in: assignedIds } }] },
    select: { id: true, code: true, name: true, isActive: true },
    orderBy: { name: "asc" },
  });
}

/**
 * Returns the set of department ids a person may manage for compliance purposes:
 *   - departments where the person holds an ACTIVE DIRECTOR membership in the
 *     ACTIVE term, PLUS
 *   - departments those managed departments oversee via DepartmentDelegation
 *     (exactly ONE hop; the managed departments' own delegations are NOT
 *     followed), deduped.
 *
 * Returns [] when there is no active term or the person directs nothing.
 */
export async function manageableDepartmentIds(personId: string): Promise<string[]> {
  // 1. Find the active term.
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return [];

  // 2. Departments where the person is an ACTIVE DIRECTOR in the active term.
  const directorships = await prisma.termMembership.findMany({
    where: {
      personId,
      termId: activeTerm.id,
      kind: "DIRECTOR",
      status: "ACTIVE",
    },
    select: { departmentId: true },
  });
  if (directorships.length === 0) return [];

  const ids = new Set<string>(directorships.map((d) => d.departmentId));

  // 3. One-hop delegation: departments managed BY any directed department.
  const delegations = await prisma.departmentDelegation.findMany({
    where: { managerDepartmentId: { in: [...ids] } },
    select: { managedDepartmentId: true },
  });
  for (const d of delegations) ids.add(d.managedDepartmentId);

  return [...ids];
}

/**
 * The inverse of {@link manageableDepartmentIds} for a single department: the ids
 * of people who oversee `departmentId` by MEMBERSHIP, namely
 *   - everyone with an ACTIVE DIRECTOR TermMembership in the department, PLUS
 *   - everyone with an ACTIVE DIRECTOR membership in a department that manages it
 *     via a one-hop DepartmentDelegation (the managing side).
 * Deduped. Returns [] when there is no active term.
 *
 * This mirrors the director + delegation half of manageableDepartmentIds, so a
 * director who oversees the department but does not happen to hold a DIRECTOR
 * shift on the calendar is still counted. Permission-based approvers
 * (schedule.manage_requests / schedule.edit_all holders) are NOT included here;
 * compose those separately where the RBAC engine is available.
 */
export async function departmentDirectorPersonIds(departmentId: string): Promise<string[]> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return [];

  // Departments whose directors oversee this one: the department itself, plus any
  // department that manages it via a one-hop delegation (the managing side).
  const delegations = await prisma.departmentDelegation.findMany({
    where: { managedDepartmentId: departmentId },
    select: { managerDepartmentId: true },
  });
  const directingDepartmentIds = new Set<string>([departmentId]);
  for (const d of delegations) directingDepartmentIds.add(d.managerDepartmentId);

  const directorships = await prisma.termMembership.findMany({
    where: {
      termId: activeTerm.id,
      kind: "DIRECTOR",
      status: "ACTIVE",
      departmentId: { in: [...directingDepartmentIds] },
    },
    select: { personId: true },
  });

  return [...new Set(directorships.map((m) => m.personId))];
}
