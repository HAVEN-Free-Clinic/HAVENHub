-- The BBP training and the HepB immunity assessment are two separate items here,
-- each checked off on its own. That is the entire point of splitting them: a
-- member who has done the training but not the assessment should see ONE thing
-- outstanding, not two, and a coordinator should tick BBP off the moment the
-- training is done rather than waiting for EHS to clear the pair.
--
-- The first pass at HepB's description said "EHS will not clear your BBP
-- requirement until this assessment is on file", which is true of EHS but reads
-- as a reason to leave the Hub's BBP box unticked. Reworded, and the BBP rows
-- now say what they cover so nobody has to infer it.

UPDATE "EhsTraining"
SET "description" = 'Required alongside the Bloodborne Pathogens (BBP) training and tracked separately from it, so you can tell which of the two is outstanding. Complete it in HealthOnTrack.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'ehs_hepb_immunity';

UPDATE "EhsTraining"
SET "description" = 'The Bloodborne Pathogens training itself, taken in Workday. It is checked off on its own; the HepB immunity assessment EHS requires alongside it is listed separately.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN ('ehs_bbp_clinical', 'ehs_bbp_student')
  AND "description" IS NULL;
