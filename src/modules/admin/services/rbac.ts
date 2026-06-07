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

import type { Role, RoleGrant, RoleAssignment, Person, Department, Term } from "@prisma/client";
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
 * on RoleAssignment_unique_grant. The COALESCE expression index surfaces as
 * either a P2002 with the index name in meta, or a PrismaClientKnownRequestError
 * whose message contains the index name.
 */
function isDuplicateAssignmentError(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === "P2002") {
    const target = (err.meta?.target as string | string[] | undefined) ?? "";
    const targetStr = Array.isArray(target) ? target.join(",") : target;
    if (targetStr.includes("RoleAssignment_unique_grant")) return true;
    // Fallback: check the message itself
    if (err.message.includes("RoleAssignment_unique_grant")) return true;
    // For expression indexes, Prisma sometimes does not populate target; check
    // if there is no clearer target (meaning this P2002 is for role assignments)
    return true;
  }
  // Prisma may surface expression-index violations as a generic known-request error
  if (err.message.includes("RoleAssignment_unique_grant")) return true;
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
    // Role not found -- propagate as a generic not-found; no audit
    throw new Error(`Role ${roleId} not found`);
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
    termId?: string;
  }
): Promise<void> {
  const hasPersonId = input.personId != null;
  const hasDeptId = input.departmentId != null;

  // XOR check app-side FIRST
  if (!hasPersonId && !hasDeptId) {
    throw new AssignmentTargetError(
      "exactly one of personId or departmentId must be set; neither was provided"
    );
  }
  if (hasPersonId && hasDeptId) {
    throw new AssignmentTargetError(
      "exactly one of personId or departmentId must be set; both were provided"
    );
  }

  let assignment: RoleAssignment;
  try {
    assignment = await prisma.roleAssignment.create({
      data: {
        roleId: input.roleId,
        personId: input.personId ?? null,
        departmentId: input.departmentId ?? null,
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
      termId: assignment.termId,
    },
  });
}

/**
 * Deletes a role assignment by id.
 * Throws AssignmentNotFoundError when the id does not exist.
 * Audits rbac.unassign with the full assignment row snapshot in before.
 */
export async function deleteAssignment(actorPersonId: string, id: string): Promise<void> {
  const assignment = await prisma.roleAssignment.findUnique({ where: { id } });

  if (!assignment) {
    throw new AssignmentNotFoundError(id);
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
      termId: assignment.termId,
    },
  });
}
