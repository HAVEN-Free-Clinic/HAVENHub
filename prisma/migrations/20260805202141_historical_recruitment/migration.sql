-- CreateEnum
CREATE TYPE "HistoricalStage" AS ENUM ('APPLIED', 'ADVANCED', 'FINAL_ROUND', 'ACCEPTED', 'ONBOARDED');

-- CreateEnum
CREATE TYPE "HistoricalOutcome" AS ENUM ('ACCEPTED', 'REJECTED', 'WAITLISTED', 'WITHDRAWN', 'INELIGIBLE', 'NO_DECISION', 'UNKNOWN');

-- CreateTable
CREATE TABLE "HistoricalApplicant" (
    "id" TEXT NOT NULL,
    "netId" TEXT,
    "primaryEmail" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "personId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalApplicant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalApplicantEmail" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,

    CONSTRAINT "HistoricalApplicantEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalApplication" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "sourceBaseId" TEXT NOT NULL,
    "sourceTableId" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "cycleCode" TEXT NOT NULL,
    "cycleLabel" TEXT NOT NULL,
    "track" "Track" NOT NULL,
    "termCode" TEXT,
    "applicantType" "ApplicantType",
    "departmentChoices" TEXT[],
    "resultDepartment" TEXT,
    "furthestStage" "HistoricalStage" NOT NULL,
    "outcome" "HistoricalOutcome" NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "unmappedNotes" JSONB,

    CONSTRAINT "HistoricalApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalInterest" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "sourceBaseId" TEXT NOT NULL,
    "sourceTableId" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),

    CONSTRAINT "HistoricalInterest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalApplicant_netId_key" ON "HistoricalApplicant"("netId");

-- CreateIndex
CREATE INDEX "HistoricalApplicant_personId_idx" ON "HistoricalApplicant"("personId");

-- CreateIndex
CREATE INDEX "HistoricalApplicant_lastName_firstName_idx" ON "HistoricalApplicant"("lastName", "firstName");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalApplicantEmail_email_key" ON "HistoricalApplicantEmail"("email");

-- CreateIndex
CREATE INDEX "HistoricalApplicantEmail_applicantId_idx" ON "HistoricalApplicantEmail"("applicantId");

-- CreateIndex
CREATE INDEX "HistoricalApplication_applicantId_submittedAt_idx" ON "HistoricalApplication"("applicantId", "submittedAt");

-- CreateIndex
CREATE INDEX "HistoricalApplication_cycleCode_idx" ON "HistoricalApplication"("cycleCode");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalApplication_sourceBaseId_sourceTableId_sourceReco_key" ON "HistoricalApplication"("sourceBaseId", "sourceTableId", "sourceRecordId");

-- CreateIndex
CREATE INDEX "HistoricalInterest_applicantId_idx" ON "HistoricalInterest"("applicantId");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalInterest_sourceBaseId_sourceTableId_sourceRecordI_key" ON "HistoricalInterest"("sourceBaseId", "sourceTableId", "sourceRecordId");

-- AddForeignKey
ALTER TABLE "HistoricalApplicant" ADD CONSTRAINT "HistoricalApplicant_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalApplicantEmail" ADD CONSTRAINT "HistoricalApplicantEmail_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "HistoricalApplicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalApplication" ADD CONSTRAINT "HistoricalApplication_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "HistoricalApplicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalInterest" ADD CONSTRAINT "HistoricalInterest_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "HistoricalApplicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
