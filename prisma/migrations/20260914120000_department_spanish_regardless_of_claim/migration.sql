-- Department.assessSpanishRegardlessOfClaim: within the pre-acceptance language
-- lane, whether this department's applicants are assessed on Spanish even when
-- they did not claim it. True for PATS, where speaking Spanish with patients is
-- the job. False for INTP, whose applicants may interpret another language and
-- are assessed only on the languages they claimed.
--
-- The UPDATE at the bottom is load-bearing, for the same reason as the backfill
-- in 20260908120000_pre_acceptance_language_assessment: prisma/seed.ts upserts
-- departments with `update: { name, isActive }` only, and Vercel runs
-- `prisma migrate deploy`, never the seed. Without it PATS would stay false in
-- production and its applicants would stop being assessed on Spanish.

ALTER TABLE "Department"
  ADD COLUMN "assessSpanishRegardlessOfClaim" BOOLEAN NOT NULL DEFAULT false;

-- Idempotent: a re-run sets the same row to the same value.
UPDATE "Department"
   SET "assessSpanishRegardlessOfClaim" = true
 WHERE "code" = 'PATS';
