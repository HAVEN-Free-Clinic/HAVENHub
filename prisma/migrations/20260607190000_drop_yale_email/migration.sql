/*
  Warnings:

  - You are about to drop the column `yaleEmail` on the `Person` table. All 659 stored
    values were exact copies of `contactEmail` (verified zero divergence), so this is a
    pure simplification and no data is lost.

  The contactEmail/yaleEmail split is collapsed into a single `email` concept. The
  login trust gate now lives entirely on the CLAIM side (see match-person.ts): email
  matching only happens when the incoming claim is Yale-asserted (@yale.edu).
*/

-- DropIndex (the @unique index Prisma manages)
DROP INDEX "Person_yaleEmail_key";

-- AlterTable
ALTER TABLE "Person" DROP COLUMN "yaleEmail";

-- DropIndex: the raw expression (case-insensitive) index is invisible to Prisma's
-- schema diff, so it must be dropped manually. The sibling lower-key indexes
-- (Person_netId_lower_key, Person_contactEmail_lower_key) are intentionally left
-- intact and are guarded by src/platform/rbac/schema-guards.test.ts.
DROP INDEX IF EXISTS "Person_yaleEmail_lower_key";
