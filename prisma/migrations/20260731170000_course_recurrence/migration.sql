-- CreateEnum
CREATE TYPE "CourseRecurrence" AS ENUM ('ONCE', 'PER_TERM');

-- DropIndex
DROP INDEX "CourseProgress_personId_courseId_key";

-- DropIndex
DROP INDEX "ScoProgress_personId_courseId_scoId_key";

-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "recurrence" "CourseRecurrence" NOT NULL DEFAULT 'ONCE';

-- AlterTable
ALTER TABLE "CourseProgress" ADD COLUMN     "termId" TEXT;

-- AlterTable
ALTER TABLE "ScoProgress" ADD COLUMN     "termId" TEXT;

-- Backfill: assign each existing row the term whose [startDate, endDate]
-- range contains its own completedAt. Term date ranges can overlap during a
-- handoff window (the next term's dates start before the outgoing term's end
-- date), so ties are broken toward the term with the latest startDate --
-- the one that had most recently started as of the completion.
--
-- Rows with a NULL completedAt are IN_PROGRESS attempts with no completion
-- date to locate a term by, and are deliberately left with termId = NULL.
-- See the doc comments on CourseProgress.termId / ScoProgress.termId in
-- schema.prisma for what NULL means to readers: a legacy attempt with no
-- knowable term, invisible to any term-scoped (PER_TERM) lookup, still
-- visible to the unscoped ONCE-course lookup exactly as before this
-- migration.
UPDATE "CourseProgress" cp
SET "termId" = (
  SELECT t.id
  FROM "Term" t
  WHERE cp."completedAt" >= t."startDate"
    AND cp."completedAt" <= t."endDate"
  ORDER BY t."startDate" DESC
  LIMIT 1
)
WHERE cp."completedAt" IS NOT NULL;

-- ScoProgress carries its own completedAt (a SCO can finish on a different
-- day than the course-level rollup), so it is backfilled independently by
-- the same rule rather than inherited from its parent CourseProgress row.
UPDATE "ScoProgress" sp
SET "termId" = (
  SELECT t.id
  FROM "Term" t
  WHERE sp."completedAt" >= t."startDate"
    AND sp."completedAt" <= t."endDate"
  ORDER BY t."startDate" DESC
  LIMIT 1
)
WHERE sp."completedAt" IS NOT NULL;

-- CreateIndex
CREATE INDEX "CourseProgress_termId_idx" ON "CourseProgress"("termId");

-- CreateIndex
CREATE UNIQUE INDEX "CourseProgress_personId_courseId_termId_key" ON "CourseProgress"("personId", "courseId", "termId");

-- CreateIndex
CREATE INDEX "ScoProgress_termId_idx" ON "ScoProgress"("termId");

-- CreateIndex
CREATE UNIQUE INDEX "ScoProgress_personId_courseId_scoId_termId_key" ON "ScoProgress"("personId", "courseId", "scoId", "termId");

-- AddForeignKey
ALTER TABLE "CourseProgress" ADD CONSTRAINT "CourseProgress_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoProgress" ADD CONSTRAINT "ScoProgress_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE SET NULL ON UPDATE CASCADE;
