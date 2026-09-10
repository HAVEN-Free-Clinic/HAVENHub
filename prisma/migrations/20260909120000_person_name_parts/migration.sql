-- Person's name splits into parts, and `name` becomes a DERIVED display value.
--
-- Before this, Person held one free-text name column, and the only way to record
-- a preferred name was to write it in parentheses: "Jonathan (Jack) Carney". That
-- string then went out on rosters, wallet passes, email salutations, and the
-- Epic access request sent to YNHH IT, which received "Jonathan (Jack)" in its
-- first-name field. The parts below let the app hold the preferred name as data
-- instead of as punctuation.
--
-- `name` is deliberately NOT dropped and NOT rewritten here. Roughly sixty read
-- sites render it, twenty-five queries order by it, and twelve search it with
-- `contains`. Keeping it as a derived column, recomputed on write by
-- platform/person-name.ts, is what lets this land without touching any of them.
--
-- legalFirstName and lastName are NOT NULL and keep their `DEFAULT ''`. That
-- default is what lets a caller write `{ name: "Jack Carney" }` alone; the
-- client extension in platform/person-name-write.ts splits it into these columns
-- before the query runs, and refuses a create carrying neither a name nor both
-- parts, so an empty surname cannot actually be inserted.
--
-- The UPDATE below is a deliberately crude placeholder, not a second
-- implementation of the splitter. Every row it touches is flagged; the real
-- split lives in platform/person-name.ts and runs from
--
--   npm run backfill:names:dry     (then --apply)
--
-- which clears nameNeedsReview on the rows it can read with confidence. Between
-- this migration and that script the app behaves exactly as before, because
-- `name` is untouched and nothing reads the parts yet.

-- `name` gains the same default for the mirror-image reason: a caller that
-- supplies the parts should not have to hand-compute the display name.
ALTER TABLE "Person" ALTER COLUMN "name" SET DEFAULT '';

ALTER TABLE "Person"
  ADD COLUMN "legalFirstName"     TEXT NOT NULL DEFAULT '',
  ADD COLUMN "legalMiddleName"    TEXT,
  ADD COLUMN "lastName"           TEXT NOT NULL DEFAULT '',
  ADD COLUMN "preferredFirstName" TEXT,
  ADD COLUMN "nameNeedsReview"    BOOLEAN NOT NULL DEFAULT false;

UPDATE "Person" SET
  "legalFirstName" = split_part(btrim("name"), ' ', 1),
  "lastName" = CASE
    WHEN btrim("name") LIKE '% %'
      THEN reverse(split_part(reverse(btrim("name")), ' ', 1))
    ELSE ''
  END,
  "nameNeedsReview" = true;

CREATE INDEX "Person_lastName_legalFirstName_idx" ON "Person"("lastName", "legalFirstName");
CREATE INDEX "Person_nameNeedsReview_idx" ON "Person"("nameNeedsReview");
