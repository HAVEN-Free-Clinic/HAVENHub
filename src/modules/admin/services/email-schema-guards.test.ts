/**
 * Index guards for the admin email monitor (audit 14, DM-3).
 *
 * EmailLog is the fastest-growing table in the app, and its two hottest reads had
 * no index that could serve them: the default listing (no filter, ORDER BY
 * createdAt DESC, id DESC, LIMIT 50) and the "Sent today" tile (status = SENT
 * AND sentAt >= start of day). Both scanned the whole table. Neither the query
 * results nor any existing test changes when an index is missing, so the only
 * way to hold this is to assert the indexes are really in the database.
 *
 * These run against the migrated test database, so they also prove the two
 * CONCURRENTLY migrations actually apply -- which is not a given: one file
 * holding both statements fails with SQLSTATE 25001 (see the migration comments).
 *
 * Same pattern as src/modules/schedule/services/schedule-schema-guards.test.ts.
 * If one of these fails after a schema change, restore the index rather than
 * loosening the assertion.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";

async function indexDef(name: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE tablename = 'EmailLog' AND indexname = ${name}
  `;
  return rows[0]?.indexdef ?? null;
}

describe("EmailLog monitor indexes", () => {
  it("indexes the unfiltered newest-first listing, tiebreaker included", async () => {
    const def = await indexDef("EmailLog_createdAt_id_idx");
    expect(def).not.toBeNull();
    // The id column is what makes the ORDER BY fully index-satisfied; without it
    // the index still helps but the query sorts every tie group.
    expect(def).toMatch(/\("?createdAt"?, "?id"?\)/);
  });

  it("indexes the Sent today count", async () => {
    const def = await indexDef("EmailLog_status_sentAt_idx");
    expect(def).not.toBeNull();
    expect(def).toMatch(/\("?status"?, "?sentAt"?\)/);
  });

  it("has no invalid index left behind by a failed concurrent build", async () => {
    // CREATE INDEX CONCURRENTLY leaves an INVALID index when it fails partway,
    // and an invalid index is never used by the planner -- so the tiles would
    // silently go back to scanning while pg_indexes still lists the name.
    const invalid = await prisma.$queryRaw<{ indexrelid: string }[]>`
      SELECT c.relname AS indexrelid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      WHERE t.relname = 'EmailLog' AND NOT i.indisvalid
    `;
    expect(invalid).toEqual([]);
  });
});
