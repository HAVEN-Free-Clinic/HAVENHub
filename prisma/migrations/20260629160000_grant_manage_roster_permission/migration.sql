-- Introduce admin.manage_roster (manual term-assignment editing, delegatable).
-- Platform Admin holds it via the "*" wildcard, so no grant needed there.
--
-- 1. Grant to Volunteer Operations Manager (matches src/platform/rbac/system-roles.ts
--    so dev seed and prod agree).
-- 2. Preserve current behavior: any role that can manage_terms could already manage
--    rosters, so grant manage_roster to every such role. Prevents a custom
--    term-admin role from silently losing roster ability when the roster panel
--    re-gates onto manage_roster.
--
-- Idempotent: RoleGrant has a real unique index (RoleGrant_roleId_permission_key),
-- so ON CONFLICT DO NOTHING is safe.

INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", 'admin.manage_roster'
FROM "Role" r
WHERE r."name" = 'Volunteer Operations Manager' AND r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;

INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, rg."roleId", 'admin.manage_roster'
FROM "RoleGrant" rg
WHERE rg."permission" = 'admin.manage_terms'
ON CONFLICT ("roleId", "permission") DO NOTHING;
