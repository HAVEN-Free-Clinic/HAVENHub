-- Attendings and their per-Saturday assignments become SERVICE-LINE scoped.
--
-- A service line is identified by its MANAGING department, which already exists
-- in the data as a DepartmentDelegation manager: SRHD manages CCRH/JCTS/SCTS
-- (reproductive health) and PCAR manages SCTP/JCTP (primary care). Before this,
-- RhdClinic was unique on (termId, clinicDate), which could not express "both
-- service lines run on the same Saturday, each with its own attending".
--
-- Hand-written rather than generated: adding a required column to populated
-- tables needs a deliberate backfill, and `prisma migrate dev` cannot do that
-- non-interactively.
--
-- BACKFILL SAFETY: every existing row predates the split and is therefore
-- reproductive health, so it backfills to SRHD. If SRHD is absent AND rows
-- exist, the UPDATE leaves NULLs and the following SET NOT NULL aborts the whole
-- migration. That is deliberate: a loud failure a human investigates is the
-- correct outcome, and is far better than deleting rows to make the migration
-- pass. On an empty table the UPDATE is a no-op and SET NOT NULL succeeds, so a
-- fresh database migrates cleanly whether or not SRHD has been seeded yet.

-- --- RhdAttending: which service line's roster this attending belongs to ---
ALTER TABLE "RhdAttending" ADD COLUMN "departmentId" TEXT;
UPDATE "RhdAttending" SET "departmentId" = (SELECT id FROM "Department" WHERE code = 'SRHD' LIMIT 1);
ALTER TABLE "RhdAttending" ALTER COLUMN "departmentId" SET NOT NULL;

-- --- RhdClinic: which service line this Saturday's assignment is for ---
ALTER TABLE "RhdClinic" ADD COLUMN "departmentId" TEXT;
UPDATE "RhdClinic" SET "departmentId" = (SELECT id FROM "Department" WHERE code = 'SRHD' LIMIT 1);
ALTER TABLE "RhdClinic" ALTER COLUMN "departmentId" SET NOT NULL;

-- --- The unique key gains the department ---
-- Dropped and recreated rather than widened in place: the old two-part key is
-- exactly the constraint that made a second service line impossible.
DROP INDEX "RhdClinic_termId_clinicDate_key";
CREATE UNIQUE INDEX "RhdClinic_termId_departmentId_clinicDate_key" ON "RhdClinic"("termId", "departmentId", "clinicDate");

-- --- Lookup indexes ---
CREATE INDEX "RhdAttending_departmentId_idx" ON "RhdAttending"("departmentId");
CREATE INDEX "RhdClinic_departmentId_idx" ON "RhdClinic"("departmentId");

-- --- Foreign keys. RESTRICT: an attending roster must not be orphaned by
-- --- deleting the department that owns its service line.
ALTER TABLE "RhdAttending" ADD CONSTRAINT "RhdAttending_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RhdClinic" ADD CONSTRAINT "RhdClinic_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
