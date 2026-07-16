-- Add the SIGNATURE value to the FieldType enum so application-form builders can
-- add a draw-your-signature field (persisted as a private PNG blob, like FILE).
ALTER TYPE "FieldType" ADD VALUE 'SIGNATURE';
