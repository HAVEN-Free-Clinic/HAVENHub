-- People directory: the "Executive Director" system role and its clinic-wide
-- department assignment.
--
-- A new permission string is inert in production until a role holds it, and
-- SYSTEM_ROLES (src/platform/rbac/system-roles.ts, via prisma/seed.ts) only
-- provisions fresh databases -- the Vercel build runs `prisma migrate deploy`
-- and never the seed. So an existing deployment needs all three steps below or
-- /volunteers/directory ships unreachable by anyone but a Platform Admin.
--
-- Platform Admin already holds "*" and needs no row.
--
-- Every statement is idempotent, so a re-run (or a database where the seed has
-- already created the role) is a no-op.

-- 1. The role itself. gen_random_uuid()::text matches the cuid-shaped text ids
--    the other backfills insert; Prisma only generates a cuid client-side, and
--    the column is a plain text primary key.
INSERT INTO "Role" ("id", "name", "description", "isSystem")
SELECT
  gen_random_uuid()::text,
  'Executive Director',
  'Clinic-wide people directory: headcount by department and contact-list export',
  true
WHERE NOT EXISTS (SELECT 1 FROM "Role" WHERE "name" = 'Executive Director');

-- 2. Its grants. Read-only on purpose: seeing the roster is not editing it, so
--    this deliberately does NOT carry admin.manage_people.
--    volunteers.view rides along because the directory lives in the Volunteers
--    module and the role would otherwise open its own page and no other tab.
--
--    RoleGrant has a real unique index (RoleGrant_roleId_permission_key), so
--    ON CONFLICT DO NOTHING is safe here.
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", p."permission"
FROM "Role" r
CROSS JOIN (VALUES ('volunteers.view'), ('volunteers.view_directory')) AS p("permission")
WHERE r."name" = 'Executive Director' AND r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 3. Assign it clinic-wide (termId NULL) to the EXEC department, matching how
--    Compliance Manager and Volunteer Operations Manager already reach the
--    Executive Directors (prisma/seed.ts, assignGlobalToDepartments).
--
--    KNOWN SCOPE, stated so it is a decision and not a surprise: a
--    department-targeted RoleAssignment reaches every ACTIVE member of that
--    department, not only its directors -- the RBAC engine has no way to express
--    "DIRECTOR of EXEC" (see permissionDepartmentIds in platform/rbac/engine.ts).
--    In practice EXEC holds the EDs. Anyone who wants it narrower should delete
--    this assignment and grant the role per person on the Roles screen instead.
--
--    Skips silently when the EXEC department does not exist (a clinic that
--    renamed it, or a fresh database seeded without the catalog).
--
--    RoleAssignment has no unique constraint, so idempotency is a NOT EXISTS
--    guard rather than ON CONFLICT.
INSERT INTO "RoleAssignment" ("id", "roleId", "personId", "departmentId", "kind", "termId")
SELECT gen_random_uuid()::text, r."id", NULL, d."id", NULL, NULL
FROM "Role" r
JOIN "Department" d ON d."code" = 'EXEC'
WHERE r."name" = 'Executive Director'
  AND r."isSystem" = true
  AND NOT EXISTS (
    SELECT 1 FROM "RoleAssignment" ra
    WHERE ra."roleId" = r."id"
      AND ra."departmentId" = d."id"
      AND ra."termId" IS NULL
  );
