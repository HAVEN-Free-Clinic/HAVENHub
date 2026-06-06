-- Restores the duplicate-grant guard that migration 20260606225917 dropped:
-- Prisma's diff drops plain-column indexes it does not recognize from the schema.
-- Rebuilt as an EXPRESSION index (COALESCE sentinels for NULLs), which Prisma's
-- diff engine cannot see and therefore can never drop. Semantics are equivalent
-- to UNIQUE NULLS NOT DISTINCT on (roleId, personId, departmentId, termId).
CREATE UNIQUE INDEX "RoleAssignment_unique_grant"
  ON "RoleAssignment" ("roleId", COALESCE("personId", ''), COALESCE("departmentId", ''), COALESCE("termId", ''));
