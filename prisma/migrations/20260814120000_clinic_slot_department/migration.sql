-- Map each schedule column to the department its attending covers, so a member
-- can be told who is attending for THEIR team rather than the whole clinic day.

-- AlterTable
ALTER TABLE "ClinicSlot" ADD COLUMN "departmentId" TEXT;

-- CreateIndex
CREATE INDEX "ClinicSlot_departmentId_idx" ON "ClinicSlot"("departmentId");

-- AddForeignKey
ALTER TABLE "ClinicSlot" ADD CONSTRAINT "ClinicSlot_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill the mapping the clinic already runs on. Done here rather than only in
-- the seed because the seed never runs against deployed environments, and an
-- unmapped column shows no attending to anyone -- a silent regression on the
-- member-facing shift card rather than a visible error.
--
-- Only the clinical parents are named. SCTP/JCTP reach the primary-care columns
-- through the PCAR delegation, and JCTS/SCTS/CCRH reach "RHD Attending" through
-- the SRHD delegation, so neither needs a row of its own.
--
-- Matched on the seeded labels; a column renamed by Faculty Relations before this
-- runs is simply left unmapped for them to set, never mapped to the wrong team.
UPDATE "ClinicSlot" s
   SET "departmentId" = d.id
  FROM "Department" d
 WHERE d.code = 'PCAR'
   AND s.label IN ('9am-12pm', '11am-2pm')
   AND s."departmentId" IS NULL;

UPDATE "ClinicSlot" s
   SET "departmentId" = d.id
  FROM "Department" d
 WHERE d.code = 'SRHD'
   AND s.label = 'RHD Attending'
   AND s."departmentId" IS NULL;

UPDATE "ClinicSlot" s
   SET "departmentId" = d.id
  FROM "Department" d
 WHERE d.code = 'BVHD'
   AND s.label = 'BHD Clinic'
   AND s."departmentId" IS NULL;
