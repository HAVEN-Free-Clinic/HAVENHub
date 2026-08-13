-- Generalize Spanish verification to any language.
--
-- The four spanish* columns on Person become rows in PersonLanguage, with
-- Spanish carrying language = 'es'. The field shape is unchanged, so the
-- interpreting department's review queue keeps its exact semantics: verifiedAt
-- null means awaiting assessment, non-null means assessed either way.
--
-- ORDER MATTERS. The backfill runs BEFORE the columns are dropped, and the
-- dropped columns are the only place that data lives. Do not reorder.

-- CreateTable
CREATE TABLE "PersonLanguage" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "selfReported" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonLanguage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PersonLanguage_language_idx" ON "PersonLanguage"("language");
CREATE UNIQUE INDEX "PersonLanguage_personId_language_key" ON "PersonLanguage"("personId", "language");

-- AddForeignKey
ALTER TABLE "PersonLanguage" ADD CONSTRAINT "PersonLanguage_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one 'es' row for every person carrying ANY Spanish signal.
--
-- The WHERE covers all three states that mattered, including a person assessed
-- as NOT speaking Spanish (spanishVerified false with spanishVerifiedAt set).
-- Dropping those would push everyone previously assessed "no" back into the
-- review queue to be assessed again.
--
-- gen_random_uuid() is available without an extension on PG 13+.
INSERT INTO "PersonLanguage" ("id", "personId", "language", "selfReported", "verified", "verifiedAt", "verifiedById", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    "id",
    'es',
    "spanishSelfReported",
    "spanishVerified",
    "spanishVerifiedAt",
    "spanishVerifiedById",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Person"
WHERE "spanishSelfReported" = true
   OR "spanishVerified" = true
   OR "spanishVerifiedAt" IS NOT NULL;

-- DropColumn (only after the backfill above has read them)
ALTER TABLE "Person" DROP COLUMN "spanishSelfReported",
DROP COLUMN "spanishVerified",
DROP COLUMN "spanishVerifiedAt",
DROP COLUMN "spanishVerifiedById";
