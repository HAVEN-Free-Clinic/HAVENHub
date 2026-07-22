-- CreateEnum
CREATE TYPE "EpicRequirement" AS ENUM ('ALL', 'NONE', 'SOME');

-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "epicGuidance" TEXT,
ADD COLUMN     "requiresEpicDirector" "EpicRequirement" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "requiresEpicVolunteer" "EpicRequirement" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "OnboardingContract" ADD COLUMN     "epicIdExpiration" TIMESTAMP(3),
ADD COLUMN     "pronouns" TEXT,
ADD COLUMN     "staffTitle" TEXT;

-- AlterTable
ALTER TABLE "Person" ADD COLUMN     "pronouns" TEXT,
ADD COLUMN     "staffTitle" TEXT;

-- AlterTable
ALTER TABLE "RecruitmentCycle" ADD COLUMN     "trainingLocation" TEXT;
