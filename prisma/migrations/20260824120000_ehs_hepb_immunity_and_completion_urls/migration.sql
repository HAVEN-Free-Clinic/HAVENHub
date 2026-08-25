-- Where a member actually completes an EHS item. Null means there is nothing for
-- them to go and do: the item is one a coordinator records on their behalf.
ALTER TABLE "EhsTraining" ADD COLUMN "completionUrl" TEXT;

-- Backfill what the app already implied: every existing item pointed at Workday
-- Learning via one shared button. Keeps today's behaviour for anything an admin
-- has added since, so only the two corrections below change what members see.
UPDATE "EhsTraining"
SET "completionUrl" = 'https://www.myworkday.com/yale/learning',
    "updatedAt" = CURRENT_TIMESTAMP;

-- Correction 1: "Added to EHS?" is a coordinator's record that Yale EHS has
-- registered someone. There is nothing for the member to complete anywhere, so
-- it gets no link rather than a button pointing at the wrong answer.
UPDATE "EhsTraining"
SET "completionUrl" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'ehs_added_to_ehs';

-- Correction 2: the TB baseline screening is a Yale Health requirement done in
-- HealthOnTrack, not a Workday course. Sending people to Workday is why it stalls.
UPDATE "EhsTraining"
SET "completionUrl" = 'https://healthontrack.yale.edu/s/chs-health-requirement/CHS_Health_Requirement__c/',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'ehs_tb_baseline';

-- The HepB immunity assessment is part of the BBP requirement, and until now it
-- was invisible here: EHS held people's BBP open for a missing assessment while
-- the Hub showed BBP as the only outstanding item, so nobody could tell what was
-- actually missing. Seed it directly after BBP Student in the catalog.
UPDATE "EhsTraining"
SET "position" = "position" + 1
WHERE "position" > (SELECT "position" FROM "EhsTraining" WHERE "id" = 'ehs_bbp_student');

INSERT INTO "EhsTraining" (
  "id", "name", "description", "isActive", "requiredForAll", "position",
  "completionUrl", "createdAt", "updatedAt"
)
SELECT
  'ehs_hepb_immunity',
  'HepB Immunity Assessment',
  'Part of the Bloodborne Pathogens (BBP) requirement. Complete it in HealthOnTrack; EHS will not clear your BBP requirement until this assessment is on file.',
  true,
  -- Applies to whoever BBP applies to, including the case where an admin has
  -- since made BBP required for everyone.
  COALESCE(
    (SELECT bool_or("requiredForAll") FROM "EhsTraining" WHERE "id" IN ('ehs_bbp_clinical', 'ehs_bbp_student')),
    false
  ),
  -- Falls back to the end of the catalog if BBP Student has been deleted.
  COALESCE(
    (SELECT "position" + 1 FROM "EhsTraining" WHERE "id" = 'ehs_bbp_student'),
    (SELECT MAX("position") + 1 FROM "EhsTraining"),
    0
  ),
  'https://healthontrack.yale.edu/s/chs-health-requirement/CHS_Health_Requirement__c/',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
ON CONFLICT ("name") DO NOTHING;

-- Scope it to the union of the departments BBP is scoped to, so it lands on
-- exactly the people who already owe BBP. Skipped entirely if the insert above
-- was a no-op (a training by that name already existed under another id).
INSERT INTO "EhsTrainingDepartment" ("id", "trainingId", "departmentId")
SELECT 'ehsdep_hepb_' || d."departmentId", 'ehs_hepb_immunity', d."departmentId"
FROM (
  SELECT DISTINCT "departmentId"
  FROM "EhsTrainingDepartment"
  WHERE "trainingId" IN ('ehs_bbp_clinical', 'ehs_bbp_student')
) d
WHERE EXISTS (SELECT 1 FROM "EhsTraining" WHERE "id" = 'ehs_hepb_immunity')
ON CONFLICT ("trainingId", "departmentId") DO NOTHING;
