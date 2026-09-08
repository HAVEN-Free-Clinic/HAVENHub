-- Pre-acceptance language assessment.
--
-- Two changes, one feature:
--
--  1. Department.assessLanguageBeforeAcceptance marks the departments whose
--     applicants the interpreting department assesses BEFORE an accept
--     decision. A flag rather than two hardcoded codes in application code,
--     because departments are configurable data here.
--
--  2. ApplicationLanguageAssessment holds the verdict. It cannot live on
--     PersonLanguage: an applicant has no Person row until promotion, which
--     runs after acceptance and onboarding, and PersonLanguage.personId is a
--     required FK.
--
-- The UPDATE at the bottom is load-bearing, not a convenience. prisma/seed.ts
-- upserts departments with `update: { name, isActive }` only, so a value set on
-- the create path in department-catalog.ts never reaches a database where the
-- row already exists. Vercel runs `prisma migrate deploy` and never the seed,
-- so without this the flag would be false in production forever and the queue
-- would stay empty. Same reasoning as the RBAC grant backfills.

ALTER TABLE "Department"
  ADD COLUMN "assessLanguageBeforeAcceptance" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ApplicationLanguageAssessment" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedById" TEXT NOT NULL,
    "note" TEXT,
    "score" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationLanguageAssessment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApplicationLanguageAssessment_applicationId_language_key"
  ON "ApplicationLanguageAssessment"("applicationId", "language");

CREATE INDEX "ApplicationLanguageAssessment_language_idx"
  ON "ApplicationLanguageAssessment"("language");

ALTER TABLE "ApplicationLanguageAssessment"
  ADD CONSTRAINT "ApplicationLanguageAssessment_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Idempotent: a re-run sets the same two rows to the same value.
UPDATE "Department"
   SET "assessLanguageBeforeAcceptance" = true
 WHERE "code" IN ('PATS', 'INTP');
