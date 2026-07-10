-- Incident Reports: disciplinary moves out of Volunteer Management. The central
-- "volunteers.issue_disciplinary" permission becomes "incidents.manage" (review
-- reports + issue/approve/delete strikes), and a new read-only
-- "incidents.view_strikes" is granted to reviewers and to directors so directors
-- keep their department strikes view. Mirrors src/platform/rbac/system-roles.ts,
-- which provisions the same grants for fresh databases via the seed.

-- 1. Rename the central grant in place. No role holds incidents.manage yet, so a
--    plain UPDATE cannot violate the (roleId, permission) unique index.
UPDATE "RoleGrant"
SET "permission" = 'incidents.manage'
WHERE "permission" = 'volunteers.issue_disciplinary';

-- 2. Every role that now has incidents.manage also gets incidents.view_strikes.
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, rg."roleId", 'incidents.view_strikes'
FROM "RoleGrant" rg
WHERE rg."permission" = 'incidents.manage'
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 3. The Director system role gets incidents.view_strikes so directors keep the
--    read-only department strikes view they had via the disciplinary page.
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", 'incidents.view_strikes'
FROM "Role" r
WHERE r."name" = 'Director' AND r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;
