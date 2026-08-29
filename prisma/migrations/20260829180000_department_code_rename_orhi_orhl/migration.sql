-- Department rename, requested 2026-08-29:
--   ORHI -> ORHL, "Oral Health Initiative" -> "Oral Health"
--
-- The name was already edited through the admin UI in production before this
-- migration was written, which is why the name update below is written to be a
-- no-op against production. It is not a no-op everywhere: staging and any
-- database seeded from an older catalog still read "Oral Health Initiative",
-- and this is what brings them in line with prisma/department-catalog.ts.
--
-- Department.code is @unique and immutable in the admin UI (see
-- modules/admin/services/departments.ts), so the change has no in-app path and
-- must land here.
--
-- Most department relations use the Department.id FK and are untouched by a
-- code change. The recruitment side denormalizes the CODE as a string, so every
-- one of those columns is rewritten in the same transaction -- a partial change
-- would leave applications, form sections, and service records pointing at a
-- code with no department.
--
-- Every statement is scoped to the old code, and the guard below distinguishes
-- an already-applied run from a real collision, so re-running is a no-op.
--
-- Two things here go beyond the PHAM/LABR precedent
-- (20260825170000_department_code_rename_meds_phlo), because that one ran
-- against a DRAFT cycle and this one runs against an OPEN one ("Volunteer Fall
-- 2026 Recruitment") with applicants mid-application:
--
--   1. FormSection.title. A supplement section's title is written once, at
--      cycle creation, as "<CODE> department questions", and
--      department-options.ts:resolveSectionTitle swaps the department's display
--      name in at render time ONLY while the stored title still equals that
--      generated default. Moving departmentCode to ORHL without moving the
--      title would make the stored title look like an admin's custom wording,
--      and the live form would start showing applicants the literal string
--      "ORHI department questions". The title is therefore moved in the same
--      statement, and only when it is still the untouched default.
--
--   2. Application.answers. The applicant's department pick lives in the
--      answers JSON under the cycle's DEPARTMENT_CHOICE field key; the
--      denormalized departmentChoices column is hoisted from it at SUBMIT
--      (services/submissions.ts:215). Nine in-flight DRAFTS in production hold
--      "ORHI" there with departmentChoices still empty, so rewriting only the
--      column would leave those applicants pointing at a department that no
--      longer exists: their supplement section would stop rendering and their
--      submit would fail validation. The DO block below rewrites the answer
--      itself, keyed off the field TYPE rather than a hardcoded key, and
--      preserves element order for the array (ranked-choice) shape.
--
-- Rolling deploy: this is data-only (no schema change), so it carries none of
-- the shapes migration-safety.ts gates -- the serving release's Prisma client
-- matches the schema throughout. The apply-side code paths that matter here
-- (departmentChoiceOptions, resolveSectionTitle, submission validation) read
-- codes out of the database rather than out of the constants, so the open cycle
-- stays internally consistent for the whole window. The one stale spot is that
-- the OLD code's department constants (prisma/department-catalog.ts, the
-- supplement SUPPLEMENT_DEPARTMENTS lists) still say ORHI between
-- `migrate deploy` and promotion, so a recruitment form GENERATED in those few
-- minutes would omit the department's supplement section. Generating a cycle's
-- form is a deliberate, rare admin action, and the fix is to regenerate after
-- promotion.

-- Guard: refuse to run if the target code is already taken by some OTHER
-- department. Moving into an occupied code would violate Department_code_key
-- halfway through and roll back, but failing here says why.
--
-- Both codes present is the collision. ORHL alone is the already-applied state
-- (or a department that took the code after ORHI was deleted); either way there
-- is nothing left to move and the statements below no-op, which is what keeps
-- the whole file re-runnable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Department" WHERE code = 'ORHL')
     AND EXISTS (SELECT 1 FROM "Department" WHERE code = 'ORHI') THEN
    RAISE EXCEPTION 'ORHI and ORHL both exist; this data migration needs a manual reconciliation';
  END IF;
END $$;

UPDATE "Department" SET code = 'ORHL', name = 'Oral Health' WHERE code = 'ORHI';

-- Denormalized department CODE columns (schema.prisma). Scalar columns first.
-- The title moves with the code; see note 1 above.
UPDATE "FormSection"
SET "departmentCode" = 'ORHL',
    title = CASE WHEN title = 'ORHI department questions' THEN 'ORHL department questions' ELSE title END
WHERE "departmentCode" = 'ORHI';

UPDATE "Application" SET "renewalDepartment" = 'ORHL' WHERE "renewalDepartment" = 'ORHI';
UPDATE "Application" SET "routedDepartmentCode" = 'ORHL' WHERE "routedDepartmentCode" = 'ORHI';
UPDATE "Application" SET "returnedFromDepartmentCode" = 'ORHL' WHERE "returnedFromDepartmentCode" = 'ORHI';

UPDATE "Acceptance" SET "departmentCode" = 'ORHL' WHERE "departmentCode" = 'ORHI';

UPDATE "Interview" SET "departmentCode" = 'ORHL' WHERE "departmentCode" = 'ORHI';

UPDATE "HistoricalApplication" SET "resultDepartment" = 'ORHL' WHERE "resultDepartment" = 'ORHI';

-- String[] columns. array_replace rewrites in place, so element order (which is
-- meaningful for departmentChoices -- it is the applicant's ranked preference)
-- is preserved.
UPDATE "RecruitmentCycle" SET departments = array_replace(departments, 'ORHI', 'ORHL') WHERE 'ORHI' = ANY(departments);

UPDATE "Application" SET "departmentChoices" = array_replace("departmentChoices", 'ORHI', 'ORHL') WHERE 'ORHI' = ANY("departmentChoices");
UPDATE "Application" SET "transferFromDepartments" = array_replace("transferFromDepartments", 'ORHI', 'ORHL') WHERE 'ORHI' = ANY("transferFromDepartments");

UPDATE "HistoricalApplication" SET "departmentChoices" = array_replace("departmentChoices", 'ORHI', 'ORHL') WHERE 'ORHI' = ANY("departmentChoices");

-- The department pick inside Application.answers; see note 2 above. Looped over
-- the DEPARTMENT_CHOICE fields rather than joined, so a cycle carrying more
-- than one of them (publish rejects that, but old data need not have been
-- published through it) has every one of its keys rewritten instead of an
-- arbitrary single match.
--
-- Only the DEPARTMENT_CHOICE answer is touched. An applicant who typed "ORHI"
-- into a free-text answer wrote that themselves and it is left verbatim, the
-- same way AuditLog history is.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT f."cycleId" AS cycle_id, f.key AS field_key
    FROM "FormField" f
    WHERE f.type = 'DEPARTMENT_CHOICE'
  LOOP
    UPDATE "Application" a
    SET answers = jsonb_set(
      a.answers,
      ARRAY[r.field_key],
      CASE
        WHEN jsonb_typeof(a.answers -> r.field_key) = 'string' THEN '"ORHL"'::jsonb
        ELSE (
          SELECT jsonb_agg(
            CASE WHEN e = '"ORHI"'::jsonb THEN '"ORHL"'::jsonb ELSE e END
            ORDER BY ord
          )
          FROM jsonb_array_elements(a.answers -> r.field_key) WITH ORDINALITY AS t(e, ord)
        )
      END
    )
    WHERE a."cycleId" = r.cycle_id
      AND (
        a.answers -> r.field_key = '"ORHI"'::jsonb
        OR (
          jsonb_typeof(a.answers -> r.field_key) = 'array'
          AND a.answers -> r.field_key @> '["ORHI"]'::jsonb
        )
      );
  END LOOP;
END $$;
