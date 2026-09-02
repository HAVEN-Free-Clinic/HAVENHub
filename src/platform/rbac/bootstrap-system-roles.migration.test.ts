import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { SYSTEM_ROLES } from "@/platform/rbac/system-roles";

/**
 * The bootstrap migration is the ONLY thing that seeds the SYSTEM_ROLES on a fresh
 * production/staging database (prisma/seed.ts refuses non-localhost URLs). This test
 * applies it, plus every later grant-backfill migration that touches RoleGrant, to an
 * empty database and asserts the resulting roles, grants, and kind-target baseline
 * assignments exactly match src/platform/rbac/system-roles.ts, so a fresh
 * `migrate deploy` yields a working RBAC baseline (#13). Non-vacuous: dropping a grant
 * from either migration's VALUES/INSERT fails the grant-set assertion.
 *
 * The bootstrap file itself is a frozen snapshot of SYSTEM_ROLES as of the date it was
 * written (#13): every grant added to a role AFTER that date ships as its own
 * migration.sql (see prisma/migrations/*_grant*, *_*_permission for precedent), which
 * a truly fresh `migrate deploy` also runs, in order, against the roles the bootstrap
 * migration just created. So this list must gain one entry every time such a migration
 * ships alongside a SYSTEM_ROLES change, or this test starts asserting a
 * fresh-database end state that production will never actually have.
 */
const MIGRATION_SQL_FILES = [
  "prisma/migrations/20260726000000_bootstrap_system_roles/migration.sql",
  // schedule.manage_attendance backfilled onto Director (see system-roles.ts).
  "prisma/migrations/20260807130000_schedule_manage_attendance_grant/migration.sql",
  // The Faculty Relations Manager role itself, which maintains the attending
  // roster and schedule. A whole role rather than a grant on an existing one:
  // attendings belong to no department, so this cannot hang off a directorship.
  "prisma/migrations/20260813160000_faculty_relations_role/migration.sql",
  // The Attending role, which gives a rostered attending a Hub login. Again a
  // whole role: it is granted per-person by enableHubAccess, and no Track kind
  // could carry it since attendings hold no TermMembership.
  "prisma/migrations/20260818120100_attending_role/migration.sql",
  // The Executive Director role, for the clinic-wide people directory. A whole
  // role again: it is read-only headcount access that no existing role's scope
  // covers. Its third statement also assigns the role to the EXEC department,
  // which is a no-op here -- this database has no departments -- so it adds a
  // role and two grants and nothing else.
  "prisma/migrations/20260901120000_executive_director_directory_role/migration.sql",
  // volunteers.view_compliance backfilled onto every role holding
  // manage_compliance (see system-roles.ts), splitting the clinic-wide
  // compliance read out of the manage permission.
  "prisma/migrations/20260901140000_volunteers_view_compliance_grant/migration.sql",
  // volunteers.view_directory_own_dept backfilled onto Director: the scoped
  // half of the directory pair, so a director gets the roster and the address
  // list for the departments they direct (see system-roles.ts).
  "prisma/migrations/20260902140000_director_directory_grant/migration.sql",
].map((p) => join(process.cwd(), p));

// prisma.$executeRawUnsafe uses the extended protocol, which forbids multiple
// commands per call, so split the file into statements. Strip '--' comment lines
// FIRST (a comment contains a ';'), then split: outside comments the migration uses
// ';' only as a statement terminator and has no semicolons in string literals.
function statementsOf(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applyBootstrapMigration() {
  for (const file of MIGRATION_SQL_FILES) {
    for (const stmt of statementsOf(readFileSync(file, "utf8"))) {
      await prisma.$executeRawUnsafe(stmt);
    }
  }
}

describe("bootstrap_system_roles migration", () => {
  beforeAll(async () => {
    await resetDb(); // Role / RoleGrant / RoleAssignment empty -> the fresh-DB state
    await applyBootstrapMigration();
  });

  afterAll(async () => {
    await resetDb();
  });

  it("creates every SYSTEM_ROLE as a system role with the exact grant set", async () => {
    const roles = await prisma.role.findMany({ include: { grants: true } });
    expect(roles).toHaveLength(SYSTEM_ROLES.length);
    for (const sr of SYSTEM_ROLES) {
      const row = roles.find((r) => r.name === sr.name);
      expect(row, `role "${sr.name}" was not created`).toBeTruthy();
      expect(row!.isSystem).toBe(true);
      expect(new Set(row!.grants.map((g) => g.permission))).toEqual(new Set(sr.grants));
    }
  });

  it("provisions the Director/Volunteer kind-target baseline assignments (global)", async () => {
    const assignments = await prisma.roleAssignment.findMany({
      where: { kind: { not: null } },
      include: { role: { select: { name: true } } },
    });
    expect(assignments).toHaveLength(2);
    for (const [roleName, kind] of [
      ["Director", "DIRECTOR"],
      ["Volunteer", "VOLUNTEER"],
    ] as const) {
      const a = assignments.find((x) => x.kind === kind);
      expect(a, `${kind} baseline assignment missing`).toBeTruthy();
      expect(a!.role.name).toBe(roleName);
      expect(a!.termId).toBeNull();
      expect(a!.personId).toBeNull();
      expect(a!.departmentId).toBeNull();
    }
  });

  it("is idempotent: re-applying the migration inserts nothing new", async () => {
    await applyBootstrapMigration();
    const [roles, grants, kindAssignments] = await Promise.all([
      prisma.role.count(),
      prisma.roleGrant.count(),
      prisma.roleAssignment.count({ where: { kind: { not: null } } }),
    ]);
    expect(roles).toBe(SYSTEM_ROLES.length);
    expect(grants).toBe(SYSTEM_ROLES.reduce((n, r) => n + r.grants.length, 0));
    expect(kindAssignments).toBe(2);
  });
});
