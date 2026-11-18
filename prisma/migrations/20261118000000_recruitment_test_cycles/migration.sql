-- Test runs: a throwaway copy of a recruitment cycle for rehearsing it with
-- made-up applicants. Additive with a default, so it is safe for a rolling
-- deploy: every existing cycle is a real one.
ALTER TABLE "RecruitmentCycle" ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RecruitmentCycle" ADD COLUMN "testSourceCycleId" TEXT;
