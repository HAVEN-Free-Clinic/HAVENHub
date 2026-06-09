-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EmailCampaignStatus" ADD VALUE 'SCHEDULED';
ALTER TYPE "EmailCampaignStatus" ADD VALUE 'ACTIVE';

-- AlterTable
ALTER TABLE "EmailCampaign" ADD COLUMN     "cronExpr" TEXT,
ADD COLUMN     "lastRunAt" TIMESTAMP(3),
ADD COLUMN     "nextRunAt" TIMESTAMP(3),
ADD COLUMN     "scheduleType" TEXT NOT NULL DEFAULT 'NOW',
ADD COLUMN     "scheduledAt" TIMESTAMP(3);
