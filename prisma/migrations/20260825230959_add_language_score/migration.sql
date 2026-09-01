-- rolling-deploy: The RENAME CONSTRAINT operations on Training are cosmetic
-- renames of constraints from the VolunteerTraining->Training table rename
-- (Jack's branch). No code path references these constraint names directly;
-- Prisma uses them only for FK enforcement which survives a rename transparently.
-- The Application subcommitteeRanking default drop and PersonLanguage score
-- addition are both additive/safe changes on new or lightly-used columns.
-- AlterTable
ALTER TABLE "Application" ALTER COLUMN "subcommitteeRanking" DROP DEFAULT;
-- AlterTable
ALTER TABLE "PersonLanguage" ADD COLUMN     "score" INTEGER;
-- AlterTable
ALTER TABLE "Training" RENAME CONSTRAINT "VolunteerTraining_pkey" TO "Training_pkey";
-- RenameForeignKey
ALTER TABLE "Training" RENAME CONSTRAINT "VolunteerTraining_attendanceRecordedById_fkey" TO "Training_attendanceRecordedById_fkey";
-- RenameForeignKey
ALTER TABLE "Training" RENAME CONSTRAINT "VolunteerTraining_cycleId_fkey" TO "Training_cycleId_fkey";
-- RenameForeignKey
ALTER TABLE "Training" RENAME CONSTRAINT "VolunteerTraining_personId_fkey" TO "Training_personId_fkey";
-- RenameForeignKey
ALTER TABLE "Training" RENAME CONSTRAINT "VolunteerTraining_termId_fkey" TO "Training_termId_fkey";