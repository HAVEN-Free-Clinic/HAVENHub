-- The lowest INTP Spanish proficiency score a department will staff as an
-- interpreter. NULL means "use the clinic-wide bar" (4), which is every
-- department until an admin says otherwise.
--
-- rolling-deploy: additive nullable column. Code predating this migration never
-- selects it; code following it reads NULL as the clinic-wide default, so both
-- versions run against either schema and no backfill is needed.
-- AlterTable
ALTER TABLE "Department" ADD COLUMN "minInterpreterScore" INTEGER;
