/**
 * The role-grant restructure migration, run as SQL against real Postgres.
 *
 * WHY A SEPARATE SCHEMA RATHER THAN THE TEST DATABASE ITSELF. The test database
 * has already had this migration applied, so the pre-migration shape it operates
 * on (SendingIdentity.personId, the (personId, address) unique) no longer
 * exists. Rebuilding that shape in a throwaway schema and running the SHIPPED
 * statement text against it is the only way to exercise the real file rather
 * than a paraphrase of it. `search_path` does the rest: every identifier in the
 * migration is unqualified, so it lands in the scratch schema.
 *
 * THE CASE THIS FILE EXISTS FOR. The backfill dedupes IDENTITIES by
 * LOWER(address), because the address becomes globally unique. It did not dedupe
 * GRANTS. The old unique was (personId, address) with no lowercasing guarantee
 * before Task 2, so one person legitimately held "Ops@..." and "ops@..." as two
 * rows -- which collapse onto one survivor and produce two identical grants,
 * which SendingIdentityGrant_unique_grant then rejects. Postgres rolls the
 * migration back rather than corrupting anything, but Prisma records a FAILED
 * migration and every later deploy stops with P3009 until a human intervenes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";

const SCHEMA = "mig_si_grants";

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260902160000_sending_identity_grants/migration.sql",
  ),
  "utf8",
);

/**
 * Strip `--` comment LINES, THEN split on `;`. The order is load-bearing twice.
 *
 * Stripping per LINE rather than skipping a chunk whose trimmed text starts with
 * `--` is the point outreach-permission-rename.migration.test.ts already makes:
 * no semicolon separates a leading comment paragraph from the statement under
 * it, so the naive version silently skips the statement.
 *
 * Stripping BEFORE the split is the second half, and this file found it the hard
 * way. Splitting first cuts the file at any `;` inside a COMMENT -- the
 * rolling-deploy header contains several in ordinary prose -- and the rest of
 * that comment line lands at the head of the next chunk, where it no longer
 * begins with `--` and so survives the filter. Postgres then sees English:
 * `ERROR: syntax error at or near "no"`. Splitting a clean statement stream has
 * no such failure mode.
 */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Run statements with the scratch schema on the search_path.
 *
 * ONE interactive transaction for the whole batch, and that is not incidental:
 * `SET LOCAL` lasts only for its enclosing transaction, and every bare
 * $executeRawUnsafe is its own implicit one. Issuing SET LOCAL and the statement
 * as two separate calls therefore leaves the second running against `public` --
 * where CREATE TABLE "Person" hits the REAL table and fails with 42P07, which is
 * exactly how this was caught. A transaction also pins one pooled connection,
 * so the setting cannot be lost to a different session mid-batch.
 */
async function inSchema(...sql: string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${SCHEMA}"`);
    for (const statement of sql) await tx.$executeRawUnsafe(statement);
  });
}

