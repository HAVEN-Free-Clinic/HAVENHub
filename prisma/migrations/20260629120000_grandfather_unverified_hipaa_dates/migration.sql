-- Grandfather existing self-asserted HIPAA completion dates as accepted so the
-- new verification gate does not retroactively un-clear current volunteers.
-- Only affects rows that already have a date but were never verified.
UPDATE "HipaaCertificate"
SET "verifiedAt" = "uploadedAt"
WHERE "completionDate" IS NOT NULL
  AND "verifiedAt" IS NULL;
