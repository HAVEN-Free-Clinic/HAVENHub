-- Send-once per campaign: an opt-in flag so a recurring campaign catches only
-- newly-matching people, instead of re-mailing everyone who still matches on
-- every run. EmailLog's existing @@unique([campaignRunId, toEmail]) dedups
-- WITHIN a run only; this column, paired with the index below, is what lets
-- resolveCampaignAudience dedup ACROSS runs when a campaign opts in.

ALTER TABLE "EmailCampaign" ADD COLUMN "sendOncePerPerson" BOOLEAN NOT NULL DEFAULT false;

-- Supports the already-mailed lookup: EmailLog rows for this campaign's runs,
-- projected to personId. campaignRunId already leads the (campaignRunId,
-- toEmail) unique, but that index cannot serve a personId projection, and this
-- lookup runs once per recurring dispatch.
CREATE INDEX "EmailLog_campaignRunId_personId_idx" ON "EmailLog"("campaignRunId", "personId");
