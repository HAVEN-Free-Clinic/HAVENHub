import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { effectivePermissionHolderIds } from "./permission-holders";

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

/**
 * The set of ACTIVE person ids who effectively hold admin.access (or the "*"
 * wildcard, which effectivePermissionHolderIds folds in).
 *
 * The resolution rules live in effectivePermissionHolderIds, which this used to
 * implement inline for admin.access alone. Any other caller asking "who holds
 * permission X" gets the same term scoping, department/kind resolution, and
 * ACTIVE-person filter from that one place rather than reinventing a weaker
 * version of it.
 */
async function effectiveActiveAdminPersonIds(
  client: Prisma.TransactionClient,
  activeTerm: { id: string } | null,
  opts: { excludeAssignmentId?: string } = {}
): Promise<Set<string>> {
  return effectivePermissionHolderIds(client, "admin.access", activeTerm, opts);
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
/**
 * True when at least one person is an effective admin with `term` active.
 *
 * Exposed for the term mutations, which need the BEFORE state to tell "this swap
 * locked everyone out" apart from "this deployment never had an admin". The
 * invariant is that a change must not REMOVE the last admin; requiring one to
 * exist would turn an already-broken deployment (and every test fixture that
 * does not seed RBAC) into one that cannot activate or archive a term either.
 */
export async function hasEffectiveActiveAdminTx(
  tx: Prisma.TransactionClient,
  term: { id: string } | null
): Promise<boolean> {
  return (await effectiveActiveAdminPersonIds(tx, term)).size > 0;
}

export async function assertActiveAdminRemainsTx(
  tx: Prisma.TransactionClient,
  /**
   * The term to evaluate against, when the caller is the thing CHANGING which
   * term is active (activateTerm, archiveTerm). Omit to resolve it normally.
   *
   * getActiveTerm() reads committed state and is React-cached per request, so
   * inside a term swap it still returns the OUTGOING term -- which is precisely
   * the wrong anchor for "will anyone be an admin after this commits?". Pass the
   * intended term instead. `null` is a real value here, meaning "no term will be
   * active", which is the allowed outcome of archiving the last one; `undefined`
   * means "look it up" (audit 14, finding VRT-4).
   */
  activeTermOverride?: { id: string } | null
): Promise<void> {
  const activeTerm =
    activeTermOverride !== undefined ? activeTermOverride : await getActiveTerm();
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
