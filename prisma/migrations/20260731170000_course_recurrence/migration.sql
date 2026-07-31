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
-- range contains its own completedAt.
--
-- EVERY row gets a term. Leaving any row NULL is not safe, and an earlier
-- draft of this migration that left IN_PROGRESS rows NULL produced a
-- permanent lockout:
--
--   * a NULL termId does not deduplicate in the unique index below, because
--     Postgres treats NULLs as distinct;
--   * resolveProgressTermId (enrollment.ts) filters `termId: { not: null }`,
--     so it cannot see a NULL row and creates a SECOND row on the next
--     commit rather than updating the existing one;
--   * the unscoped ONCE readers collapse duplicates last-wins, and a btree
--     index returns NULLs last, so the stale "incomplete" row wins.
--
-- The learner then finishes the course and stays blocked forever, because
-- every later commit writes the other row. So: no NULLs. The column is
-- NOT NULL and the FK is ON DELETE RESTRICT to keep it that way.
--
-- Two corrections to the term match itself:
--
-- 1. Whole-day comparison. Term.startDate/endDate are anchored at NOON UTC
--    (see admin/services/terms.ts; the seed and the Airtable importer both
--    write T12:00:00Z). A plain `completedAt BETWEEN startDate AND endDate`
--    therefore drops the second half of a term's final day (after 08:00 ET,
--    most of the working day, and exactly when deadline-driven completions
--    cluster) and the first half of its opening day.
--
-- 2. Ties break toward the EARLIEST-starting containing term, not the
--    latest. Terms overlap during handoff, and the incoming term stays
--    PLANNING until someone flips it, so getActiveTerm() -- the source
--    persistScoCmi uses for new writes -- returns the OUTGOING term for the
--    same instant. Ordering by startDate DESC would backfill a handoff-window
--    completion to the incoming term and pre-credit that person for the very
--    term a later PER_TERM flip was meant to bite in.
--
-- Anything with no completedAt (an IN_PROGRESS attempt) or whose completedAt
-- matches no term at all (a gap between terms, or a historic import predating
-- every term) falls back to the currently ACTIVE term. That is exactly what
-- the write path would assign on the very next commit, so the row is adopted
-- and updated in place instead of being forked.
UPDATE "CourseProgress" cp
SET "termId" = COALESCE(
  (
    SELECT t.id
    FROM "Term" t
    WHERE cp."completedAt" >= date_trunc('day', t."startDate")
      AND cp."completedAt" < date_trunc('day', t."endDate") + INTERVAL '1 day'
    ORDER BY t."startDate" ASC
    LIMIT 1
  ),
  (SELECT t.id FROM "Term" t WHERE t.status = 'ACTIVE' ORDER BY t."startDate" DESC LIMIT 1),
  (SELECT t.id FROM "Term" t ORDER BY t."startDate" DESC LIMIT 1)
);

-- ScoProgress carries its own completedAt (a SCO can finish on a different
-- day than the course-level rollup). It is backfilled by the same rule, but
-- falls back to its PARENT CourseProgress row's term before the active term,
-- so a course's SCO rows and its rollup row cannot land on different terms.
-- If they diverged, the next ONCE commit would scope the SCO read to the
-- rollup's term, miss the rest, and overwrite the director-visible score
-- while stranding partial SCO progress.
UPDATE "ScoProgress" sp
SET "termId" = COALESCE(
  (
    SELECT t.id
    FROM "Term" t
    WHERE sp."completedAt" >= date_trunc('day', t."startDate")
      AND sp."completedAt" < date_trunc('day', t."endDate") + INTERVAL '1 day'
    ORDER BY t."startDate" ASC
    LIMIT 1
  ),
  (SELECT cp."termId" FROM "CourseProgress" cp
    WHERE cp."personId" = sp."personId" AND cp."courseId" = sp."courseId" LIMIT 1),
  (SELECT t.id FROM "Term" t WHERE t.status = 'ACTIVE' ORDER BY t."startDate" DESC LIMIT 1),
  (SELECT t.id FROM "Term" t ORDER BY t."startDate" DESC LIMIT 1)
);

-- Every row now carries a term, so the column can be NOT NULL. If any row
-- still has a NULL here the database has no Term rows at all, in which case
-- there is also no progress to migrate and these tables are empty.
ALTER TABLE "CourseProgress" ALTER COLUMN "termId" SET NOT NULL;
ALTER TABLE "ScoProgress" ALTER COLUMN "termId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "CourseProgress_termId_idx" ON "CourseProgress"("termId");

-- CreateIndex
CREATE UNIQUE INDEX "CourseProgress_personId_courseId_termId_key" ON "CourseProgress"("personId", "courseId", "termId");

-- CreateIndex
CREATE INDEX "ScoProgress_termId_idx" ON "ScoProgress"("termId");

-- CreateIndex
CREATE UNIQUE INDEX "ScoProgress_personId_courseId_scoId_termId_key" ON "ScoProgress"("personId", "courseId", "scoId", "termId");

-- AddForeignKey
ALTER TABLE "CourseProgress" ADD CONSTRAINT "CourseProgress_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoProgress" ADD CONSTRAINT "ScoProgress_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
