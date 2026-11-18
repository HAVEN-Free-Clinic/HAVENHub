-- Inbox that receives emails sent to a test run's sample applicants.
ALTER TABLE "RecruitmentCycle" ADD COLUMN "testPreviewEmail" TEXT;
