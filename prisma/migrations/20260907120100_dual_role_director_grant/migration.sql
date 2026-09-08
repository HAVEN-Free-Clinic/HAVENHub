-- Directors work the dual-role queue for the departments they direct.
--
-- The "Director" system role is attached KIND-targeted (kind = 'DIRECTOR'), so
-- permissionDepartmentIds resolves this grant to the departments where their
-- membership is a directorship and no others. VADM's director sees VADM offers,
-- INTP's sees INTP, and neither sees the other -- without naming either
-- department in RBAC. Same mechanism as volunteers.view_directory_own_dept.
--
-- SYSTEM_ROLES (src/platform/rbac/system-roles.ts, via prisma/seed.ts) only
-- provisions fresh databases: the Vercel build runs `prisma migrate deploy` and
-- never the seed, so an existing deployment needs this backfill or the grant
-- never reaches a live director.
--
-- RoleGrant has a real unique index, so this is idempotent and a re-run is a
-- no-op.
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", 'volunteers.manage_dual_roles'
FROM "Role" r
WHERE r."name" = 'Director' AND r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;
