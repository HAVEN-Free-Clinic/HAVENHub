import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { MODULES } from "@/platform/modules/registry";

beforeEach(resetDb);

/**
 * Runs the shipped migration SQL against a seeded pre-migration state, so this
 * exercises the real statements rather than a re-implementation of them. A
 * plain "no stale rows exist" assertion would be vacuous: resetDb empties the
 * table, so it could not fail.
 */
const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260831130000_outreach_permission_rename/migration.sql",
  ),
  "utf8",
);

async function runMigration(): Promise<void> {
  for (const statement of MIGRATION_SQL.split(";")) {
    const sql = statement.trim();
    if (sql === "" || sql.startsWith("--")) continue;
    await prisma.$executeRawUnsafe(sql);
  }
}

describe("outreach permission rename migration", () => {
  it("converts a custom role's campaign grant and adds module access", async () => {
    const role = await prisma.role.create({ data: { name: "Comms Lead" } });
    await prisma.roleGrant.create({
      data: { roleId: role.id, permission: "admin.send_email_campaign" },
    });

    await runMigration();

    const perms = (
      await prisma.roleGrant.findMany({ where: { roleId: role.id }, select: { permission: true } })
    ).map((g) => g.permission).sort();
    expect(perms).toEqual(["outreach.access", "outreach.send_unrestricted"]);
  });

  it("leaves a wildcard role untouched", async () => {
    const role = await prisma.role.create({ data: { name: "Platform Admin", isSystem: true } });
    await prisma.roleGrant.create({ data: { roleId: role.id, permission: "*" } });

    await runMigration();

    const perms = (
      await prisma.roleGrant.findMany({ where: { roleId: role.id }, select: { permission: true } })
    ).map((g) => g.permission);
    expect(perms).toEqual(["*"]);
  });

  it("is idempotent and never violates the roleId/permission unique", async () => {
    const role = await prisma.role.create({ data: { name: "Already Migrated" } });
    await prisma.roleGrant.create({
      data: { roleId: role.id, permission: "admin.send_email_campaign" },
    });
    // Pre-existing new-permission rows are exactly the ON CONFLICT case.
    await prisma.roleGrant.create({
      data: { roleId: role.id, permission: "outreach.access" },
    });

    await runMigration();
    await runMigration();

    const perms = (
      await prisma.roleGrant.findMany({ where: { roleId: role.id }, select: { permission: true } })
    ).map((g) => g.permission).sort();
    expect(perms).toEqual(["outreach.access", "outreach.send_unrestricted"]);
  });

  it("leaves every resulting permission declared in the registry", async () => {
    const role = await prisma.role.create({ data: { name: "Comms Lead" } });
    await prisma.roleGrant.create({
      data: { roleId: role.id, permission: "admin.send_email_campaign" },
    });

    await runMigration();

    const valid = new Set<string>(["*", ...MODULES.flatMap((m) => m.permissions)]);
    const granted = await prisma.roleGrant.findMany({ select: { permission: true } });
    expect(granted.map((g) => g.permission).filter((p) => !valid.has(p))).toEqual([]);
  });
});
