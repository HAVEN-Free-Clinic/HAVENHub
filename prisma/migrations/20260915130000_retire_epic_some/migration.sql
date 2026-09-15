-- A department's Epic requirement is decided by the department, never by asking
-- the person onboarding. "SOME" (ask each applicant) is retired: the onboarding
-- contract no longer asks, and the department form no longer offers it. The two
-- departments that used it for volunteers (MDIC, REFF) do not need Epic, as
-- decided on 2026-09-15, so every SOME becomes NONE. The enum value itself is left
-- in place.
--
-- Data only, so it is safe while the previous release is still serving.
UPDATE "Department" SET "requiresEpicVolunteer" = 'NONE' WHERE "requiresEpicVolunteer" = 'SOME';
UPDATE "Department" SET "requiresEpicDirector" = 'NONE' WHERE "requiresEpicDirector" = 'SOME';
