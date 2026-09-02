-- Directors get the people directory, scoped to the departments they direct.
--
-- Directors asked for one thing more than any other on the schedule builder: an
-- easy way to mail every JCTM or SCTM, rather than one clinic day's roster. The
-- directory already answers that; it was simply out of reach for anyone but an
-- Executive Director.
--
-- volunteers.view_directory_own_dept is the scoped half of the pair, mirroring
-- schedule.edit_all / schedule.edit_own_dept. The "Director" system role is
-- attached to people as a KIND-targeted RoleAssignment (kind = 'DIRECTOR'), so
-- permissionDepartmentIds resolves this grant to the departments where their
-- membership is a directorship and no others, and the directory page and its
-- CSV export both scope themselves to exactly that set. Someone who directs
-- Nursing and volunteers in Triage sees Nursing.
--
-- The clinic-wide view stays with volunteers.view_directory, held by Executive
-- Director (assigned department-targeted to EXEC) and Platform Admin ("*").
-- Neither is touched here.
--
-- SYSTEM_ROLES (src/platform/rbac/system-roles.ts, via prisma/seed.ts) only
-- provisions fresh databases: the Vercel build runs `prisma migrate deploy` and
-- never the seed, so an existing deployment needs this backfill or the grant
-- never reaches a live director.
--
-- RoleGrant has a real unique index (RoleGrant_roleId_permission_key), so the
-- statement is idempotent and a re-run is a no-op.
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", 'volunteers.view_directory_own_dept'
FROM "Role" r
WHERE r."name" = 'Director' AND r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;
