import { cache } from "react";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";

/**
 * Union of:
 *  - roles assigned directly to the person (global, or scoped to the active term)
 *  - roles assigned to departments the person actively belongs to in the active term
 *  - roles assigned to the person's active-term membership kinds (DIRECTOR/VOLUNTEER)
 *
 * Baseline Director/Volunteer access is provisioned as kind-target RoleAssignment
 * rows (see prisma/seed.ts and the backfill migration), NOT auto-attached in code,
 * so the roles page is the single source of truth. Computed from live DB state and
 * memoized per request via React cache(): repeated calls in one render hit the DB
 * once, and role changes apply on the next request.
 */
export const getEffectivePermissions = cache(
  async (personId: string): Promise<Set<string>> => {
    const activeTerm = await getActiveTerm();

    const memberships = activeTerm
      ? await prisma.termMembership.findMany({
          where: { personId, termId: activeTerm.id, status: "ACTIVE" },
        })
      : [];
    const departmentIds = [...new Set(memberships.map((m) => m.departmentId))];
    const membershipKinds = [...new Set(memberships.map((m) => m.kind))];

    const assignments = await prisma.roleAssignment.findMany({
      where: {
        AND: [
          {
            OR: [{ termId: null }, ...(activeTerm ? [{ termId: activeTerm.id }] : [])],
          },
          {
            OR: [
              { personId },
              ...(departmentIds.length ? [{ departmentId: { in: departmentIds } }] : []),
              ...(membershipKinds.length ? [{ kind: { in: membershipKinds } }] : []),
            ],
          },
        ],
      },
      include: { role: { include: { grants: true } } },
    });

    const permissions = new Set<string>();
    for (const a of assignments) for (const g of a.role.grants) permissions.add(g.permission);
    return permissions;
  },
);

/** The one place the "*" wildcard rule lives. Use this on any Set from getEffectivePermissions. */
export function hasPermission(perms: Set<string>, permission: string): boolean {
  return perms.has(permission) || perms.has("*");
}

export async function can(personId: string, permission: string): Promise<boolean> {
  return hasPermission(await getEffectivePermissions(personId), permission);
}
