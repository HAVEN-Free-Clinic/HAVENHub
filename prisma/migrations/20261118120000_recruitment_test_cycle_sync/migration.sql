-- Test runs follow the cycle they copy. Every edit to a real cycle's form,
-- emails or settings looks its test runs up by testSourceCycleId, so index it,
-- and record when each test run last caught up. Additive and nullable, so safe
-- for a rolling deploy.
ALTER TABLE "RecruitmentCycle" ADD COLUMN "testSyncedAt" TIMESTAMP(3);
CREATE INDEX "RecruitmentCycle_testSourceCycleId_idx" ON "RecruitmentCycle"("testSourceCycleId");
