-- AlterTable
ALTER TABLE "EmailCampaign" ADD COLUMN "contentVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "updatedById" TEXT;

-- CreateTable
CREATE TABLE "EmailCampaignPresence" (
    "campaignId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailCampaignPresence_pkey" PRIMARY KEY ("campaignId","personId")
);

-- AddForeignKey
ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailCampaignPresence" ADD CONSTRAINT "EmailCampaignPresence_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EmailCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailCampaignPresence" ADD CONSTRAINT "EmailCampaignPresence_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
