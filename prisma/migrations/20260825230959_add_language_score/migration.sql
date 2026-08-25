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
