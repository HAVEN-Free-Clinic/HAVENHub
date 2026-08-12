-- Language codes hoisted from the standard application question at submit, so
-- promotion can turn them into PersonLanguage claims.
--
-- No default and no backfill: applications submitted before the standard
-- question existed genuinely have no answer, and an empty array says exactly
-- that. Postgres arrays are non-null empty by default here.
ALTER TABLE "Application" ADD COLUMN "languagesClaimed" TEXT[];
