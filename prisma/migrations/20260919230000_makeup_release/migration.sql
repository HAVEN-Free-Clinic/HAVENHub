-- AlterTable
ALTER TABLE "RecruitmentCycle" ADD COLUMN     "makeupDueAt" TIMESTAMP(3),
ADD COLUMN     "makeupReleasedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Training" ADD COLUMN     "makeupEmailedAt" TIMESTAMP(3),
ADD COLUMN     "makeupNudgeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "makeupNudgeLastSentAt" TIMESTAMP(3);

