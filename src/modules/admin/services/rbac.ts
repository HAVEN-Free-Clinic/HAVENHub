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
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { MODULES } from "@/platform/modules/registry";

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

/**
 * Thrown when a mutation would remove every admin-conferring grant or
 * assignment, leaving no way to access the admin module.
 *
 * Recovery at the shell level: `npm run db:seed` re-seeds the Platform Admin
 * role and assigns it to the configured admin user. This is the intended
 * escape hatch if the invariant is ever violated through a direct DB
 * manipulation rather than through this service.
 */
export class LastAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LastAdminError";
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
 *
 * The non-P2002 message-fallback branch that previously existed was
 * unreachable: Prisma always surfaces unique violations as P2002, never as
 * a generic known-request error. It has been removed to avoid dead code.
 */
function isDuplicateAssignmentError(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  // P2002 on RoleAssignment.create is always the expression unique index --
  // the only unique constraint on this model.
  if (err.code === "P2002") return true;
  return false;
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
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
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

    // Lockout guard: the "Platform Admin" system role must always retain at
    // least one admin-conferring grant ("*" or "admin.access"). Removing both
    // would make the admin module unreachable by anyone.
    //
    // This is a conservative but simple invariant: we guard only the specific
    // named system role that is the canonical admin-access entry point. If
    // "admin.access" were ever renamed, a schema migration would need to update
    // this guard too (or rely on seed recovery -- see LastAdminError comment).
    //
    // Shell-level recovery if lockout somehow occurs: `npm run db:seed`
    // re-seeds Platform Admin with the "*" grant and a default admin assignment.
    const role = await tx.role.findUnique({ where: { id: roleId }, select: { isSystem: true, name: true } });
    if (role?.isSystem && role.name === "Platform Admin") {
      const hasAdminAccess = permSet.has("*") || permSet.has("admin.access");
      if (!hasAdminAccess) {
        throw new LastAdminError(
          "Platform Admin must keep * or admin.access; removing it would lock everyone out of the admin module."
        );
      }
    }
    const existingPerms = new Set(existing.map((g) => g.permission));

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
  });
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

  await prisma.role.delete({ where: { id: roleId } });

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
  // "admin.access" grant) and this is the last remaining assignment of that
  // role, refuse the deletion.
  //
  // This is a conservative approximation: another role might also grant
  // admin.access, so refusing here may be overly strict in those cases.
  // However, the safe, simple invariant is to protect the last assignment of
  // ANY admin-conferring role rather than doing a cross-role reachability
  // check. Operators can work around this by assigning the role to another
  // person first, then removing the old assignment.
  //
  // Shell-level recovery if lockout somehow occurs: `npm run db:seed`
  // re-seeds Platform Admin with the "*" grant and a default admin assignment.
  const isAdminConferring = assignment.role.grants.some(
    (g) => g.permission === "*" || g.permission === "admin.access"
  );
  if (isAdminConferring) {
    const count = await prisma.roleAssignment.count({ where: { roleId: assignment.roleId } });
    if (count === 1) {
      throw new LastAdminError(
        "This is the last assignment of an admin-conferring role; deleting it would lock everyone out."
      );
    }
  }

  await prisma.roleAssignment.delete({ where: { id } });

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
