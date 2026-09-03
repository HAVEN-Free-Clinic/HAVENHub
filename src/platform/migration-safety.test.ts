/**
 * The rolling-deploy guard (audit 14, DM-2).
 *
 * Two halves. The unit cases pin the detector down against literal SQL,
 * including the real migration that took the whole authenticated app down
 * (#597/#598) -- the guard has to catch the incident that already happened, or
 * it is decoration. The repo case walks prisma/migrations and fails when a
 * migration written from here on carries a single-release-unsafe shape without
 * declaring its plan.
 *
 * If this fails on a migration you just wrote, the fix is NOT to delete the
 * assertion. Either split the change into two releases (see docs/DEPLOY.md) or,
 * when the window is genuinely acceptable, say so in the migration:
 *
 *   -- rolling-deploy: EhsTraining is read by one admin page behind a permission
 *   -- almost nobody holds, and no code path writes it. A few 500s on that page
 *   -- during the build window is acceptable; two releases is not worth it.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GRANDFATHERED_THROUGH,
  hasRollingDeployAck,
  isGrandfathered,
  unsafeShapes,
} from "./migration-safety";

const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations");

describe("unsafeShapes", () => {
  it("flags the drop that took the authenticated app down", () => {
    // Verbatim from 20260812232000_person_languages, the migration behind
    // issues #597 and #598: getActivePerson runs on every authenticated request
    // and its client still emitted Person.spanishSelfReported.
    const sql = `-- Generalize Spanish verification to any language.
      ALTER TABLE "Person" DROP COLUMN "spanishSelfReported";`;
    expect(unsafeShapes(sql).map((s) => s.kind)).toEqual(["drop-column"]);
  });

  it("flags the shapes the runbook did not cover", () => {
    const kinds = (sql: string) => unsafeShapes(sql).map((s) => s.kind);

    // Old code still INSERTs rows without the column: 23502 on a write path.
    expect(kinds(`ALTER TABLE "Person" ALTER COLUMN "netId" SET NOT NULL;`)).toEqual([
      "set-not-null",
    ]);
    // Old code's upserts target this index in ON CONFLICT.
    expect(kinds(`DROP INDEX "OffboardFlag_personId_termId_key";`)).toEqual(["drop-index"]);
    expect(kinds(`ALTER TABLE "Person" DROP CONSTRAINT "Person_netId_key";`)).toEqual([
      "drop-constraint",
    ]);
    expect(kinds(`ALTER TABLE "Training" RENAME TO "VolunteerTraining";`)).toEqual(["rename"]);
    expect(kinds(`ALTER TABLE "Person" ALTER COLUMN "gradYear" TYPE SMALLINT;`)).toEqual([
      "alter-type",
    ]);
    expect(kinds(`DROP TABLE "DeadModel";`)).toEqual(["drop-table"]);
  });

  it("does not flag additive statements", () => {
    const sql = `
      CREATE TABLE "Thing" ("id" TEXT NOT NULL, CONSTRAINT "Thing_pkey" PRIMARY KEY ("id"));
      ALTER TABLE "Person" ADD COLUMN "nickname" TEXT;
      ALTER TABLE "Person" ADD COLUMN "flag" BOOLEAN NOT NULL DEFAULT false;
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "EmailLog_createdAt_id_idx" ON "EmailLog"("createdAt", "id");
      UPDATE "Person" SET "nickname" = "name";
    `;
    expect(unsafeShapes(sql)).toEqual([]);
  });

  it("ignores drops that appear only in a comment", () => {
    // Prisma writes exactly this above a destructive change. A detector that
    // scanned raw text would flag every migration that merely describes one,
    // and a guard that cries wolf gets acknowledged reflexively.
    const sql = `
      /*
        Warning: You are about to drop the column \`legacy\` on the \`Person\` table.
      */
      -- We are NOT dropping it: DROP COLUMN "legacy" stays out of this release.
      ALTER TABLE "Person" ADD COLUMN "legacyReplacement" TEXT;
    `;
    expect(unsafeShapes(sql)).toEqual([]);
  });
});

describe("hasRollingDeployAck", () => {
  it("accepts a marker carrying a reason", () => {
    expect(
      hasRollingDeployAck(`-- rolling-deploy: nothing reads this table in the serving release.
        DROP TABLE "Dead";`),
    ).toBe(true);
  });

  it("rejects a bare marker with no reason", () => {
    // A checkbox is not a plan.
    expect(hasRollingDeployAck(`-- rolling-deploy:\nDROP TABLE "Dead";`)).toBe(false);
  });

  it("rejects a migration that never mentions it", () => {
    expect(hasRollingDeployAck(`DROP TABLE "Dead";`)).toBe(false);
  });
});

describe("prisma/migrations", () => {
  const names = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it("finds the migrations directory", () => {
    // Otherwise the sweep below passes vacuously over an empty list.
    expect(names.length).toBeGreaterThan(100);
  });

  it("declares a rolling-deploy plan for every unsafe migration written since the guard", () => {
    const offenders: string[] = [];
    for (const name of names) {
      if (isGrandfathered(name)) continue;
      const sql = readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
      const shapes = unsafeShapes(sql);
      if (shapes.length > 0 && !hasRollingDeployAck(sql)) {
        offenders.push(`${name}: ${[...new Set(shapes.map((s) => s.kind))].join(", ")}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("grandfathers only what already shipped", () => {
    // The cutoff must never move forward: its whole justification is that those
    // files already shipped, so a later cutoff would just be exempting new work.
    //
    // NOT because they "cannot be edited". That was the reason stated here and
    // in migration-safety.ts, and it was false: a comment-only edit to an
    // applied migration leaves `migrate deploy` and `migrate status` reporting
    // clean on Prisma 6.19.3, checksum drift and all. The real reasons are in
    // the GRANDFATHERED_THROUGH doc comment. Kept in step deliberately -- the
    // point of correcting it there was that a stated justification has to be
    // true, which is not served by leaving the same false sentence here.
    expect(GRANDFATHERED_THROUGH).toBe("20260815000000");
    expect(isGrandfathered("20260812232000_person_languages")).toBe(true);
    expect(isGrandfathered("20260816120000_email_log_listing_index")).toBe(false);
    // Something that is not a timestamped migration gets checked, not skipped.
    expect(isGrandfathered("hand_written_fix")).toBe(false);
  });
});
