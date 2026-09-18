-- What a department did about the availability change a volunteer asked for on
-- their onboarding contract.
--
-- The request is not stored here: it is the contract's own
-- availabilityChangeNeeded / availabilityChangeRequest answer. This table holds
-- only the disposition, so "pending" is the absence of a row and there is
-- nothing to backfill for the contracts already carrying a request.
--
-- Keyed per department because a dual appointment is two departments sharing one
-- contract, and each applies the change to its own TermMembership.
--
-- rolling-deploy: a new table only. An old instance neither reads nor writes it,
-- and every existing contract stays exactly as pending as it already was.

-- CreateEnum
CREATE TYPE "AvailabilityChangeOutcome" AS ENUM ('APPLIED', 'DISMISSED');

-- CreateTable
CREATE TABLE "AvailabilityChangeDecision" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "outcome" "AvailabilityChangeOutcome" NOT NULL,
    "note" TEXT,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvailabilityChangeDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AvailabilityChangeDecision_departmentId_idx" ON "AvailabilityChangeDecision"("departmentId");

-- CreateIndex
-- One disposition per (contract, department): the DB backstop behind the
-- service's "already decided" check, so two directors pressing Apply at once
-- cannot both write one.
CREATE UNIQUE INDEX "AvailabilityChangeDecision_contractId_departmentId_key" ON "AvailabilityChangeDecision"("contractId", "departmentId");

-- AddForeignKey
ALTER TABLE "AvailabilityChangeDecision" ADD CONSTRAINT "AvailabilityChangeDecision_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "OnboardingContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityChangeDecision" ADD CONSTRAINT "AvailabilityChangeDecision_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityChangeDecision" ADD CONSTRAINT "AvailabilityChangeDecision_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
