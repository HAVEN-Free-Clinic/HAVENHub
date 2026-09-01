-- The internal 1-5 Spanish proficiency score, denormalized onto the language
-- claim so scheduling and the profile badge can read it in one query.
--
-- rolling-deploy: additive nullable column on an existing table. Code that
-- predates this migration never selects it, code that follows it tolerates NULL
-- (an unscored claim), so both versions run against either schema.
-- AlterTable
ALTER TABLE "PersonLanguage" ADD COLUMN "score" INTEGER;
