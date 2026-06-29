-- Part B (spec 2026-06-28): add a third assignment target "kind" so a single
-- RoleAssignment row can target all VOLUNTEER or all DIRECTOR members of a term.

-- 1. The kind column (nullable enum).
ALTER TABLE "RoleAssignment" ADD COLUMN "kind" "MembershipKind";

-- 2. Replace the 2-way person/department XOR with a 3-way exactly-one check.
ALTER TABLE "RoleAssignment" DROP CONSTRAINT "RoleAssignment_target_xor";
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_target_xor"
  CHECK (
    (("personId" IS NOT NULL)::int + ("departmentId" IS NOT NULL)::int + ("kind" IS NOT NULL)::int) = 1
  );

-- 3. Rebuild the duplicate-grant expression index to span kind. The enum->text
--    I/O cast (kind::text) is only STABLE, so Postgres rejects it in an index
--    expression. Mapping kind to a literal via CASE on enum equality is
--    IMMUTABLE and avoids the cast. Expression index (not NULLS NOT DISTINCT)
--    so Prisma's migrate diff cannot model and silently drop it -- same reason
--    20260606230349_restore_unique_grant rebuilt this as an expression index.
DROP INDEX "RoleAssignment_unique_grant";
CREATE UNIQUE INDEX "RoleAssignment_unique_grant"
  ON "RoleAssignment" (
    "roleId",
    COALESCE("personId", ''),
    COALESCE("departmentId", ''),
    (CASE "kind" WHEN 'DIRECTOR' THEN 'DIRECTOR' WHEN 'VOLUNTEER' THEN 'VOLUNTEER' ELSE '' END),
    COALESCE("termId", '')
  );

-- 4. Index for kind-target resolution.
CREATE INDEX "RoleAssignment_kind_idx" ON "RoleAssignment"("kind");
