-- AlterEnum
ALTER TYPE "ApplicantType" ADD VALUE 'TRANSFER';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "transferFromDepartments" TEXT[],
ALTER COLUMN "subcommitteeRanking" DROP DEFAULT;

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
