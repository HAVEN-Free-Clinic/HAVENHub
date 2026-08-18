-- The "Attending" role: Hub access for a rostered attending.
--
-- New roles are inert in production until backfilled: SYSTEM_ROLES only seeds
-- fresh databases, so an existing deployment needs this. The dev seed
-- (prisma/seed.ts via src/platform/rbac/system-roles.ts) provisions the same role
-- for fresh ones.
--
-- schedule.view only. An attending sees the clinic day they cover and acts on
-- their own assignments; they are not a director and hold no volunteer-facing
-- rights. Platform Admin already holds "*" and needs no row.
--
-- ASSIGNING it is deliberately NOT done here, and unlike every other system role
-- it is not assigned by hand either: enableHubAccess (schedule module) grants it
-- per-person as it creates or links the attending's Person. A kind-target
-- assignment could not work -- Track has no faculty member and an attending holds
-- no TermMembership to hang one on.
--
-- Idempotent: Role.name and RoleGrant (roleId, permission) both have unique
-- indexes, so ON CONFLICT DO NOTHING is safe to re-run.
INSERT INTO "Role" ("id", "name", "description", "isSystem")
VALUES (
  gen_random_uuid()::text,
  'Attending',
  'Hub access for a rostered attending: their own schedule, availability, and swap requests',
  true
)
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", p."permission"
  FROM "Role" r
 CROSS JOIN (VALUES ('schedule.view')) AS p("permission")
 WHERE r."name" = 'Attending' AND r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;
