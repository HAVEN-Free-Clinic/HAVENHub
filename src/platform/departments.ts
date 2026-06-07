/**
 * Department delegation helpers.
 *
 * A director's compliance scope extends beyond their own department(s) by one
 * hop through DepartmentDelegation edges. For example, a PCAR director also
 * oversees SCTP and JCTP because PCAR manages those departments.
 */

import { prisma } from "@/platform/db";

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
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
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
