-- Bring already-seeded cycles onto the non-Yale-affiliate identity format.
--
-- identitySection() (templates/field-groups.ts) now asks the Yale affiliation
-- BEFORE the Yale NetID, gates the NetID on the answer, and labels the email
-- neutrally. That template only runs when a cycle is CREATED, so every cycle
-- already in the database still demands a Yale NetID and a "Yale email" from an
-- applicant who answered "I am NOT a Yale Affiliate" -- a hard block at submit on
-- a question they cannot truthfully answer.
--
-- Scoped to non-ARCHIVED cycles: that is the line listCycles() already draws
-- between cycles that are part of live operations (DRAFT, OPEN, and CLOSED --
-- which is reopenable) and retired history, which should keep rendering the form
-- as it was actually filled in.
--
-- Every statement is idempotent and conservative: each one re-checks the shape it
-- is fixing, so re-running changes nothing, and a field an admin has already
-- customised (a hand-written label, a condition of their own) is left alone.

-- 1. Gate the NetID on the affiliation answer.
--
-- Only where the cycle actually has a yale_affiliation field to key on, and only
-- where the NetID carries no condition yet. `isNot` treats an unanswered
-- controller as a match, so the question still shows until someone actively says
-- they are unaffiliated -- and a condition-hidden field is dropped from
-- validation (schema-builder.ts), so hiding it is what also stops it being
-- required. One change, not two.
UPDATE "FormField" netid
SET "visibleWhen" = '{"field":"yale_affiliation","op":"isNot","value":"non_yale"}'::jsonb
FROM "FormField" affiliation, "RecruitmentCycle" cycle
WHERE netid."key" = 'net_id'
  AND netid."visibleWhen" IS NULL
  AND affiliation."cycleId" = netid."cycleId"
  AND affiliation."key" = 'yale_affiliation'
  AND cycle."id" = netid."cycleId"
  AND cycle."status" <> 'ARCHIVED';

-- 2. Stop the email field claiming to be a Yale address.
--
-- This one can never be conditional -- Applicant.emailLower is the per-cycle dedup
-- key and the address every notification is sent to -- so it stays required for
-- everyone and only the wording changes. Matched on the exact seeded label so a
-- cycle whose label an admin already rewrote keeps theirs, and helpText is only
-- filled when empty for the same reason.
UPDATE "FormField" email
SET "label" = 'Email address',
    "helpText" = COALESCE(email."helpText", 'If you are a Yale affiliate, please use your Yale email address.')
FROM "RecruitmentCycle" cycle
WHERE email."key" = 'email'
  AND email."label" = 'Yale email'
  AND cycle."id" = email."cycleId"
  AND cycle."status" <> 'ARCHIVED';

-- 3. Move the affiliation question above the NetID it now controls.
--
-- Ordering is presentational only (isFieldVisible re-evaluates live on every
-- change, wherever the controller sits), but leaving it alone means the applicant
-- fills in a NetID, scrolls down, picks "I am NOT a Yale Affiliate", and watches
-- the question they just answered vanish.
--
-- Renumbers only sections that hold both fields with the affiliation currently
-- BELOW the NetID, so it is a no-op on a cycle already in the new order. Within
-- those sections the affiliation pair takes the NetID's slot and every other
-- field keeps its relative position, which reproduces the template order exactly.
WITH misordered AS (
  SELECT netid."sectionId"
  FROM "FormField" netid
  JOIN "FormField" affiliation
    ON affiliation."sectionId" = netid."sectionId"
   AND affiliation."key" = 'yale_affiliation'
  JOIN "RecruitmentCycle" cycle ON cycle."id" = netid."cycleId"
  WHERE netid."key" = 'net_id'
    AND cycle."status" <> 'ARCHIVED'
    AND affiliation."order" > netid."order"
), renumbered AS (
  SELECT
    field."id",
    row_number() OVER (
      PARTITION BY field."sectionId"
      ORDER BY
        -- The affiliation pair sorts as if it were at the NetID's position...
        CASE
          WHEN field."key" IN ('yale_affiliation', 'yale_affiliation_other')
          THEN COALESCE((
            SELECT netid."order" FROM "FormField" netid
            WHERE netid."sectionId" = field."sectionId" AND netid."key" = 'net_id'
          ), field."order")
          ELSE field."order"
        END,
        -- ...and ahead of the NetID itself once they tie there.
        CASE field."key"
          WHEN 'yale_affiliation' THEN 0
          WHEN 'yale_affiliation_other' THEN 1
          ELSE 2
        END,
        field."order"
    ) - 1 AS new_order
  FROM "FormField" field
  WHERE field."sectionId" IN (SELECT "sectionId" FROM misordered)
)
UPDATE "FormField" field
SET "order" = renumbered.new_order
FROM renumbered
WHERE field."id" = renumbered."id"
  AND field."order" <> renumbered.new_order;
