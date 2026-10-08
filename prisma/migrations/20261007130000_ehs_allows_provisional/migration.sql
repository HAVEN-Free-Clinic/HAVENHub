-- Which EHS items can be cleared provisionally while a result is pending.
-- Additive with a default, so it is safe for a rolling deploy. Switched on for
-- the two items that take days to come back: the TB blood test and the mask fit.
ALTER TABLE "EhsTraining" ADD COLUMN "allowsProvisional" BOOLEAN NOT NULL DEFAULT false;

UPDATE "EhsTraining"
SET "allowsProvisional" = true
WHERE "name" IN ('TB Baseline Screening', 'Physical Safety - Respiration');