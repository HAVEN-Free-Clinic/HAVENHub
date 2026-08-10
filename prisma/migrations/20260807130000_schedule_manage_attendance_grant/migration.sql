-- Grant schedule.manage_attendance to the roles that run clinic day.
-- New permission strings are inert in production until granted: the settings
-- registry and SYSTEM_ROLES only seed fresh databases, so an existing
-- deployment needs this backfill. The dev seed (prisma/seed.ts via
-- src/platform/rbac/system-roles.ts) provisions the same grant for fresh
-- databases.
--
-- Platform Admin already holds "*" and needs no row.
--
-- Idempotent: RoleGrant has a real unique index (RoleGrant_roleId_permission_key),
-- so ON CONFLICT DO NOTHING is safe.
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", 'schedule.manage_attendance'
FROM "Role" r
WHERE r."name" = 'Director' AND r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;
