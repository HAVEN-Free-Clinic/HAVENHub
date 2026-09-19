-- CreateEnum
CREATE TYPE "TrainingPartStatus" AS ENUM ('OWED', 'NOT_REQUIRED', 'ATTENDED', 'ONLINE_COURSE', 'QUIZ', 'MARKED_OFF');

-- CreateEnum
CREATE TYPE "CourseKind" AS ENUM ('SCORM', 'VIDEO');

-- AlterEnum
ALTER TYPE "AttendanceEventKind" ADD VALUE 'MOCK_CLINIC';

-- AlterEnum
ALTER TYPE "TrainingMethod" ADD VALUE 'ONLINE_COURSE';

-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "kind" "CourseKind" NOT NULL DEFAULT 'SCORM',
ADD COLUMN     "makeupForCycleId" TEXT;

-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "isClinical" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Training" ADD COLUMN     "mockClinicMarkedAt" TIMESTAMP(3),
ADD COLUMN     "mockClinicMarkedById" TEXT,
ADD COLUMN     "mockClinicNote" TEXT,
ADD COLUMN     "mockClinicStatus" "TrainingPartStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "morningStatus" "TrainingPartStatus" NOT NULL DEFAULT 'OWED';

-- CreateIndex
CREATE UNIQUE INDEX "Course_makeupForCycleId_key" ON "Course"("makeupForCycleId");

-- AddForeignKey
ALTER TABLE "Training" ADD CONSTRAINT "Training_mockClinicMarkedById_fkey" FOREIGN KEY ("mockClinicMarkedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_makeupForCycleId_fkey" FOREIGN KEY ("makeupForCycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: every existing row keeps exactly the clearance it had. A COMPLETE
-- row's morning is what completed it (the retired quiz, else attendance); a
-- PENDING row's morning is still owed. mockClinicStatus stays at its
-- NOT_REQUIRED default, so nobody is newly blocked by this migration; the
-- training-standing recompute is what applies the mock clinic rule, and only
-- to a term's designated training cycle.
UPDATE "Training" SET "morningStatus" = CASE
  WHEN "status" = 'COMPLETE' AND "completedVia" = 'QUIZ' THEN 'QUIZ'::"TrainingPartStatus"
  WHEN "status" = 'COMPLETE' THEN 'ATTENDED'::"TrainingPartStatus"
  ELSE 'OWED'::"TrainingPartStatus"
END;

-- The clinical departments, as ops listed them on 2026-09-19. Codes are
-- immutable in the UI, so matching on them is stable; admins change the set
-- from the department page afterwards.
UPDATE "Department" SET "isClinical" = true
WHERE "code" IN ('JCTP', 'JCTS', 'SCTP', 'SCTS', 'PCAR', 'ICDD', 'SRHD');
