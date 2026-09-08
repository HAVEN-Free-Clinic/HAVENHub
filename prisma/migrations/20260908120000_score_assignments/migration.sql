-- Divide committee scoring up instead of asking everyone to read everything.
--
-- The lead picks who is scoring this cycle (CycleScorer) and how many reads each
-- application should get (RecruitmentCycle.scoresPerApplication), and the
-- allocator hands each scorer their own pile (ScoreAssignment).
--
-- Deliberately opt-in per cycle: a cycle with no CycleScorer rows behaves
-- exactly as it does today, with every recruitment.score holder seeing the whole
-- roster. That is what makes this safe to deploy into a cycle already in flight,
-- and it is why nothing here is backfilled.

-- AlterTable
ALTER TABLE "RecruitmentCycle"
  ADD COLUMN "scoresPerApplication" INTEGER NOT NULL DEFAULT 2;

-- CreateTable
CREATE TABLE "CycleScorer" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CycleScorer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreAssignment" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "scorerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CycleScorer_cycleId_personId_key" ON "CycleScorer"("cycleId", "personId");

-- CreateIndex
CREATE INDEX "CycleScorer_cycleId_idx" ON "CycleScorer"("cycleId");

-- CreateIndex
-- The same key CommitteeScore carries, so "assigned" and "scored" join on the
-- one pair and coverage is a single query rather than a reconciliation.
CREATE UNIQUE INDEX "ScoreAssignment_applicationId_scorerId_key" ON "ScoreAssignment"("applicationId", "scorerId");

-- CreateIndex
-- Backs the speed-score queue: one person's pile across a cycle.
CREATE INDEX "ScoreAssignment_scorerId_idx" ON "ScoreAssignment"("scorerId");

-- CreateIndex
CREATE INDEX "ScoreAssignment_applicationId_idx" ON "ScoreAssignment"("applicationId");

-- AddForeignKey
ALTER TABLE "CycleScorer" ADD CONSTRAINT "CycleScorer_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleScorer" ADD CONSTRAINT "CycleScorer_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreAssignment" ADD CONSTRAINT "ScoreAssignment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreAssignment" ADD CONSTRAINT "ScoreAssignment_scorerId_fkey" FOREIGN KEY ("scorerId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
