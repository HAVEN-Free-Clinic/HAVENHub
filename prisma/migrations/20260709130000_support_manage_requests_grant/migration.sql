-- Migrate Epic management onto the unified support permission.
-- Every role granting volunteers.manage_epic now grants support.manage_requests,
-- then the retired permission's grants are removed.
--
-- Idempotent: RoleGrant has a real unique index (RoleGrant_roleId_permission_key),
-- so ON CONFLICT DO NOTHING is safe.

INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, rg."roleId", 'support.manage_requests'
FROM "RoleGrant" rg
WHERE rg."permission" = 'volunteers.manage_epic'
ON CONFLICT ("roleId", "permission") DO NOTHING;

DELETE FROM "RoleGrant" WHERE "permission" = 'volunteers.manage_epic';
