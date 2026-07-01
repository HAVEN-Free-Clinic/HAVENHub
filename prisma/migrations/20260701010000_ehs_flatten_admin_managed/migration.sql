-- Revise the unreleased EHS feature: flat admin-managed master view, no department scoping.
-- "Added to EHS?" becomes a per-person flag rather than a training.

DROP TABLE "EhsTrainingDepartment";

ALTER TABLE "EhsTraining" DROP COLUMN "requiredForAll";

ALTER TABLE "Person" ADD COLUMN "addedToEhs" BOOLEAN NOT NULL DEFAULT false;

DELETE FROM "EhsTraining" WHERE "id" = 'ehs_added_to_ehs';
