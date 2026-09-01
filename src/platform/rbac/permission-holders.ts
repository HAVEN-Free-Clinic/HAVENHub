import { Prisma, type Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";

/**
 * "Who effectively holds permission X right now?", resolved the way the RBAC
 * engine resolves it for a single person (see engine.ts getEffectivePermissions).
 *
 * The naive version of this question -- read RoleGrant, walk role.assignments,
 * take assignment.person -- is wrong in three ways that all fail silently:
 *
 *   - a grant reaches people through a DEPARTMENT or a membership KIND, not only
 *     through a personId. Those assignments have personId = null, so the naive
 *     walk skips them entirely and the department-scoped holders (usually the
 *     majority) resolve to nobody;
 *   - assignments scoped to a non-active term confer nothing, so an archived
 *     term's holders must not come back;
 *   - only ACTIVE people can authenticate, so an offboarded holder is not a
 *     holder.
 *
 * A role granting "*" confers every permission, so the wildcard is always part
 * of the lookup.
 *
 * Extracted from last-admin.ts, which asked exactly this question about
 * admin.access and is now one caller of it.
 */
export async function effectivePermissionHolderIds(
  client: Prisma.TransactionClient | typeof prisma,
  permission: string,
  activeTerm: { id: string } | null,
  opts: { excludeAssignmentId?: string } = {},
): Promise<Set<string>> {
  const grants = await client.roleGrant.findMany({
    where: { permission: { in: [permission, "*"] } },
    select: { roleId: true },
  });
  const roleIds = [...new Set(grants.map((g) => g.roleId))];
  if (roleIds.length === 0) return new Set();

  const assignments = await client.roleAssignment.findMany({
    where: {
      roleId: { in: roleIds },
      OR: [{ termId: null }, ...(activeTerm ? [{ termId: activeTerm.id }] : [])],
      // id is a non-null primary key, so `not` is safe here (no NULL-drop hazard).
      ...(opts.excludeAssignmentId ? { id: { not: opts.excludeAssignmentId } } : {}),
    },
    select: { personId: true, departmentId: true, kind: true },
  });

  const personIds = new Set<string>();
  const departmentIds = new Set<string>();
  const kinds = new Set<Track>();
  for (const a of assignments) {
    if (a.personId) personIds.add(a.personId);
    if (a.departmentId) departmentIds.add(a.departmentId);
    if (a.kind) kinds.add(a.kind);
  }

  // Department- and kind-scoped grants resolve through ACTIVE memberships in the
  // ACTIVE term (mirrors engine.ts). With no active term there are no such members.
  if (activeTerm && (departmentIds.size > 0 || kinds.size > 0)) {
    const memberships = await client.termMembership.findMany({
      where: {
        termId: activeTerm.id,
        status: "ACTIVE",
        OR: [
          ...(departmentIds.size ? [{ departmentId: { in: [...departmentIds] } }] : []),
          ...(kinds.size ? [{ kind: { in: [...kinds] } }] : []),
        ],
      },
      select: { personId: true },
    });
    for (const m of memberships) personIds.add(m.personId);
  }

  if (personIds.size === 0) return new Set();

  const active = await client.person.findMany({
    where: { id: { in: [...personIds] }, status: "ACTIVE" },
    select: { id: true },
  });
  return new Set(active.map((p) => p.id));
}

/**
 * The ACTIVE people who effectively hold `permission`, with the fields a
 * notification needs. Resolves the active term itself, so callers outside a
 * transaction do not have to.
 */
export async function peopleWithPermission(permission: string): Promise<
  Array<{ id: string; name: string; contactEmail: string | null; entraObjectId: string | null }>
> {
  const activeTerm = await getActiveTerm();
  const ids = await effectivePermissionHolderIds(prisma, permission, activeTerm);
  if (ids.size === 0) return [];
  return prisma.person.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true, contactEmail: true, entraObjectId: true },
    orderBy: { name: "asc" },
  });
}
