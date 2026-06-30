-- Decouple baseline access from the engine's hardcoded membership-kind auto-attach
-- (removed in this PR). Provision the equivalent as data: one global kind-target
-- RoleAssignment per system role. The engine resolves these via the kind column.
--
-- Idempotent: WHERE NOT EXISTS skips when the row is already present, and the
-- SELECT yields no rows (safe no-op) when the role has not been seeded yet.
-- ON CONFLICT cannot be used here: RoleAssignment_unique_grant is an expression
-- index, not a plain column constraint.

INSERT INTO "RoleAssignment" ("id", "roleId", "kind", "termId")
SELECT gen_random_uuid()::text, r."id", 'DIRECTOR'::"MembershipKind", NULL
FROM "Role" r
WHERE r."name" = 'Director' AND r."isSystem" = true
  AND NOT EXISTS (
    SELECT 1 FROM "RoleAssignment" ra
    WHERE ra."roleId" = r."id"
      AND ra."kind" = 'DIRECTOR'
      AND ra."termId" IS NULL
      AND ra."personId" IS NULL
      AND ra."departmentId" IS NULL
  );

INSERT INTO "RoleAssignment" ("id", "roleId", "kind", "termId")
SELECT gen_random_uuid()::text, r."id", 'VOLUNTEER'::"MembershipKind", NULL
FROM "Role" r
WHERE r."name" = 'Volunteer' AND r."isSystem" = true
  AND NOT EXISTS (
    SELECT 1 FROM "RoleAssignment" ra
    WHERE ra."roleId" = r."id"
      AND ra."kind" = 'VOLUNTEER'
      AND ra."termId" IS NULL
      AND ra."personId" IS NULL
      AND ra."departmentId" IS NULL
  );
