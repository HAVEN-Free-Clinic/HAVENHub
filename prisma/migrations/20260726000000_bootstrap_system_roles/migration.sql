-- Bootstrap the SYSTEM_ROLES on a fresh database (#13).
--
-- Until now the ONLY writer of Role rows was prisma/seed.ts, which refuses any
-- non-localhost DATABASE_URL and also creates dev fixtures + force-activates SU26,
-- so it cannot run against a real deployment. Every historical role migration only
-- INSERTs RoleGrant / RoleAssignment rows via `SELECT ... FROM "Role" WHERE name=...`,
-- which is a silent no-op on an empty table. So a fresh production/staging DB (launch
-- cutover, DR rebuild, a second clinic's instance) came up with Role empty ->
-- getEffectivePermissions returned {} for everyone -> every requirePermission(...)
-- redirected to /no-access, including the one page that could create the first role.
--
-- This migration provisions the complete current SYSTEM_ROLES end-state as data:
-- the roles (isSystem = true), their grants, and the kind-target baseline
-- RoleAssignments -- mirroring src/platform/rbac/system-roles.ts and the seed's role
-- block. It runs AFTER every earlier role migration (which no-op on a fresh DB), so
-- it is authoritative for the base grant set. Fully idempotent: on an existing DB
-- where the roles are already present it changes nothing.

-- 1. Roles. Role.name is UNIQUE, so ON CONFLICT DO NOTHING is safe and idempotent.
INSERT INTO "Role" ("id", "name", "description", "isSystem") VALUES
  (gen_random_uuid()::text, 'Platform Admin', 'Full access to every module and admin function', true),
  (gen_random_uuid()::text, 'Director', 'Baseline access for current-term directors', true),
  (gen_random_uuid()::text, 'Volunteer', 'Baseline access for current-term volunteers', true),
  (gen_random_uuid()::text, 'Compliance Manager', 'Master compliance view across the clinic', true),
  (gen_random_uuid()::text, 'Volunteer Operations Manager', 'Offboarding, IT support requests, and incident reports across the clinic', true)
ON CONFLICT ("name") DO NOTHING;

-- 2. Grants. RoleGrant has a real unique index (roleId, permission), so
--    ON CONFLICT DO NOTHING is safe. Joins each (roleName, permission) pair to its
--    system role. Only adds MISSING grants; never removes any, so a grant a later
--    migration intentionally added on an existing DB is untouched.
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", g."permission"
FROM "Role" r
JOIN (VALUES
  ('Platform Admin', '*'),
  ('Director', 'schedule.view'),
  ('Director', 'volunteers.view'),
  ('Director', 'learning.access'),
  ('Director', 'incidents.view_strikes'),
  ('Volunteer', 'schedule.view'),
  ('Volunteer', 'learning.access'),
  ('Compliance Manager', 'volunteers.view'),
  ('Compliance Manager', 'volunteers.manage_compliance'),
  ('Volunteer Operations Manager', 'volunteers.view'),
  ('Volunteer Operations Manager', 'volunteers.manage_offboarding'),
  ('Volunteer Operations Manager', 'support.manage_requests'),
  ('Volunteer Operations Manager', 'incidents.manage'),
  ('Volunteer Operations Manager', 'incidents.view_strikes')
) AS g("roleName", "permission") ON g."roleName" = r."name"
WHERE r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 3. Baseline access by membership kind: one GLOBAL (termId NULL) kind-target
--    RoleAssignment for Director/Volunteer, mirroring the seed and the earlier
--    20260629150000 migration. ON CONFLICT cannot be used -- RoleAssignment's unique
--    guard is an expression index, not a plain column constraint -- so WHERE NOT
--    EXISTS provides the idempotency.
INSERT INTO "RoleAssignment" ("id", "roleId", "kind", "termId")
SELECT gen_random_uuid()::text, r."id", 'DIRECTOR'::"Track", NULL
FROM "Role" r
WHERE r."name" = 'Director' AND r."isSystem" = true
  AND NOT EXISTS (
    SELECT 1 FROM "RoleAssignment" ra
    WHERE ra."roleId" = r."id"
      AND ra."kind" = 'DIRECTOR'::"Track"
      AND ra."termId" IS NULL
      AND ra."personId" IS NULL
      AND ra."departmentId" IS NULL
  );

INSERT INTO "RoleAssignment" ("id", "roleId", "kind", "termId")
SELECT gen_random_uuid()::text, r."id", 'VOLUNTEER'::"Track", NULL
FROM "Role" r
WHERE r."name" = 'Volunteer' AND r."isSystem" = true
  AND NOT EXISTS (
    SELECT 1 FROM "RoleAssignment" ra
    WHERE ra."roleId" = r."id"
      AND ra."kind" = 'VOLUNTEER'::"Track"
      AND ra."termId" IS NULL
      AND ra."personId" IS NULL
      AND ra."departmentId" IS NULL
  );
