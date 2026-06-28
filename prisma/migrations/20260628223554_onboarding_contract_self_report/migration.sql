-- AlterTable
ALTER TABLE "OnboardingContract" ADD COLUMN     "spanishSelfReported" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "licensedRN" BOOLEAN NOT NULL DEFAULT false;
