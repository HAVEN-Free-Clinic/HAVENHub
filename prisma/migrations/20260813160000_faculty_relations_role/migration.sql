-- Faculty Relations owns the attending roster and schedule.
--
-- New permission strings are inert in production until granted: SYSTEM_ROLES
-- only seeds fresh databases, so an existing deployment needs this backfill.
-- The dev seed (prisma/seed.ts via src/platform/rbac/system-roles.ts)
-- provisions the same role for fresh databases.
--
-- Platform Admin already holds "*" and needs no row.
--
-- This replaces the previous rule, where anyone directing a "service line"
-- department could edit attendings. Attendings are faculty: they hold no
-- TermMembership and belong to no department, so a department-scoped
-- directorship was the wrong shape for the right to maintain them.
--
-- ASSIGNING the role to the FCRL director is deliberately NOT done here. Role
-- assignment is a person-level act with a real audit trail, and guessing which
-- person holds that job from the database would be worse than an admin doing it
-- once in Admin > Roles.
--
-- Idempotent: Role.name and RoleGrant (roleId, permission) both have unique
-- indexes, so ON CONFLICT DO NOTHING is safe to re-run.
INSERT INTO "Role" ("id", "name", "description", "isSystem")
VALUES (
  gen_random_uuid()::text,
  'Faculty Relations Manager',
  'Maintains the attending roster, the attending schedule, and attending credentialing',
  true
)
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", p."permission"
  FROM "Role" r
 CROSS JOIN (VALUES ('schedule.view'), ('schedule.manage_attendings')) AS p("permission")
 WHERE r."name" = 'Faculty Relations Manager' AND r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;
