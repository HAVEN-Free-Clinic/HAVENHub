-- Remove the outbound Airtable mirror. Drops the outbox queue, the
-- Postgres->Airtable record map, and the worker heartbeat table, plus the
-- OutboxStatus enum and the Person.mirroredHipaaStatus bookkeeping column.
--
-- The read-only Airtable import is retained: Person.airtableRecordId stays so
-- the import scripts (scripts/import-*.ts) can keep matching records.

-- DropTable
DROP TABLE "Outbox";

-- DropTable
DROP TABLE "MirrorRecord";

-- DropTable
DROP TABLE "WorkerHeartbeat";

-- DropEnum
DROP TYPE "OutboxStatus";

-- AlterTable
ALTER TABLE "Person" DROP COLUMN "mirroredHipaaStatus";
