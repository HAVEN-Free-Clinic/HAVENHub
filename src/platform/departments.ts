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
 * Returns the department ids where the person holds an ACTIVE TermMembership of
 * ANY kind (VOLUNTEER or DIRECTOR) in the ACTIVE term. This is the "own
 * departments" notion used to scope schedule.edit_own_dept and
 * schedule.manage_requests. Returns [] when there is no active term or the
 * person has no active membership.
 */
export async function memberDepartmentIds(personId: string): Promise<string[]> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return [];

  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId: activeTerm.id, status: "ACTIVE" },
    select: { departmentId: true },
  });

  return [...new Set(memberships.map((m) => m.departmentId))];
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
