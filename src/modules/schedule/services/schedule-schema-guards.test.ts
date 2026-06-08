import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

/**
 * Guards for raw-SQL constraints on the schedule module that Prisma cannot
 * express in schema.prisma. These tests exist so that a future generated
 * migration cannot silently drop the index without CI catching it.
 *
 * See also: src/platform/rbac/schema-guards.test.ts for the same pattern on
 * RoleAssignment.
 */
describe("schedule db-level schema guards", () => {
  beforeEach(resetDb);

  it("ShiftRequest_pending_unique index exists in pg_indexes", async () => {
    const result = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'ShiftRequest'
        AND indexname = 'ShiftRequest_pending_unique'
    `;
    expect(result).toHaveLength(1);
    expect(result[0].indexname).toBe("ShiftRequest_pending_unique");
  });
});
