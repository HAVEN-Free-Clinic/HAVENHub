-- Data-only migration: seeds each department's Epic-account requirement so
-- promotion.ts actually provisions Epic accounts instead of leaving every
-- department at the schema's NONE default. Existing prod/preview Department
-- rows predate the requiresEpicDirector/requiresEpicVolunteer/epicGuidance
-- columns (added in 20260721222737_contract_airtable_mirror) and are not
-- reached by prisma/seed.ts's upsert, which only refreshes name/isActive on
-- an existing row. Mirrors prisma/department-catalog.ts, which covers the
-- create path for fresh databases.
--
-- Codes with no matching row (e.g. a fresh database where the seed has not
-- run yet) simply update 0 rows; safe to re-run.

-- ALL for both director and volunteer.
UPDATE "Department"
SET "requiresEpicDirector" = 'ALL', "requiresEpicVolunteer" = 'ALL'
WHERE "code" IN (
  'BVHD', 'PCAR', 'EDUC', 'LABR', 'MDIC', 'ORHI', 'PATS', 'PHAM', 'REFF',
  'SRHD', 'SOSE', 'VADM', 'SCTP', 'SCTS', 'SCTL', 'JCTP', 'JCTS', 'PNLC',
  'PNTC', 'CCRH', 'VADC', 'ICDD'
);

-- SOME for both, with guidance on who qualifies.
UPDATE "Department"
SET
  "requiresEpicDirector" = 'SOME',
  "requiresEpicVolunteer" = 'SOME',
  "epicGuidance" = 'Patient Navigator and Transitions of Care roles need Epic; other roles do not.'
WHERE "code" = 'LCCN';

UPDATE "Department"
SET
  "requiresEpicDirector" = 'SOME',
  "requiresEpicVolunteer" = 'SOME',
  "epicGuidance" = 'Only if indicated by your directors.'
WHERE "code" = 'QAQI';

-- NONE for both (explicit, from the legacy form's "does not require Epic"
-- list). Matches the schema default, but written explicitly so a department
-- row an admin previously edited away from the default is reset to match
-- the legacy list.
UPDATE "Department"
SET "requiresEpicDirector" = 'NONE', "requiresEpicVolunteer" = 'NONE'
WHERE "code" IN (
  'FCRL', 'FIND', 'INTP', 'ITCM', 'PBRL', 'SRR', 'CRAD', 'MDLP', 'FOOD'
);
