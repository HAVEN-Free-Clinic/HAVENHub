-- AlterEnum
-- Remove the never-used SENDING value from EmailCampaignStatus (dead state,
-- issue #100). Postgres cannot drop an enum value in place, so the type is
-- recreated without it. No row ever held SENDING, so the USING cast is total.
BEGIN;
CREATE TYPE "EmailCampaignStatus_new" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'SENT', 'CANCELLED');
ALTER TABLE "EmailCampaign" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "EmailCampaign" ALTER COLUMN "status" TYPE "EmailCampaignStatus_new" USING ("status"::text::"EmailCampaignStatus_new");
ALTER TYPE "EmailCampaignStatus" RENAME TO "EmailCampaignStatus_old";
ALTER TYPE "EmailCampaignStatus_new" RENAME TO "EmailCampaignStatus";
DROP TYPE "EmailCampaignStatus_old";
ALTER TABLE "EmailCampaign" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
COMMIT;

-- AlterTable
-- Drop the unused EmailCampaignRun.status column. It always defaulted to 'SENT'
-- and was never written or read anywhere (dead state, issue #100).
ALTER TABLE "EmailCampaignRun" DROP COLUMN "status";
