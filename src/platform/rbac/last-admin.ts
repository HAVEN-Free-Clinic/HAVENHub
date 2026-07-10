import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";

/**
 * Last-admin invariant (platform-level, shared).
 *
 * This lives in the platform layer, not in modules/admin, so BOTH offboard
 * callers can reach it: the admin people page (which may import modules/admin)
 * AND the volunteers offboarding service (which may NOT import another module
 * per the ESLint boundary). Platform is the only common ground, so the guard and
 * its error type both live here. modules/admin re-exports LastAdminError for the
 * callers that historically imported it from there.
 */

/**
 * Thrown when a mutation would remove every admin-conferring grant or
 * assignment, or offboard the last person who effectively holds one, leaving no
 * way to access the admin module.
 *
 * Recovery at the shell level: `npm run db:seed` re-seeds the Platform Admin
 * role and assigns it to the configured admin user. This is the intended
 * escape hatch if the invariant is ever violated through a direct DB
 * manipulation rather than through the guarded service paths.
 */
export class LastAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LastAdminError";
  }
}

/** Permissions that confer access to the admin module. */
const ADMIN_CONFERRING = ["*", "admin.access"];

/**
 * The set of ACTIVE person ids who effectively hold an admin-conferring grant
 * ("*" or "admin.access"), computed the way the RBAC engine resolves
 * permissions (see getEffectivePermissions):
 *  - only assignments the engine honors count (termId null, i.e. global, or
 *    scoped to the ACTIVE term); assignments scoped to a non-active/archived
 *    term confer nothing;
 *  - department- and kind-scoped grants resolve through ACTIVE memberships in
 *    the ACTIVE term;
 *  - only ACTIVE people can authenticate (getActivePerson returns null for any
 *    non-ACTIVE status), so offboarded holders do not count.
 */
async function activeAdminPersonIds(): Promise<Set<string>> {
  const activeTerm = await getActiveTerm();

  const adminGrants = await prisma.roleGrant.findMany({
    where: { permission: { in: ADMIN_CONFERRING } },
    select: { roleId: true },
  });
  const roleIds = [...new Set(adminGrants.map((g) => g.roleId))];
  if (roleIds.length === 0) return new Set();

  const assignments = await prisma.roleAssignment.findMany({
    where: {
      roleId: { in: roleIds },
      OR: [{ termId: null }, ...(activeTerm ? [{ termId: activeTerm.id }] : [])],
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

  // Department- and kind-scoped admin grants resolve through ACTIVE memberships
  // in the ACTIVE term (mirrors engine.ts). With no active term there are no
  // such members.
  if (activeTerm && (departmentIds.size > 0 || kinds.size > 0)) {
    const memberships = await prisma.termMembership.findMany({
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

  // Only ACTIVE people can authenticate into the admin module.
  const active = await prisma.person.findMany({
    where: { id: { in: [...personIds] }, status: "ACTIVE" },
    select: { id: true },
  });
  return new Set(active.map((p) => p.id));
}

/**
 * Guard invoked before transitioning a person AWAY from ACTIVE (offboarding).
 * Throws LastAdminError when this person is the last ACTIVE holder of an
 * admin-conferring grant, which would otherwise leave the admin module
 * unreachable (an offboarded person can no longer authenticate).
 *
 * A no-op when the person does not currently confer admin access: offboarding
 * them cannot reduce the admin population. Only guards the ACTIVE -> non-active
 * direction; reactivation is never guarded.
 */
export async function assertNotLastActiveAdmin(personId: string): Promise<void> {
  const admins = await activeAdminPersonIds();
  if (!admins.has(personId)) return;
  admins.delete(personId);
  if (admins.size === 0) {
    throw new LastAdminError(
      "This person is the last active admin; offboarding them would lock everyone out of the admin module."
    );
  }
}
