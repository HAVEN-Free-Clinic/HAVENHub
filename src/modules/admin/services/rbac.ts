/**
 * RBAC service: roles, grants, and assignments.
 *
 * All mutations accept an explicit actorPersonId for audit. Permission checks
 * are NOT the service's concern -- pages and server actions gate via
 * requirePermission. Services trust their callers and remain testable in
 * isolation.
 *
 * NOTE: Module enablement toggles (status stays code-driven in the registry)
 * are deferred; this service only manages role/grant/assignment records.
 * NOTE: The superadmin wildcard "*" grant is managed here and recognized by
 * the engine. Use with care -- it grants all permissions platform-wide.
 */

import type { Role, RoleGrant, RoleAssignment, Person, Department, Term, Track } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { MODULES } from "@/platform/modules/registry";
import { getActiveTerm } from "@/platform/terms/active-term";
import {
  LastAdminError,
  assertDeletingAssignmentKeepsAdminTx,
  assertActiveAdminRemainsTx,
} from "@/platform/rbac/last-admin";

// Re-export so callers that historically imported LastAdminError from this
// module keep working. The class now lives in the platform layer so the
// volunteers offboard path (which may not import modules/admin) can share it.
export { LastAdminError };

// ---------------------------------------------------------------------------
// Valid permission set (built from registry at module load time)
// ---------------------------------------------------------------------------

