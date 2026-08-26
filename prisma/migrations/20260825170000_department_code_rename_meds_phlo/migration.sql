-- Department code rename, confirmed with ops 2026-08-25:
--   PHAM -> MEDS  (name already changed in prod to "Medication Access")
--   LABR -> PHLO  (name already changed in prod to "Phlebotomy")
--
-- Department.code is @unique and immutable in the admin UI (see
-- modules/admin/services/departments.ts), so the rename has no in-app path and
-- must land here. The names were already edited through the admin UI before
-- this migration was written, which is why the name updates below are written
-- to be no-ops against production and only matter for databases seeded from an
-- older catalog.
--
-- Most department relations use the Department.id FK and are untouched by a
-- code change. The recruitment side denormalizes the CODE as a string, so every
-- one of those columns is rewritten in the same transaction -- a partial rename
-- would leave applications, form sections, and service records pointing at a
-- code with no department.
--
-- Every statement is scoped to the old code, so re-running is a no-op.
--
-- Rolling deploy: this is data-only (no schema change), so it carries none of
-- the shapes migration-safety.ts gates -- the serving release's Prisma client
-- matches the schema throughout. The one real window is that the OLD code's
-- department constants (prisma/department-catalog.ts, the supplement
-- SUPPLEMENT_DEPARTMENTS lists) still say PHAM/LABR between `migrate deploy`
-- and promotion, so a recruitment form GENERATED in those few minutes would
-- omit the two departments' supplement sections. Generating a cycle's form is a
-- deliberate, rare admin action, and the fix is to regenerate after promotion.

-- Guard: refuse to run if the target codes are already taken by some other
-- department. Renaming into an occupied code would violate Department_code_key
-- halfway through and roll back, but failing here says why.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Department" WHERE code IN ('MEDS', 'PHLO')) THEN
    RAISE EXCEPTION 'MEDS/PHLO already exist; this data migration needs a manual reconciliation';
  END IF;
END $$;

UPDATE "Department" SET code = 'MEDS', name = 'Medication Access' WHERE code = 'PHAM';
UPDATE "Department" SET code = 'PHLO', name = 'Phlebotomy'        WHERE code = 'LABR';

-- Denormalized department CODE columns (schema.prisma). Scalar columns first.
UPDATE "FormSection"   SET "departmentCode" = 'MEDS' WHERE "departmentCode" = 'PHAM';
UPDATE "FormSection"   SET "departmentCode" = 'PHLO' WHERE "departmentCode" = 'LABR';

UPDATE "Application" SET "renewalDepartment" = 'MEDS' WHERE "renewalDepartment" = 'PHAM';
UPDATE "Application" SET "renewalDepartment" = 'PHLO' WHERE "renewalDepartment" = 'LABR';
UPDATE "Application" SET "routedDepartmentCode" = 'MEDS' WHERE "routedDepartmentCode" = 'PHAM';
UPDATE "Application" SET "routedDepartmentCode" = 'PHLO' WHERE "routedDepartmentCode" = 'LABR';
UPDATE "Application" SET "returnedFromDepartmentCode" = 'MEDS' WHERE "returnedFromDepartmentCode" = 'PHAM';
UPDATE "Application" SET "returnedFromDepartmentCode" = 'PHLO' WHERE "returnedFromDepartmentCode" = 'LABR';

UPDATE "Acceptance" SET "departmentCode" = 'MEDS' WHERE "departmentCode" = 'PHAM';
UPDATE "Acceptance" SET "departmentCode" = 'PHLO' WHERE "departmentCode" = 'LABR';

UPDATE "Interview" SET "departmentCode" = 'MEDS' WHERE "departmentCode" = 'PHAM';
UPDATE "Interview" SET "departmentCode" = 'PHLO' WHERE "departmentCode" = 'LABR';

UPDATE "HistoricalApplication" SET "resultDepartment" = 'MEDS' WHERE "resultDepartment" = 'PHAM';
UPDATE "HistoricalApplication" SET "resultDepartment" = 'PHLO' WHERE "resultDepartment" = 'LABR';

-- String[] columns. array_replace rewrites in place, so element order (which is
-- meaningful for departmentChoices -- it is the applicant's ranked preference)
-- is preserved.
UPDATE "RecruitmentCycle" SET departments = array_replace(departments, 'PHAM', 'MEDS') WHERE 'PHAM' = ANY(departments);
UPDATE "RecruitmentCycle" SET departments = array_replace(departments, 'LABR', 'PHLO') WHERE 'LABR' = ANY(departments);

UPDATE "Application" SET "departmentChoices" = array_replace("departmentChoices", 'PHAM', 'MEDS') WHERE 'PHAM' = ANY("departmentChoices");
UPDATE "Application" SET "departmentChoices" = array_replace("departmentChoices", 'LABR', 'PHLO') WHERE 'LABR' = ANY("departmentChoices");
UPDATE "Application" SET "transferFromDepartments" = array_replace("transferFromDepartments", 'PHAM', 'MEDS') WHERE 'PHAM' = ANY("transferFromDepartments");
UPDATE "Application" SET "transferFromDepartments" = array_replace("transferFromDepartments", 'LABR', 'PHLO') WHERE 'LABR' = ANY("transferFromDepartments");

UPDATE "HistoricalApplication" SET "departmentChoices" = array_replace("departmentChoices", 'PHAM', 'MEDS') WHERE 'PHAM' = ANY("departmentChoices");
UPDATE "HistoricalApplication" SET "departmentChoices" = array_replace("departmentChoices", 'LABR', 'PHLO') WHERE 'LABR' = ANY("departmentChoices");
