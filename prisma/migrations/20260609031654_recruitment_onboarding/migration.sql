-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('PENDING', 'SUBMITTED', 'PROMOTED');

-- CreateTable
CREATE TABLE "OnboardingContract" (
    "id" TEXT NOT NULL,
    "acceptanceId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'PENDING',
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "netId" TEXT,
    "phone" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "dietaryRestrictions" TEXT,
    "yaleAffiliation" TEXT,
    "gradYear" TEXT,
    "agreementSignature" TEXT,
    "professionalismSignature" TEXT,
    "trainingSignature" TEXT,
    "initials" TEXT,
    "epicNeeded" BOOLEAN NOT NULL DEFAULT false,
    "hasEpic" BOOLEAN NOT NULL DEFAULT false,
    "existingEpicId" TEXT,
    "epicAccessType" TEXT,
    "worksWithYnhh" BOOLEAN NOT NULL DEFAULT false,
    "hipaaStoredName" TEXT,
    "hipaaFileName" TEXT,
    "hipaaMimeType" TEXT,
    "hipaaSize" INTEGER,
    "hipaaCompletedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "promotedAt" TIMESTAMP(3),
    "promotedById" TEXT,
    "promotedPersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingContract_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingContract_acceptanceId_key" ON "OnboardingContract"("acceptanceId");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingContract_token_key" ON "OnboardingContract"("token");

-- CreateIndex
CREATE INDEX "OnboardingContract_status_idx" ON "OnboardingContract"("status");

-- AddForeignKey
ALTER TABLE "OnboardingContract" ADD CONSTRAINT "OnboardingContract_acceptanceId_fkey" FOREIGN KEY ("acceptanceId") REFERENCES "Acceptance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingContract" ADD CONSTRAINT "OnboardingContract_promotedById_fkey" FOREIGN KEY ("promotedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingContract" ADD CONSTRAINT "OnboardingContract_promotedPersonId_fkey" FOREIGN KEY ("promotedPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
