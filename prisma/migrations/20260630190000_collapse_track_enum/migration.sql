-- Collapse three byte-identical enums (MembershipKind, RecruitmentTrack,
-- TrainingTrack) into a single shared "Track" enum. The members are unchanged
-- ('VOLUNTEER', 'DIRECTOR'), so every column converts through a text round-trip
-- and all existing rows are preserved.

-- Unified enum (single source of truth).
CREATE TYPE "Track" AS ENUM ('VOLUNTEER', 'DIRECTOR');

-- TermMembership.kind (was MembershipKind, NOT NULL).
ALTER TABLE "TermMembership"
  ALTER COLUMN "kind" TYPE "Track" USING ("kind"::text::"Track");

-- RoleAssignment.kind (was MembershipKind, nullable). The RoleAssignment_unique_grant
-- index embeds a CASE over kind, so Postgres stored the column's enum type inside
-- the index expression ('DIRECTOR'::"MembershipKind"). That expression cannot be
-- re-derived against the new type in place, so drop the index, convert, recreate.
DROP INDEX "RoleAssignment_unique_grant";
ALTER TABLE "RoleAssignment"
  ALTER COLUMN "kind" TYPE "Track" USING ("kind"::text::"Track");
CREATE UNIQUE INDEX "RoleAssignment_unique_grant"
  ON "RoleAssignment" (
    "roleId",
    COALESCE("personId", ''),
    COALESCE("departmentId", ''),
    (CASE "kind" WHEN 'DIRECTOR' THEN 'DIRECTOR' WHEN 'VOLUNTEER' THEN 'VOLUNTEER' ELSE '' END),
    COALESCE("termId", '')
  );

-- RecruitmentCycle.track (was RecruitmentTrack, NOT NULL).
ALTER TABLE "RecruitmentCycle"
  ALTER COLUMN "track" TYPE "Track" USING ("track"::text::"Track");

-- Training.track (was TrainingTrack, NOT NULL, DEFAULT 'VOLUNTEER'). Postgres
-- will not change a column's type while a default of the old type is attached,
-- so drop it first, convert, then restore the default under the new type.
ALTER TABLE "Training" ALTER COLUMN "track" DROP DEFAULT;
ALTER TABLE "Training"
  ALTER COLUMN "track" TYPE "Track" USING ("track"::text::"Track");
ALTER TABLE "Training" ALTER COLUMN "track" SET DEFAULT 'VOLUNTEER';

-- Retire the now-unused duplicate enums.
DROP TYPE "MembershipKind";
DROP TYPE "RecruitmentTrack";
DROP TYPE "TrainingTrack";
