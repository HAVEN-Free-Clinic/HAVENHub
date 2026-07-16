-- Restore the org-wide "required for all" flag on the two EHS trainings.
--
-- 20260701000000_ehs_training_tracking seeded ehs_hazard_comm and ehs_tb_awareness
-- with requiredForAll = true. 20260701010000_ehs_flatten_admin_managed then DROPPED
-- the requiredForAll column (erasing those true values) and 20260701020000_ehs_restore_department_scoping
-- re-added it with a blanket DEFAULT false and no restoring UPDATE. seed.ts sets no
-- EHS flags, so after the round-trip a deployed database requires EHS training of
-- nobody (the dashboard shows every cell NA and no volunteer is ever reminded about
-- Hazard Communication or TB Awareness) until an admin manually re-checks each box.
--
-- Set the two org-wide trainings back to requiredForAll = true. This is a no-op for
-- any row an admin has since intentionally scoped away, and a no-op if the rows are
-- absent.
UPDATE "EhsTraining"
SET "requiredForAll" = true, "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN ('ehs_hazard_comm', 'ehs_tb_awareness');