/** The shape 20260902140000 left behind, rebuilt in the scratch schema. */
async function seedPreMigrationSchema(): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);

  const ddl: string[] = [];
  for (const sql of [
    `CREATE TABLE "Person" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL)`,
    `CREATE TABLE "Role" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL)`,
    `CREATE TABLE "SendingIdentity" (
        "id" TEXT NOT NULL,
        "personId" TEXT NOT NULL,
        "address" TEXT NOT NULL,
        "displayName" TEXT,
        "issuedById" TEXT,
        "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "revokedAt" TIMESTAMP(3),
        "revokedById" TEXT,
        CONSTRAINT "SendingIdentity_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE INDEX "SendingIdentity_personId_idx" ON "SendingIdentity"("personId")`,
    `CREATE UNIQUE INDEX "SendingIdentity_personId_address_key"
        ON "SendingIdentity"("personId", "address")`,
    `ALTER TABLE "SendingIdentity" ADD CONSTRAINT "SendingIdentity_personId_fkey"
        FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    `ALTER TABLE "SendingIdentity" ADD CONSTRAINT "SendingIdentity_issuedById_fkey"
        FOREIGN KEY ("issuedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
    `ALTER TABLE "SendingIdentity" ADD CONSTRAINT "SendingIdentity_revokedById_fkey"
        FOREIGN KEY ("revokedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
  ]) {
    ddl.push(sql);
  }
  await inSchema(...ddl);
}

async function person(id: string, name: string): Promise<void> {
  await inSchema(`INSERT INTO "Person" ("id","name") VALUES ('${id}', '${name}')`);
}

async function identity(row: {
  id: string;
  personId: string;
  address: string;
  issuedAt: string;
  revokedAt?: string | null;
  displayName?: string | null;
}): Promise<void> {
  const display = row.displayName ? `'${row.displayName}'` : "NULL";
  const revoked = row.revokedAt ? `'${row.revokedAt}'` : "NULL";
  await inSchema(
    `INSERT INTO "SendingIdentity"
       ("id","personId","address","displayName","issuedById","issuedAt","revokedAt")
     VALUES ('${row.id}','${row.personId}','${row.address}',${display},NULL,'${row.issuedAt}',${revoked})`,
  );
}

async function runMigration(): Promise<void> {
  // The whole file in one transaction, which is also how `migrate deploy` runs
  // it -- so a statement that aborts (the duplicate-grant case this suite is
  // about) rolls the rest back exactly as it would in a real deploy.
  await inSchema(...statements(MIGRATION_SQL));
}

/** Fully schema-qualified, so the read needs no search_path of its own. */
async function grantsFor(address: string): Promise<Array<{ personId: string | null }>> {
  return prisma.$queryRawUnsafe(
    `SELECT g."personId" FROM "${SCHEMA}"."SendingIdentityGrant" g
       JOIN "${SCHEMA}"."SendingIdentity" i ON i."id" = g."identityId"
      WHERE i."address" = '${address}'
      ORDER BY g."personId"`,
  );
}

beforeEach(seedPreMigrationSchema);

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
});

describe("20260902160000_sending_identity_grants", () => {
  it("collapses ONE person's case-variant rows into ONE grant", async () => {
    // The failing case. Both rows are legal under the old
    // (personId, address) unique because the addresses differ by case, and both
    // are ACTIVE, so both feed the grant backfill. Without DISTINCT ON they
    // produce two (survivor, Alice) grants and the unique index aborts the file.
    await person("p_alice", "Alice");
    await identity({ id: "si_1", personId: "p_alice", address: "Ops@havenfreeclinic.org", issuedAt: "2026-09-01 10:00:00" });
    await identity({ id: "si_2", personId: "p_alice", address: "ops@havenfreeclinic.org", issuedAt: "2026-09-01 11:00:00" });

    await expect(runMigration()).resolves.toBeUndefined();

    expect(await grantsFor("ops@havenfreeclinic.org")).toEqual([{ personId: "p_alice" }]);
  });

  it("still gives two DIFFERENT people their own grant on a shared mailbox", async () => {
    // The dedupe must not over-collapse: a shared mailbox reaching two people is
    // the whole point of the restructure, so DISTINCT ON has to key on the
    // person as well as the survivor.
    await person("p_alice", "Alice");
    await person("p_bob", "Bob");
    await identity({ id: "si_1", personId: "p_alice", address: "shared@havenfreeclinic.org", issuedAt: "2026-09-01 10:00:00" });
    await identity({ id: "si_2", personId: "p_bob", address: "Shared@havenfreeclinic.org", issuedAt: "2026-09-01 11:00:00" });

    await runMigration();

    expect(await grantsFor("shared@havenfreeclinic.org")).toEqual([
      { personId: "p_alice" },
      { personId: "p_bob" },
    ]);
  });

  it("still drops a revoked holder, even when their other case-variant row is live", async () => {
    // The revocation rule has to survive the dedupe. Alice's revoked row must
    // not become a grant, and Bob's live one must.
    await person("p_alice", "Alice");
    await person("p_bob", "Bob");
    await identity({ id: "si_1", personId: "p_alice", address: "Ops@havenfreeclinic.org", issuedAt: "2026-09-01 10:00:00", revokedAt: "2026-09-01 12:00:00" });
    await identity({ id: "si_2", personId: "p_bob", address: "ops@havenfreeclinic.org", issuedAt: "2026-09-01 11:00:00" });

    await runMigration();

    expect(await grantsFor("ops@havenfreeclinic.org")).toEqual([{ personId: "p_bob" }]);
  });
});
