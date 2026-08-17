-- Clarification thread between an incident reviewer and the reporter.
--
-- Trimmed by hand from `prisma migrate diff`, which additionally folded in
-- pre-existing drift unrelated to this change (Training/VolunteerTraining
-- constraint renames, an Application.subcommitteeRanking default). Those belong
-- to whichever change introduced them, not to this migration.

-- AlterEnum
-- Appends; no row can hold the new value yet, so this is safe to run ahead of
-- the code that writes it (a deploy still running the previous build keeps
-- working, which matters because preview deploys share a database).
ALTER TYPE "IncidentReportStatus" ADD VALUE 'AWAITING_INFO';

-- CreateTable
CREATE TABLE "IncidentReportMessage" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentReportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IncidentReportMessage_reportId_createdAt_idx" ON "IncidentReportMessage"("reportId", "createdAt");

-- AddForeignKey
ALTER TABLE "IncidentReportMessage" ADD CONSTRAINT "IncidentReportMessage_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "IncidentReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentReportMessage" ADD CONSTRAINT "IncidentReportMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
