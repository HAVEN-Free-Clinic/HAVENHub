import { Prisma, type Track } from "@prisma/client";
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
 *
 * Accepts an explicit client so the resolution can run inside an interactive
 * (Serializable) transaction, and an optional excludeAssignmentId so a caller
 * can ask "who would still be admin if THIS assignment were gone" without
 * deleting it first. activeTerm is passed in (rather than fetched here) to match
 * the surrounding "read the active term once, use it inside the tx" pattern.
 */
async function effectiveActiveAdminPersonIds(
  client: Prisma.TransactionClient,
  activeTerm: { id: string } | null,
  opts: { excludeAssignmentId?: string } = {}
): Promise<Set<string>> {
  const adminGrants = await client.roleGrant.findMany({
    where: { permission: { in: ADMIN_CONFERRING } },
    select: { roleId: true },
  });
  const roleIds = [...new Set(adminGrants.map((g) => g.roleId))];
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

  // Department- and kind-scoped admin grants resolve through ACTIVE memberships
  // in the ACTIVE term (mirrors engine.ts). With no active term there are no
  // such members.
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

  // Only ACTIVE people can authenticate into the admin module.
  const active = await client.person.findMany({
    where: { id: { in: [...personIds] }, status: "ACTIVE" },
    select: { id: true },
  });
  return new Set(active.map((p) => p.id));
}

/**
 * Shared invariant: given the current effective ACTIVE admin set, refuse when
 * removing `personId` from it would leave nobody. A no-op when the person is not
 * currently an effective admin (offboarding them cannot reduce the population).
 */
function assertRemovingPersonKeepsAdmin(admins: Set<string>, personId: string): void {
  if (!admins.has(personId)) return;
  admins.delete(personId);
  if (admins.size === 0) {
    throw new LastAdminError(
      "This person is the last active admin; offboarding them would lock everyone out of the admin module."
    );
  }
}

/**
 * Guard invoked before transitioning a person AWAY from ACTIVE (offboarding).
 * Throws LastAdminError when this person is the last ACTIVE holder of an
 * admin-conferring grant, which would otherwise leave the admin module
 * unreachable (an offboarded person can no longer authenticate).
 *
 * A no-op when the person does not currently confer admin access. Only guards
 * the ACTIVE -> non-active direction; reactivation is never guarded. Prefer the
 * transactional twin (assertNotLastActiveAdminTx) at real offboard call sites so
 * the check and the status flip commit atomically; this standalone form remains
 * for direct callers and tests.
 */
export async function assertNotLastActiveAdmin(personId: string): Promise<void> {
  const activeTerm = await getActiveTerm();
  assertRemovingPersonKeepsAdmin(
    await effectiveActiveAdminPersonIds(prisma, activeTerm),
    personId
  );
}

/**
 * Transactional twin of assertNotLastActiveAdmin: recomputes the effective
 * ACTIVE admin set on the given transaction client so the check and the caller's
 * Person.status flip commit atomically. Under Serializable isolation this stops
 * two concurrent offboards of the last two admins from both passing a separate
 * read and leaving zero admins (write skew). Throws LastAdminError.
 */
export async function assertNotLastActiveAdminTx(
  tx: Prisma.TransactionClient,
  personId: string
): Promise<void> {
  const activeTerm = await getActiveTerm();
  assertRemovingPersonKeepsAdmin(
    await effectiveActiveAdminPersonIds(tx, activeTerm),
    personId
  );
}

/**
 * True when `personId` is currently one of the effective ACTIVE admins. Roster
 * mutations use this as a fast pre-check: a member who confers no admin access
 * can be removed/demoted without the (Serializable) last-admin recomputation.
 */
export async function isEffectiveActiveAdmin(personId: string): Promise<boolean> {
  const activeTerm = await getActiveTerm();
  return (await effectiveActiveAdminPersonIds(prisma, activeTerm)).has(personId);
}

/**
 * Post-mutation invariant for roster changes: recompute the effective ACTIVE
 * admin set on the transaction client and refuse when it is empty. Callers run
 * their soft-remove/demote first inside a Serializable tx, then call this so the
 * mutation rolls back if it stripped the last dept/kind-scoped admin path
 * (audit L7). Throws LastAdminError.
 */
export async function assertActiveAdminRemainsTx(tx: Prisma.TransactionClient): Promise<void> {
  const activeTerm = await getActiveTerm();
  const admins = await effectiveActiveAdminPersonIds(tx, activeTerm);
  if (admins.size === 0) {
    throw new LastAdminError(
      "This change would remove the last active admin, locking everyone out of the admin module."
    );
  }
}

/**
 * Deletion-time invariant for admin-conferring RoleAssignments: recompute the
 * effective ACTIVE admin set as if `assignmentId` were already gone, and refuse
 * when that leaves nobody. Counting effective ACTIVE holders (not raw rows) means
 * an inert (archived-term) or offboarded holder can no longer mask a real lockout
 * (audit M5). Run inside the same Serializable tx as the delete. Throws
 * LastAdminError.
 */
export async function assertDeletingAssignmentKeepsAdminTx(
  tx: Prisma.TransactionClient,
  activeTerm: { id: string } | null,
  assignmentId: string
): Promise<void> {
  const admins = await effectiveActiveAdminPersonIds(tx, activeTerm, {
    excludeAssignmentId: assignmentId,
  });
  if (admins.size === 0) {
    throw new LastAdminError(
      "This is the last live assignment that confers admin access; deleting it would lock everyone out of the admin module."
    );
  }
}
