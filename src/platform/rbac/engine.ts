import type { MembershipKind } from "@prisma/client";
import { prisma } from "@/platform/db";

const MEMBERSHIP_KIND_ROLE: Record<MembershipKind, string> = {
  DIRECTOR: "Director",
  VOLUNTEER: "Volunteer",
};

/**
 * Union of:
 *  - roles assigned directly to the person (global, or scoped to the active term)
 *  - roles assigned to departments the person actively belongs to in the active term
 *  - auto-attached system roles (Director/Volunteer) from active-term membership kind
 * Computed from live DB state on every call — role changes apply immediately (spec §5).
 */
export async function getEffectivePermissions(personId: string): Promise<Set<string>> {
  const activeTerm = await prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } });

  const memberships = activeTerm
    ? await prisma.termMembership.findMany({
        where: { personId, termId: activeTerm.id, status: "ACTIVE" },
      })
    : [];
  const departmentIds = [...new Set(memberships.map((m) => m.departmentId))];
  const autoRoleNames = [...new Set(memberships.map((m) => MEMBERSHIP_KIND_ROLE[m.kind]))];

  const [assignments, autoRoles] = await Promise.all([
    prisma.roleAssignment.findMany({
      where: {
        AND: [
          {
            OR: [
              { termId: null },
              ...(activeTerm ? [{ termId: activeTerm.id }] : []),
            ],
          },
          {
            OR: [
              { personId },
              ...(departmentIds.length ? [{ departmentId: { in: departmentIds } }] : []),
            ],
          },
        ],
      },
      include: { role: { include: { grants: true } } },
    }),
    autoRoleNames.length
      ? prisma.role.findMany({
          where: { name: { in: autoRoleNames }, isSystem: true },
          include: { grants: true },
        })
      : Promise.resolve([]),
  ]);

  const permissions = new Set<string>();
  for (const a of assignments) for (const g of a.role.grants) permissions.add(g.permission);
  for (const r of autoRoles) for (const g of r.grants) permissions.add(g.permission);
  return permissions;
}

/** The one place the "*" wildcard rule lives — use this on any Set from getEffectivePermissions. */
export function hasPermission(perms: Set<string>, permission: string): boolean {
  return perms.has(permission) || perms.has("*");
}

export async function can(personId: string, permission: string): Promise<boolean> {
  return hasPermission(await getEffectivePermissions(personId), permission);
}
