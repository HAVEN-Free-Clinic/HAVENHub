-- AlterTable
ALTER TABLE "Person" ADD COLUMN     "spanishSelfReported" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "spanishVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "spanishVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "spanishVerifiedById" TEXT;

-- Backfill: the legacy Airtable spanishSpeaking flag was a self-report, not an
-- interpreting-department assessment. Carry it to self-reported and leave
-- spanishVerified=false so the interpreting department must assess before it
-- counts clinically. Routes every previously-flagged person into the review queue.
UPDATE "Person" SET "spanishSelfReported" = true WHERE "spanishSpeaking" = true;
