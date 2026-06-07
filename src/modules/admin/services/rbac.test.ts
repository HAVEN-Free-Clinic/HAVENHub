/**
 * RBAC service tests (TDD: written before the implementation).
 *
 * Tests cover:
 * - listRoles: returns roles with grants and assignment counts
 * - createRole: name trimmed; duplicate name -> RoleConflictError; audit rbac.role_create
 * - setRoleGrants: replace-set semantics (adds new, removes stale); validates permissions
 *   against registry; "*" is allowed; unknown permission -> UnknownPermissionError;
 *   audit rbac.grants with before/after sorted permission arrays
 * - deleteRole: refuses isSystem roles (SystemRoleError); cascades grants/assignments; audit rbac.role_delete
 * - listAssignments: returns assignments with role, person, department, term relations
 * - createAssignment: XOR enforced app-side (AssignmentTargetError when neither or both set);
 *   duplicate assignment -> DuplicateAssignmentError; FK violation (bogus IDs) -> AssignmentTargetError;
 *   audit rbac.assign
 * - deleteAssignment: typed not-found; audit rbac.unassign with before snapshot
 * - Engine integration: can() returns true after assignment, false after deleteAssignment
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { can } from "@/platform/rbac/engine";
import {
  listRoles,
  createRole,
  setRoleGrants,
  deleteRole,
  listAssignments,
  createAssignment,
  deleteAssignment,
  UnknownPermissionError,
  SystemRoleError,
  RoleConflictError,
  AssignmentTargetError,
  DuplicateAssignmentError,
  AssignmentNotFoundError,
  LastAdminError,
} from "./rbac";

const ACTOR = "actor-person-id";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedRole(name: string, isSystem = false) {
  return prisma.role.create({ data: { name, isSystem } });
}

async function seedPerson(name: string) {
  return prisma.person.create({ data: { name } });
}

async function seedDepartment(code: string) {
  return prisma.department.create({ data: { code, name: `Dept ${code}` } });
}

async function seedTerm(code: string, status: "ACTIVE" | "PLANNING" | "ARCHIVED" = "ACTIVE") {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2026-01-01T12:00:00Z"),
      endDate: new Date("2026-04-30T12:00:00Z"),
      status,
    },
  });
}

// ---------------------------------------------------------------------------
// listRoles
// ---------------------------------------------------------------------------

describe("listRoles", () => {
  beforeEach(resetDb);

  it("returns roles with their grants and assignment counts", async () => {
    const role = await seedRole("Test Role");
    await prisma.roleGrant.create({ data: { roleId: role.id, permission: "admin.access" } });
    const person = await seedPerson("Alice");
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: person.id } });

    const roles = await listRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0].name).toBe("Test Role");
    expect(roles[0].grants).toHaveLength(1);
    expect(roles[0].grants[0].permission).toBe("admin.access");
    expect(roles[0]._count.assignments).toBe(1);
  });

  it("returns an empty array when no roles exist", async () => {
    const roles = await listRoles();
    expect(roles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createRole
// ---------------------------------------------------------------------------

describe("createRole", () => {
  beforeEach(resetDb);

  it("creates a role with trimmed name and optional description", async () => {
    const role = await createRole(ACTOR, "  Admin Role  ", "manages everything");
    expect(role.name).toBe("Admin Role");
    expect(role.description).toBe("manages everything");
    expect(role.isSystem).toBe(false);
  });

  it("creates a role with null description", async () => {
    const role = await createRole(ACTOR, "No Desc Role", null);
    expect(role.description).toBeNull();
  });

  it("writes an audit entry with action rbac.role_create", async () => {
    const role = await createRole(ACTOR, "Audited Role", null);

    const logs = await prisma.auditLog.findMany({ where: { action: "rbac.role_create" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorPersonId).toBe(ACTOR);
    expect(logs[0].entityId).toBe(role.id);
  });

  it("throws RoleConflictError on duplicate name (P2002)", async () => {
    await createRole(ACTOR, "Duplicate Role", null);
    await expect(createRole(ACTOR, "Duplicate Role", null)).rejects.toBeInstanceOf(RoleConflictError);
  });

  it("trims whitespace from name before checking duplicates", async () => {
    await createRole(ACTOR, "Trimmed", null);
    await expect(createRole(ACTOR, "  Trimmed  ", null)).rejects.toBeInstanceOf(RoleConflictError);
  });
});

// ---------------------------------------------------------------------------
// setRoleGrants
// ---------------------------------------------------------------------------

describe("setRoleGrants", () => {
  beforeEach(resetDb);

  it("sets the full permission list (replaces: removes stale, adds new)", async () => {
    const role = await seedRole("Grants Role");
    // Start with two permissions
    await prisma.roleGrant.createMany({
      data: [
        { roleId: role.id, permission: "admin.access" },
        { roleId: role.id, permission: "admin.manage_people" },
      ],
    });

    // Replace with a different set - keep admin.access, drop manage_people, add manage_terms
    await setRoleGrants(ACTOR, role.id, ["admin.access", "admin.manage_terms"]);

    const grants = await prisma.roleGrant.findMany({ where: { roleId: role.id } });
    const perms = grants.map((g) => g.permission).sort();
    expect(perms).toEqual(["admin.access", "admin.manage_terms"]);
  });

  it("sets an empty permission list (removes all grants)", async () => {
    const role = await seedRole("Empty Role");
    await prisma.roleGrant.create({ data: { roleId: role.id, permission: "admin.access" } });

    await setRoleGrants(ACTOR, role.id, []);

    const grants = await prisma.roleGrant.findMany({ where: { roleId: role.id } });
    expect(grants).toHaveLength(0);
  });

  it("allows the literal '*' permission", async () => {
    const role = await seedRole("Wildcard Role");
    await expect(setRoleGrants(ACTOR, role.id, ["*"])).resolves.not.toThrow();

    const grants = await prisma.roleGrant.findMany({ where: { roleId: role.id } });
    expect(grants[0].permission).toBe("*");
  });

  it("throws UnknownPermissionError for a permission not in the registry", async () => {
    const role = await seedRole("Unknown Perm Role");
    await expect(
      setRoleGrants(ACTOR, role.id, ["not.a.real.permission"])
    ).rejects.toBeInstanceOf(UnknownPermissionError);
  });

  it("throws UnknownPermissionError and does not modify grants when any permission is invalid", async () => {
    const role = await seedRole("Partial Bad Role");
    await prisma.roleGrant.create({ data: { roleId: role.id, permission: "admin.access" } });

    await expect(
      setRoleGrants(ACTOR, role.id, ["admin.access", "definitely.not.real"])
    ).rejects.toBeInstanceOf(UnknownPermissionError);

    // Grants should be unchanged
    const grants = await prisma.roleGrant.findMany({ where: { roleId: role.id } });
    expect(grants).toHaveLength(1);
    expect(grants[0].permission).toBe("admin.access");
  });

  it("writes an audit entry rbac.grants with sorted before/after permission arrays", async () => {
    const role = await seedRole("Audit Grants Role");
    await prisma.roleGrant.createMany({
      data: [
        { roleId: role.id, permission: "admin.manage_people" },
        { roleId: role.id, permission: "admin.access" },
      ],
    });

    await setRoleGrants(ACTOR, role.id, ["admin.manage_terms", "admin.access"]);

    const logs = await prisma.auditLog.findMany({ where: { action: "rbac.grants" } });
    expect(logs).toHaveLength(1);
    const log = logs[0];
    expect(log.actorPersonId).toBe(ACTOR);
    expect(log.entityId).toBe(role.id);

    const before = log.before as Record<string, unknown>;
    const after = log.after as Record<string, unknown>;
    expect(before.permissions).toEqual(["admin.access", "admin.manage_people"]);
    expect(after.permissions).toEqual(["admin.access", "admin.manage_terms"]);
  });
});

// ---------------------------------------------------------------------------
// deleteRole
// ---------------------------------------------------------------------------

describe("deleteRole", () => {
  beforeEach(resetDb);

  it("deletes a non-system role and cascades grants and assignments", async () => {
    const role = await seedRole("Deletable Role");
    await prisma.roleGrant.create({ data: { roleId: role.id, permission: "admin.access" } });
    const person = await seedPerson("Alice");
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: person.id } });

    await deleteRole(ACTOR, role.id);

    const found = await prisma.role.findUnique({ where: { id: role.id } });
    expect(found).toBeNull();

    // Grants and assignments should cascade
    const grants = await prisma.roleGrant.findMany({ where: { roleId: role.id } });
    expect(grants).toHaveLength(0);

    const assignments = await prisma.roleAssignment.findMany({ where: { roleId: role.id } });
    expect(assignments).toHaveLength(0);
  });

  it("throws SystemRoleError when attempting to delete a system role", async () => {
    const role = await seedRole("Platform Admin", true);
    await expect(deleteRole(ACTOR, role.id)).rejects.toBeInstanceOf(SystemRoleError);
  });

  it("writes an audit entry rbac.role_delete with the role name", async () => {
    const role = await seedRole("Audit Delete Role");
    await deleteRole(ACTOR, role.id);

    const logs = await prisma.auditLog.findMany({ where: { action: "rbac.role_delete" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorPersonId).toBe(ACTOR);
    expect(logs[0].entityId).toBe(role.id);
    const before = logs[0].before as Record<string, unknown>;
    expect(before.name).toBe("Audit Delete Role");
  });

  it("does not write an audit entry when system role deletion is refused", async () => {
    const role = await seedRole("System Guard", true);
    const countBefore = await prisma.auditLog.count();

    await expect(deleteRole(ACTOR, role.id)).rejects.toBeInstanceOf(SystemRoleError);

    const countAfter = await prisma.auditLog.count();
    expect(countAfter).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// listAssignments
// ---------------------------------------------------------------------------

describe("listAssignments", () => {
  beforeEach(resetDb);

  it("returns assignments with role, person, department, term relations", async () => {
    const role = await seedRole("List Role");
    const person = await seedPerson("Alice");
    const term = await seedTerm("SU26");

    await prisma.roleAssignment.create({
      data: { roleId: role.id, personId: person.id, termId: term.id },
    });

    const assignments = await listAssignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0].role.name).toBe("List Role");
    expect(assignments[0].person?.name).toBe("Alice");
    expect(assignments[0].department).toBeNull();
    expect(assignments[0].term?.code).toBe("SU26");
  });

  it("returns empty array when no assignments exist", async () => {
    const assignments = await listAssignments();
    expect(assignments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createAssignment
// ---------------------------------------------------------------------------

describe("createAssignment", () => {
  beforeEach(resetDb);

  it("creates a person-scoped global assignment and writes audit rbac.assign", async () => {
    const role = await seedRole("Assign Role");
    const person = await seedPerson("Alice");

    await createAssignment(ACTOR, { roleId: role.id, personId: person.id });

    const assignments = await prisma.roleAssignment.findMany({ where: { roleId: role.id } });
    expect(assignments).toHaveLength(1);
    expect(assignments[0].personId).toBe(person.id);
    expect(assignments[0].termId).toBeNull();

    const logs = await prisma.auditLog.findMany({ where: { action: "rbac.assign" } });
    expect(logs).toHaveLength(1);
  });

  it("creates a department-scoped assignment", async () => {
    const role = await seedRole("Dept Role");
    const dept = await seedDepartment("DEPT");
    const term = await seedTerm("SU26");

    await createAssignment(ACTOR, { roleId: role.id, departmentId: dept.id, termId: term.id });

    const assignments = await prisma.roleAssignment.findMany({ where: { roleId: role.id } });
    expect(assignments).toHaveLength(1);
    expect(assignments[0].departmentId).toBe(dept.id);
    expect(assignments[0].termId).toBe(term.id);
  });

  it("throws AssignmentTargetError when neither personId nor departmentId is set", async () => {
    const role = await seedRole("XOR Role");

    await expect(
      createAssignment(ACTOR, { roleId: role.id })
    ).rejects.toBeInstanceOf(AssignmentTargetError);
  });

  it("throws AssignmentTargetError when both personId and departmentId are set", async () => {
    const role = await seedRole("Both Role");
    const person = await seedPerson("Alice");
    const dept = await seedDepartment("DEPT");

    await expect(
      createAssignment(ACTOR, { roleId: role.id, personId: person.id, departmentId: dept.id })
    ).rejects.toBeInstanceOf(AssignmentTargetError);
  });

  it("does not hit the DB when XOR check fails (no audit row written)", async () => {
    const role = await seedRole("XOR No DB Role");
    const countBefore = await prisma.auditLog.count();

    await expect(
      createAssignment(ACTOR, { roleId: role.id })
    ).rejects.toBeInstanceOf(AssignmentTargetError);

    const countAfter = await prisma.auditLog.count();
    expect(countAfter).toBe(countBefore);
  });

  it("throws DuplicateAssignmentError when the same assignment is created twice", async () => {
    const role = await seedRole("Dup Assign Role");
    const person = await seedPerson("Alice");

    await createAssignment(ACTOR, { roleId: role.id, personId: person.id });

    await expect(
      createAssignment(ACTOR, { roleId: role.id, personId: person.id })
    ).rejects.toBeInstanceOf(DuplicateAssignmentError);
  });

  it("throws AssignmentTargetError with field info when a bogus roleId is used (P2003)", async () => {
    const person = await seedPerson("Alice");

    await expect(
      createAssignment(ACTOR, { roleId: "bogus-role-id", personId: person.id })
    ).rejects.toBeInstanceOf(AssignmentTargetError);
  });

  it("throws AssignmentTargetError when a bogus personId is used (P2003)", async () => {
    const role = await seedRole("FK Role");

    await expect(
      createAssignment(ACTOR, { roleId: role.id, personId: "bogus-person-id" })
    ).rejects.toBeInstanceOf(AssignmentTargetError);
  });

  it("audit row contains the roleId, personId, and termId", async () => {
    const role = await seedRole("Audit Assign Role");
    const person = await seedPerson("Alice");
    const term = await seedTerm("SU26");

    await createAssignment(ACTOR, { roleId: role.id, personId: person.id, termId: term.id });

    const logs = await prisma.auditLog.findMany({ where: { action: "rbac.assign" } });
    expect(logs).toHaveLength(1);
    const after = logs[0].after as Record<string, unknown>;
    expect(after.roleId).toBe(role.id);
    expect(after.personId).toBe(person.id);
    expect(after.termId).toBe(term.id);
  });
});

// ---------------------------------------------------------------------------
// deleteAssignment
// ---------------------------------------------------------------------------

describe("deleteAssignment", () => {
  beforeEach(resetDb);

  it("deletes an existing assignment", async () => {
    const role = await seedRole("Delete Assign Role");
    const person = await seedPerson("Alice");
    const assignment = await prisma.roleAssignment.create({
      data: { roleId: role.id, personId: person.id },
    });

    await deleteAssignment(ACTOR, assignment.id);

    const found = await prisma.roleAssignment.findUnique({ where: { id: assignment.id } });
    expect(found).toBeNull();
  });

  it("throws AssignmentNotFoundError when the assignment does not exist", async () => {
    await expect(deleteAssignment(ACTOR, "nonexistent-id")).rejects.toBeInstanceOf(
      AssignmentNotFoundError
    );
  });

  it("writes an audit entry rbac.unassign with the assignment snapshot in before", async () => {
    const role = await seedRole("Unassign Audit Role");
    const person = await seedPerson("Alice");
    const assignment = await prisma.roleAssignment.create({
      data: { roleId: role.id, personId: person.id },
    });

    await deleteAssignment(ACTOR, assignment.id);

    const logs = await prisma.auditLog.findMany({ where: { action: "rbac.unassign" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorPersonId).toBe(ACTOR);
    expect(logs[0].entityId).toBe(assignment.id);
    const before = logs[0].before as Record<string, unknown>;
    expect(before.roleId).toBe(role.id);
    expect(before.personId).toBe(person.id);
  });
});

// ---------------------------------------------------------------------------
// Engine integration test (REQUIRED)
// ---------------------------------------------------------------------------

describe("RBAC engine integration", () => {
  beforeEach(resetDb);

  it("can() returns true after assigning a role with a registry permission, false after deleting", async () => {
    // Create a fresh role granting "recruitment.access" (a valid registry permission)
    const role = await createRole(ACTOR, "Recruitment Access Role", null);
    await setRoleGrants(ACTOR, role.id, ["recruitment.access"]);

    // Create a person + active term
    const person = await seedPerson("Engine Test Person");
    await seedTerm("SU26", "ACTIVE");

    // Assign role to person globally (no termId = global scope)
    await createAssignment(ACTOR, { roleId: role.id, personId: person.id });

    // can() should return true
    expect(await can(person.id, "recruitment.access")).toBe(true);

    // Find and delete the assignment
    const assignments = await prisma.roleAssignment.findMany({ where: { personId: person.id } });
    expect(assignments).toHaveLength(1);
    await deleteAssignment(ACTOR, assignments[0].id);

    // can() should now return false
    expect(await can(person.id, "recruitment.access")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lockout guard: setRoleGrants on Platform Admin
// ---------------------------------------------------------------------------

describe("setRoleGrants lockout guard (Platform Admin)", () => {
  beforeEach(resetDb);

  it("allows setting grants that still include admin.access (no * needed)", async () => {
    // Platform Admin with ["admin.access"] (no *) should succeed -- still admin-conferring
    const role = await prisma.role.create({
      data: { name: "Platform Admin", isSystem: true },
    });
    await expect(
      setRoleGrants(ACTOR, role.id, ["admin.access"])
    ).resolves.not.toThrow();
    const grants = await prisma.roleGrant.findMany({ where: { roleId: role.id } });
    expect(grants.map((g) => g.permission)).toContain("admin.access");
  });

  it("rejects removing admin.access from Platform Admin when * is also absent", async () => {
    // Platform Admin losing both * and admin.access => LastAdminError
    const role = await prisma.role.create({
      data: { name: "Platform Admin", isSystem: true },
    });
    await prisma.roleGrant.create({ data: { roleId: role.id, permission: "*" } });

    await expect(
      setRoleGrants(ACTOR, role.id, ["schedule.view"])
    ).rejects.toBeInstanceOf(LastAdminError);
  });

  it("leaves grants unchanged after a rejected setRoleGrants on Platform Admin", async () => {
    const role = await prisma.role.create({
      data: { name: "Platform Admin", isSystem: true },
    });
    await prisma.roleGrant.create({ data: { roleId: role.id, permission: "*" } });

    await expect(
      setRoleGrants(ACTOR, role.id, ["schedule.view"])
    ).rejects.toBeInstanceOf(LastAdminError);

    // Grants must be unchanged
    const grants = await prisma.roleGrant.findMany({ where: { roleId: role.id } });
    expect(grants.map((g) => g.permission)).toEqual(["*"]);
  });

  it("allows emptying a non-system role's grants (no guard applies)", async () => {
    const role = await seedRole("Regular Role");
    await prisma.roleGrant.create({ data: { roleId: role.id, permission: "admin.access" } });

    await expect(setRoleGrants(ACTOR, role.id, [])).resolves.not.toThrow();
    const grants = await prisma.roleGrant.findMany({ where: { roleId: role.id } });
    expect(grants).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lockout guard: deleteAssignment on last admin-conferring assignment
// ---------------------------------------------------------------------------

describe("deleteAssignment lockout guard (last admin-conferring assignment)", () => {
  beforeEach(resetDb);

  it("rejects deleting the only assignment of a *-granting role", async () => {
    const role = await prisma.role.create({
      data: {
        name: "Platform Admin",
        isSystem: true,
        grants: { create: [{ permission: "*" }] },
      },
    });
    const person = await seedPerson("Admin User");
    const assignment = await prisma.roleAssignment.create({
      data: { roleId: role.id, personId: person.id },
    });

    await expect(
      deleteAssignment(ACTOR, assignment.id)
    ).rejects.toBeInstanceOf(LastAdminError);
  });

  it("leaves the row in the DB after a rejected deleteAssignment", async () => {
    const role = await prisma.role.create({
      data: {
        name: "Platform Admin",
        isSystem: true,
        grants: { create: [{ permission: "*" }] },
      },
    });
    const person = await seedPerson("Admin User");
    const assignment = await prisma.roleAssignment.create({
      data: { roleId: role.id, personId: person.id },
    });

    await expect(
      deleteAssignment(ACTOR, assignment.id)
    ).rejects.toBeInstanceOf(LastAdminError);

    const found = await prisma.roleAssignment.findUnique({ where: { id: assignment.id } });
    expect(found).not.toBeNull();
  });

  it("allows deleting one of two assignments of the same *-granting role", async () => {
    const role = await prisma.role.create({
      data: {
        name: "Platform Admin",
        isSystem: true,
        grants: { create: [{ permission: "*" }] },
      },
    });
    const person1 = await seedPerson("Admin User 1");
    const person2 = await seedPerson("Admin User 2");
    const a1 = await prisma.roleAssignment.create({ data: { roleId: role.id, personId: person1.id } });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: person2.id } });

    await expect(deleteAssignment(ACTOR, a1.id)).resolves.not.toThrow();

    const found = await prisma.roleAssignment.findUnique({ where: { id: a1.id } });
    expect(found).toBeNull();
  });

  it("allows deleting the last assignment of a non-admin role", async () => {
    const role = await seedRole("Schedule Viewer");
    await prisma.roleGrant.create({ data: { roleId: role.id, permission: "schedule.view" } });
    const person = await seedPerson("Viewer User");
    const assignment = await prisma.roleAssignment.create({
      data: { roleId: role.id, personId: person.id },
    });

    await expect(deleteAssignment(ACTOR, assignment.id)).resolves.not.toThrow();
    const found = await prisma.roleAssignment.findUnique({ where: { id: assignment.id } });
    expect(found).toBeNull();
  });

  it("engine: can(admin, admin.access) still true after rejected deleteAssignment", async () => {
    const role = await prisma.role.create({
      data: {
        name: "Platform Admin",
        isSystem: true,
        grants: { create: [{ permission: "*" }] },
      },
    });
    const person = await seedPerson("Admin User");
    const assignment = await prisma.roleAssignment.create({
      data: { roleId: role.id, personId: person.id },
    });
    await seedTerm("SU26", "ACTIVE");

    await expect(
      deleteAssignment(ACTOR, assignment.id)
    ).rejects.toBeInstanceOf(LastAdminError);

    // Person still has admin.access via the * grant
    expect(await can(person.id, "admin.access")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Typed error constructors
// ---------------------------------------------------------------------------

describe("LastAdminError", () => {
  it("is an instance of Error with the correct name and message", () => {
    const err = new LastAdminError("test message");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LastAdminError);
    expect(err.name).toBe("LastAdminError");
    expect(err.message).toBe("test message");
  });
});

describe("UnknownPermissionError", () => {
  it("is an instance of Error and carries the permission string", () => {
    const err = new UnknownPermissionError("not.real");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UnknownPermissionError);
    expect(err.permission).toBe("not.real");
    expect(err.message).toContain("not.real");
    expect(err.name).toBe("UnknownPermissionError");
  });
});

describe("SystemRoleError", () => {
  it("is an instance of Error and carries the roleId", () => {
    const err = new SystemRoleError("role-123");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SystemRoleError);
    expect(err.roleId).toBe("role-123");
    expect(err.name).toBe("SystemRoleError");
  });
});

describe("RoleConflictError", () => {
  it("is an instance of Error with a friendly message", () => {
    const err = new RoleConflictError("My Role");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RoleConflictError);
    expect(err.message).toContain("My Role");
    expect(err.name).toBe("RoleConflictError");
  });
});

describe("AssignmentTargetError", () => {
  it("is an instance of Error and carries an optional field", () => {
    const err = new AssignmentTargetError("xor");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AssignmentTargetError);
    expect(err.name).toBe("AssignmentTargetError");
  });
});

describe("DuplicateAssignmentError", () => {
  it("is an instance of Error", () => {
    const err = new DuplicateAssignmentError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DuplicateAssignmentError);
    expect(err.name).toBe("DuplicateAssignmentError");
  });
});

describe("AssignmentNotFoundError", () => {
  it("is an instance of Error and carries the id", () => {
    const err = new AssignmentNotFoundError("abc-123");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AssignmentNotFoundError);
    expect(err.id).toBe("abc-123");
    expect(err.message).toContain("abc-123");
    expect(err.name).toBe("AssignmentNotFoundError");
  });
});