/** All permission strings declared across every module, plus the literal "*". */
const VALID_PERMISSIONS: Set<string> = new Set<string>(["*"]);
for (const m of MODULES) {
  for (const p of m.permissions) {
    VALID_PERMISSIONS.add(p);
  }
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class UnknownPermissionError extends Error {
  constructor(public permission: string) {
    super(`Unknown permission: "${permission}". Not declared in any module registry entry.`);
    this.name = "UnknownPermissionError";
  }
}

export class SystemRoleError extends Error {
  constructor(public roleId: string) {
    super(`Role ${roleId} is a system role and cannot be deleted.`);
    this.name = "SystemRoleError";
  }
}

export class RoleConflictError extends Error {
  constructor(public roleName: string) {
    super(`A role named "${roleName}" already exists.`);
    this.name = "RoleConflictError";
  }
}

export class AssignmentTargetError extends Error {
  constructor(public reason: string) {
    super(`Invalid assignment target: ${reason}.`);
    this.name = "AssignmentTargetError";
  }
}

export class DuplicateAssignmentError extends Error {
  constructor() {
    super("This role assignment already exists.");
    this.name = "DuplicateAssignmentError";
  }
}

export class AssignmentNotFoundError extends Error {
  constructor(public id: string) {
    super(`Role assignment ${id} not found.`);
    this.name = "AssignmentNotFoundError";
  }
}

export class RoleNotFoundError extends Error {
  constructor(public id: string) {
    super(`Role ${id} not found.`);
    this.name = "RoleNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that every permission in the list is known. Throws
 * UnknownPermissionError on the first unknown one found. The "*" wildcard
 * is always valid.
 */
function validatePermissions(permissions: string[]): void {
  for (const p of permissions) {
    if (!VALID_PERMISSIONS.has(p)) {
      throw new UnknownPermissionError(p);
    }
  }
}

/**
 * Detect whether a Prisma error is the expression-index duplicate violation
 * on RoleAssignment.create.
 *
 * P2002 (unique constraint violation) on RoleAssignment.create can only be
 * the COALESCE expression index (RoleAssignment_unique_grant) -- it is the
 * only unique constraint on the model (there is no @@unique in the Prisma
 * schema; the index lives in raw SQL). We therefore return true for any P2002
 * originating here without needing to inspect the target/message.
 */
function isDuplicateAssignmentError(err: unknown): boolean {
  return isUniqueConstraintError(err);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listRoles(): Promise<
  (Role & { grants: RoleGrant[]; _count: { assignments: number } })[]
> {
  return prisma.role.findMany({
    include: {
      grants: true,
      _count: { select: { assignments: true } },
    },
    orderBy: { name: "asc" },
  });
}

export async function listAssignments(): Promise<
  (RoleAssignment & {
    role: Role;
    person: Person | null;
    department: Department | null;
    term: Term | null;
  })[]
> {
  return prisma.roleAssignment.findMany({
    include: {
      role: true,
      person: true,
      department: true,
      term: true,
    },
    orderBy: { id: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Creates a new (non-system) role. Name is trimmed before storage.
 * Throws RoleConflictError on duplicate name (P2002).
 * Audits rbac.role_create with the role id.
 */
export async function createRole(
  actorPersonId: string,
  name: string,
  description: string | null
): Promise<Role> {
  const trimmedName = name.trim();

  let role: Role;
  try {
    role = await prisma.role.create({
      data: { name: trimmedName, description },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new RoleConflictError(trimmedName);
    }
    throw err;
  }

  await recordAudit({
    actorPersonId,
    action: "rbac.role_create",
    entityType: "Role",
    entityId: role.id,
    after: { name: role.name, description: role.description },
  });

  return role;
}

/**
 * Replace-set: deletes any grants not in the new list, creates any that are
 * new. Validates all permissions against the registry before touching the DB.
 * Throws UnknownPermissionError on the first invalid permission found.
 * Audits rbac.grants with sorted before/after permission arrays.
 *
 * All DB changes run inside a transaction so a failure leaves the role intact.
 */
export async function setRoleGrants(
  actorPersonId: string,
  roleId: string,
  permissions: string[]
): Promise<void> {
  // Validate all permissions BEFORE hitting the DB
  validatePermissions(permissions);

  const permSet = new Set(permissions);

  await prisma.$transaction(async (tx) => {
    // Fetch current grants to compute before snapshot and delta
    const existing = await tx.roleGrant.findMany({ where: { roleId } });
    const existingPerms = new Set(existing.map((g) => g.permission));

    // Lockout guard (audit 2026-07-13 F7): admin access is conferred by ANY role
    // holding "*"/"admin.access", not only the "Platform Admin" system role. The
    // old name-based check let a custom admin-conferring role be stripped down to
    // zero admins (lockout). Instead, if this edit removes the last admin grant of
    // a role that was conferring it, recompute the effective ACTIVE admin set after
    // the delta and refuse when it reaches zero. This only blocks when the removal
    // actually causes a lockout (any other live admin path keeps it allowed), and
    // mirrors the deleteAssignment / roster guards. Recovery: `npm run db:seed`.
    const wasAdminConferring = existing.some(
      (g) => g.permission === "*" || g.permission === "admin.access"
    );
    const stillAdminConferring = permSet.has("*") || permSet.has("admin.access");

    // Permissions to remove: exist now but not in the new set
    const toRemove = existing.filter((g) => !permSet.has(g.permission));
    // Permissions to add: in new set but not currently granted
    const toAdd = [...permSet].filter((p) => !existingPerms.has(p));

    if (toRemove.length > 0) {
      await tx.roleGrant.deleteMany({
        where: { id: { in: toRemove.map((g) => g.id) } },
      });
    }

    if (toAdd.length > 0) {
      await tx.roleGrant.createMany({
        data: toAdd.map((p) => ({ roleId, permission: p })),
      });
    }

    // With the delta applied inside the tx, verify an effective admin remains.
    // Throws LastAdminError (rolling the whole edit back) if this stripped the
    // last admin path.
    if (wasAdminConferring && !stillAdminConferring) {
      await assertActiveAdminRemainsTx(tx);
    }

    const beforePermissions = [...existingPerms].sort();
    const afterPermissions = [...permSet].sort();

    // recordAudit is called after the transaction commits in the outer scope,
    // but we need access to the before/after values computed here. We call it
    // inside the transaction intentionally -- audit table has no FK and
    // recordAudit swallows its own errors, so this is safe. The transaction
    // will commit even if the audit write fails.
    await recordAudit({
      actorPersonId,
      action: "rbac.grants",
      entityType: "Role",
      entityId: roleId,
      before: { permissions: beforePermissions },
      after: { permissions: afterPermissions },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/**
 * Deletes a non-system role. FK cascades clean up all grants and assignments.
 * Throws SystemRoleError when isSystem is true (guard is app-side before DB).
 * Audits rbac.role_delete with the role name in before.
 */
export async function deleteRole(actorPersonId: string, roleId: string): Promise<void> {
  const role = await prisma.role.findUnique({ where: { id: roleId } });

  if (!role) {
    // Role not found -- propagate as typed error; no audit
    throw new RoleNotFoundError(roleId);
  }

  if (role.isSystem) {
    throw new SystemRoleError(roleId);
  }

  // Lockout guard (audit 2026-07-13 F6): deleting a role FK-cascades its grants and
  // assignments. If this custom role confers admin access ("*"/"admin.access") and is
  // the sole path, the cascade would leave zero effective admins. Delete inside a
  // Serializable tx and recompute the effective ACTIVE admin set; a throw rolls the
  // delete back. Non-admin roles keep the plain (unguarded) delete. Recovery: db:seed.
  const grants = await prisma.roleGrant.findMany({ where: { roleId }, select: { permission: true } });
  const isAdminConferring = grants.some((g) => g.permission === "*" || g.permission === "admin.access");

  if (isAdminConferring) {
    await prisma.$transaction(
      async (tx) => {
        await tx.role.delete({ where: { id: roleId } });
        await assertActiveAdminRemainsTx(tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  } else {
    await prisma.role.delete({ where: { id: roleId } });
  }

  await recordAudit({
    actorPersonId,
    action: "rbac.role_delete",
    entityType: "Role",
    entityId: roleId,
    before: { name: role.name, description: role.description },
  });
}

/**
 * Creates a role assignment.
 *
 * XOR check is enforced app-side FIRST (before any DB call) using AssignmentTargetError.
 * Exactly one of personId or departmentId must be set.
 *
 * Duplicate assignments surface as DuplicateAssignmentError (the expression
 * index RoleAssignment_unique_grant uses COALESCE so it covers NULL termId).
 *
 * FK violations (bogus roleId / personId / departmentId / termId) surface as
 * AssignmentTargetError with the field name from Prisma error metadata.
 *
 * Audits rbac.assign with the assignment ids.
 */
export async function createAssignment(
  actorPersonId: string,
  input: {
    roleId: string;
    personId?: string;
    departmentId?: string;
    kind?: Track;
    termId?: string;
  }
): Promise<RoleAssignment> {
  const targetCount =
    (input.personId != null ? 1 : 0) +
    (input.departmentId != null ? 1 : 0) +
    (input.kind != null ? 1 : 0);

  if (targetCount === 0) {
    throw new AssignmentTargetError(
      "exactly one of personId, departmentId, or kind must be set; none was provided"
    );
  }
  if (targetCount > 1) {
    throw new AssignmentTargetError(
      "exactly one of personId, departmentId, or kind must be set; multiple were provided"
    );
  }
  if (input.kind != null && input.kind !== "DIRECTOR" && input.kind !== "VOLUNTEER") {
    throw new AssignmentTargetError(`invalid membership kind: ${input.kind}`);
  }

  let assignment: RoleAssignment;
  try {
    assignment = await prisma.roleAssignment.create({
      data: {
        roleId: input.roleId,
        personId: input.personId ?? null,
        departmentId: input.departmentId ?? null,
        kind: input.kind ?? null,
        termId: input.termId ?? null,
      },
    });
  } catch (err) {
    // Detect the expression-index duplicate violation (RoleAssignment_unique_grant)
    if (isDuplicateAssignmentError(err)) {
      throw new DuplicateAssignmentError();
    }

    // FK violation: bogus roleId / personId / departmentId / termId
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2003"
    ) {
      const field =
        typeof err.meta?.field_name === "string" ? err.meta.field_name : "unknown";
      throw new AssignmentTargetError(`invalid foreign key reference: ${field}`);
    }

    throw err;
  }

  await recordAudit({
    actorPersonId,
    action: "rbac.assign",
    entityType: "RoleAssignment",
    entityId: assignment.id,
    after: {
      roleId: assignment.roleId,
      personId: assignment.personId,
      departmentId: assignment.departmentId,
      kind: assignment.kind,
      termId: assignment.termId,
    },
  });

  return assignment;
}

/**
 * Deletes a role assignment by id.
 * Throws AssignmentNotFoundError when the id does not exist.
 * Audits rbac.unassign with the full assignment row snapshot in before.
 */
export async function deleteAssignment(actorPersonId: string, id: string): Promise<void> {
  const assignment = await prisma.roleAssignment.findUnique({
    where: { id },
    include: { role: { include: { grants: true } } },
  });

  if (!assignment) {
    throw new AssignmentNotFoundError(id);
  }

  // Lockout guard: if this role confers admin access (via a "*" or
  // "admin.access" grant), refuse the deletion when it would drop the number of
  // EFFECTIVE ACTIVE admin holders to zero.
  //
  // "Effective ACTIVE holders" (not raw assignment rows) is the load-bearing
  // distinction (audit M5): an offboarded person's still-present admin
  // assignment is inert (they cannot authenticate), so counting rows let the
  // only real admin's assignment be deleted into a full lockout. The
  // recomputation joins Person status ACTIVE and expands dept/kind-scoped grants
  // through active memberships, exactly as the engine resolves them.
  //
  // Shell-level recovery if lockout somehow occurs: `npm run db:seed`
  // re-seeds Platform Admin with the "*" grant and a default admin assignment.
  const isAdminConferring = assignment.role.grants.some(
    (g) => g.permission === "*" || g.permission === "admin.access"
  );
  if (isAdminConferring) {
    const activeTerm = await getActiveTerm();
    // Only a LIVE assignment (global, or scoped to the ACTIVE term) contributes
    // admin access. Deleting an inert one (scoped to a non-active/archived term)
    // cannot reduce the admin population, so it needs no guard (audit L16; mirrors
    // the early no-op check assertNotLastActiveAdmin does when the target confers
    // nothing).
    const isLive =
      assignment.termId === null ||
      (activeTerm !== null && assignment.termId === activeTerm.id);
    if (isLive) {
      // Recompute effective ACTIVE admins as if this row were already gone and
      // delete inside one Serializable transaction. A plain check-then-delete lets
      // two concurrent deletes both see another admin remaining and both delete
      // (write skew), removing the last admin. Serializable makes Postgres abort
      // the loser instead of locking everyone out.
      await prisma.$transaction(
        async (tx) => {
          await assertDeletingAssignmentKeepsAdminTx(tx, activeTerm, id);
          await tx.roleAssignment.delete({ where: { id } });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } else {
      await prisma.roleAssignment.delete({ where: { id } });
    }
  } else {
    await prisma.roleAssignment.delete({ where: { id } });
  }

  await recordAudit({
    actorPersonId,
    action: "rbac.unassign",
    entityType: "RoleAssignment",
    entityId: id,
    before: {
      roleId: assignment.roleId,
      personId: assignment.personId,
      departmentId: assignment.departmentId,
      kind: assignment.kind,
      termId: assignment.termId,
    },
  });
}
