-- AlterEnum
ALTER TYPE "ApplicantType" ADD VALUE 'TRANSFER';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN "transferFromDepartments" TEXT[] DEFAULT ARRAY[]::TEXT[];
