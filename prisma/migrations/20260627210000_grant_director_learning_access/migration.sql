-- Issue #65: the auto-attached Director system role did not grant learning.access,
-- yet directors are assigned department/org-wide learning courses like any active
-- member. The onboarding gate then required a course they could not open,
-- permanently locking director-only members out of the entire app. Backfill the
-- grant onto the existing Director role so "assigned a course" and "can open a
-- course" agree. The dev seed (prisma/seed.ts via src/platform/rbac/system-roles.ts)
-- provisions the same grant for fresh databases.
--
-- Idempotent: ON CONFLICT skips when the grant already exists
-- (RoleGrant_roleId_permission_key), and the SELECT yields no rows -- a safe
-- no-op -- when the Director role has not been seeded yet.
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", 'learning.access'
FROM "Role" r
WHERE r."name" = 'Director' AND r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;
