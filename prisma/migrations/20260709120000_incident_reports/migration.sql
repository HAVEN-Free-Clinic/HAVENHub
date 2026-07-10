-- CreateEnum
CREATE TYPE "PatientImpact" AS ENUM ('YES', 'NO', 'UNSURE');
CREATE TYPE "IssueNature" AS ENUM ('SYSTEM', 'INDIVIDUAL', 'BOTH_UNSURE');
CREATE TYPE "PriorOccurrence" AS ENUM ('YES', 'NO', 'UNSURE');
CREATE TYPE "IncidentReportStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED');
CREATE TYPE "StrikeDecision" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

-- CreateTable
CREATE TABLE "IncidentReport" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "reporterId" TEXT NOT NULL,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "concernTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "description" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "setting" TEXT,
    "subjectPersonId" TEXT,
    "subjectDescription" TEXT,
    "patientImpact" "PatientImpact",
    "patientImpactDetail" TEXT,
    "immediateRisk" BOOLEAN NOT NULL DEFAULT false,
    "issueNature" "IssueNature",
    "priorOccurrence" "PriorOccurrence",
    "priorOccurrenceDetail" TEXT,
    "status" "IncidentReportStatus" NOT NULL DEFAULT 'SUBMITTED',
    "reviewNotes" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "strikeDecision" "StrikeDecision",
    "strikeDecidedById" TEXT,
    "strikeDecidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IncidentReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentReportAttachment" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IncidentReportAttachment_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "DisciplinaryAction" ADD COLUMN "reportId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "IncidentReport_number_key" ON "IncidentReport"("number");
CREATE INDEX "IncidentReport_status_idx" ON "IncidentReport"("status");
CREATE INDEX "IncidentReport_reporterId_idx" ON "IncidentReport"("reporterId");
CREATE INDEX "IncidentReport_subjectPersonId_idx" ON "IncidentReport"("subjectPersonId");
CREATE INDEX "IncidentReportAttachment_reportId_idx" ON "IncidentReportAttachment"("reportId");
CREATE UNIQUE INDEX "DisciplinaryAction_reportId_key" ON "DisciplinaryAction"("reportId");

-- AddForeignKey
ALTER TABLE "IncidentReport" ADD CONSTRAINT "IncidentReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IncidentReport" ADD CONSTRAINT "IncidentReport_subjectPersonId_fkey" FOREIGN KEY ("subjectPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IncidentReport" ADD CONSTRAINT "IncidentReport_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IncidentReport" ADD CONSTRAINT "IncidentReport_strikeDecidedById_fkey" FOREIGN KEY ("strikeDecidedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IncidentReportAttachment" ADD CONSTRAINT "IncidentReportAttachment_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "IncidentReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncidentReportAttachment" ADD CONSTRAINT "IncidentReportAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DisciplinaryAction" ADD CONSTRAINT "DisciplinaryAction_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "IncidentReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
