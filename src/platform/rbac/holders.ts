import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";

/** A person who effectively holds a queried permission, shaped for notify(). */
export type PermissionHolder = {
  id: string;
  name: string;
  contactEmail: string | null;
  entraObjectId: string | null;
};

/**
 * The baseline system roles the engine auto-attaches from membership kind
 * (see engine.ts MEMBERSHIP_KIND_ROLE). They are never wired through
 * RoleAssignment, so this resolver folds them in directly.
 */
const AUTO_ROLE_KIND: Record<string, Track> = {
  Director: "DIRECTOR",
  Volunteer: "VOLUNTEER",
};

/**
 * Resolve the ACTIVE people whose effective permissions include any of
 * `permissions`. The inverse of getEffectivePermissions: it walks the same
 * sources (direct/person, department, and kind role assignments scoped to the
 * global or active term, plus the auto-attached Director/Volunteer baselines)
 * and treats a "*" grant as matching every queried permission.
 *
 * Returns notification-shaped rows (id/name/contactEmail/entraObjectId),
 * deduplicated and ordered by name. Used to drive staff notifications such as
 * the HIPAA completion-date review queue.
 */
export async function peopleWithAnyPermission(permissions: string[]): Promise<PermissionHolder[]> {
  if (permissions.length === 0) return [];

  const activeTerm = await getActiveTerm();

  // Roles that grant any queried permission, or the "*" wildcard.
  const roles = await prisma.role.findMany({
    where: { grants: { some: { permission: { in: [...permissions, "*"] } } } },
    select: { id: true, name: true, isSystem: true },
  });
  if (roles.length === 0) return [];
  const roleIds = roles.map((r) => r.id);

  const assignments = await prisma.roleAssignment.findMany({
    where: {
      roleId: { in: roleIds },
      OR: [{ termId: null }, ...(activeTerm ? [{ termId: activeTerm.id }] : [])],
    },
    select: { personId: true, departmentId: true, kind: true },
  });

  const directPersonIds = new Set<string>();
  const departmentIds = new Set<string>();
  const kinds = new Set<Track>();
  for (const a of assignments) {
    if (a.personId) directPersonIds.add(a.personId);
    if (a.departmentId) departmentIds.add(a.departmentId);
    if (a.kind) kinds.add(a.kind);
  }

  // Fold in auto-attached baseline roles: a queried permission granted by the
  // Director/Volunteer system role applies to every active member of that kind.
  for (const r of roles) {
    if (r.isSystem && AUTO_ROLE_KIND[r.name]) kinds.add(AUTO_ROLE_KIND[r.name]);
  }

  const memberIds = new Set<string>();
  if (activeTerm && (departmentIds.size > 0 || kinds.size > 0)) {
    const orClauses = [
      ...(departmentIds.size > 0 ? [{ departmentId: { in: [...departmentIds] } }] : []),
      ...(kinds.size > 0 ? [{ kind: { in: [...kinds] } }] : []),
    ];
    const memberships = await prisma.termMembership.findMany({
      where: { termId: activeTerm.id, status: "ACTIVE", OR: orClauses },
      select: { personId: true },
    });
    for (const m of memberships) memberIds.add(m.personId);
  }

  const allIds = [...new Set([...directPersonIds, ...memberIds])];
  if (allIds.length === 0) return [];

  return prisma.person.findMany({
    where: { id: { in: allIds }, status: "ACTIVE" },
    select: { id: true, name: true, contactEmail: true, entraObjectId: true },
    orderBy: { name: "asc" },
  });
}
