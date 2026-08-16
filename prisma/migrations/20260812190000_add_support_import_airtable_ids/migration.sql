-- Provenance for the read-only Airtable support-history import
-- (scripts/import-support-history.ts). Nullable and unique: rows created
-- natively in the hub leave it NULL, and re-running the importer updates the
-- previously imported row instead of duplicating it.

-- AlterTable
ALTER TABLE "TechRequest" ADD COLUMN     "airtableRecordId" TEXT;

-- AlterTable
ALTER TABLE "YnhhTicket" ADD COLUMN     "airtableRecordId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TechRequest_airtableRecordId_key" ON "TechRequest"("airtableRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "YnhhTicket_airtableRecordId_key" ON "YnhhTicket"("airtableRecordId");
