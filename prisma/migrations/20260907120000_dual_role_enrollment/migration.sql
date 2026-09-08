-- Dual-role enrollment: the VADM/INTP "I'll also help out" checkboxes stop
-- being decoration and become a queue the receiving department works.
--
-- A dual role is NOT a second acceptance. Two acceptances on one application is
-- an error state (engine/conflicts.ts blocks onboarding and promotion until a
-- recruitment lead resolves it): two departments each believing they won the
-- same person. A dual role is one primary department plus a standing offer to
-- help another, so it gets its own table and never reaches that guard.

-- CreateEnum
CREATE TYPE "DualRoleStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- AlterTable
-- Hoisted at submit from the dual-option checkboxes, exactly like
-- "languagesClaimed" beside it, so promotion reads a typed column instead of an
-- answers blob whose field could have been deleted and re-added through the
-- builder under a derived key.
ALTER TABLE "Application"
  ADD COLUMN "dualRoleDepartments" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill the column for applications submitted before it existed, so cycles
-- already in flight get the feature rather than only the next intake.
--
-- Reads both spellings of a checked CHECKBOX for the same reason the TypeScript
-- does: the wizard submits the browser's "on" and answersForConditions
-- normalizes a stored boolean, so "answers" in the wild holds both.
-- The CASE arms are in alphabetical order so a backfilled array reads the same
-- as one the TypeScript hoist writes, which sorts. Nothing depends on the order,
-- but two spellings of the same value is the kind of difference that later shows
-- up as a puzzling test failure.
UPDATE "Application" SET "dualRoleDepartments" = sub.codes
FROM (
  SELECT a."id",
         ARRAY_REMOVE(ARRAY[
           CASE WHEN a."answers"->>'intp_dual_option' IN ('true', 'on') THEN 'INTP' END,
           CASE WHEN a."answers"->>'vadm_dual_option' IN ('true', 'on') THEN 'VADM' END
         ], NULL) AS codes
  FROM "Application" a
  WHERE jsonb_typeof(a."answers") = 'object'
) AS sub
WHERE "Application"."id" = sub."id" AND CARDINALITY(sub.codes) > 0;

-- CreateTable
CREATE TABLE "DualRoleInterest" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "departmentCode" TEXT NOT NULL,
    "status" "DualRoleStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DualRoleInterest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One standing offer per person per department per term: a re-promotion upserts
-- onto this key rather than stacking a row, so a director is never asked to
-- decide twice and an earlier decline is not reset to PENDING.
CREATE UNIQUE INDEX "DualRoleInterest_personId_termId_departmentCode_key" ON "DualRoleInterest"("personId", "termId", "departmentCode");

-- CreateIndex
CREATE INDEX "DualRoleInterest_termId_departmentCode_status_idx" ON "DualRoleInterest"("termId", "departmentCode", "status");

-- AddForeignKey
ALTER TABLE "DualRoleInterest" ADD CONSTRAINT "DualRoleInterest_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DualRoleInterest" ADD CONSTRAINT "DualRoleInterest_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DualRoleInterest" ADD CONSTRAINT "DualRoleInterest_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DualRoleInterest" ADD CONSTRAINT "DualRoleInterest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
