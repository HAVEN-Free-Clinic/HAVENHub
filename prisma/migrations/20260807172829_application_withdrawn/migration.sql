-- AlterEnum
ALTER TYPE "ApplicationStatus" ADD VALUE 'WITHDRAWN';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "withdrawnAt" TIMESTAMP(3);
