-- CreateTable
CREATE TABLE "IncidentReportSubject" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "strikeDecision" "StrikeDecision",
    "strikeDecidedById" TEXT,
    "strikeDecidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IncidentReportSubject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IncidentReportSubject_reportId_personId_key" ON "IncidentReportSubject"("reportId", "personId");
CREATE INDEX "IncidentReportSubject_reportId_idx" ON "IncidentReportSubject"("reportId");
CREATE INDEX "IncidentReportSubject_personId_idx" ON "IncidentReportSubject"("personId");

-- AddForeignKey
ALTER TABLE "IncidentReportSubject" ADD CONSTRAINT "IncidentReportSubject_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "IncidentReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncidentReportSubject" ADD CONSTRAINT "IncidentReportSubject_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncidentReportSubject" ADD CONSTRAINT "IncidentReportSubject_strikeDecidedById_fkey" FOREIGN KEY ("strikeDecidedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: one subject row per existing report that named a single subject,
-- carrying over its strike-decision state. gen_random_uuid() is built-in on
-- Postgres 13+ (docker + Neon are current).
INSERT INTO "IncidentReportSubject" ("id", "reportId", "personId", "strikeDecision", "strikeDecidedById", "strikeDecidedAt", "createdAt")
SELECT gen_random_uuid()::text, "id", "subjectPersonId", "strikeDecision", "strikeDecidedById", "strikeDecidedAt", "createdAt"
FROM "IncidentReport"
WHERE "subjectPersonId" IS NOT NULL;

-- Swap DisciplinaryAction uniqueness from reportId to (reportId, personId).
DROP INDEX "DisciplinaryAction_reportId_key";
CREATE UNIQUE INDEX "DisciplinaryAction_reportId_personId_key" ON "DisciplinaryAction"("reportId", "personId");

-- Drop the old single-subject and report-level strike columns.
ALTER TABLE "IncidentReport" DROP CONSTRAINT "IncidentReport_subjectPersonId_fkey";
ALTER TABLE "IncidentReport" DROP CONSTRAINT "IncidentReport_strikeDecidedById_fkey";
DROP INDEX "IncidentReport_subjectPersonId_idx";
ALTER TABLE "IncidentReport" DROP COLUMN "subjectPersonId";
ALTER TABLE "IncidentReport" DROP COLUMN "strikeDecision";
ALTER TABLE "IncidentReport" DROP COLUMN "strikeDecidedById";
ALTER TABLE "IncidentReport" DROP COLUMN "strikeDecidedAt";
