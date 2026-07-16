ALTER TABLE "OnboardingContract"
  ADD COLUMN "templateSnapshot" JSONB,
  ADD COLUMN "customAnswers" JSONB,
  ADD COLUMN "signatures" JSONB;

CREATE TABLE "RecruitmentCycleContract" (
  "id" TEXT NOT NULL,
  "cycleId" TEXT NOT NULL,
  "layout" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecruitmentCycleContract_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecruitmentCycleContract_cycleId_key" ON "RecruitmentCycleContract"("cycleId");

ALTER TABLE "RecruitmentCycleContract"
  ADD CONSTRAINT "RecruitmentCycleContract_cycleId_fkey"
  FOREIGN KEY ("cycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
