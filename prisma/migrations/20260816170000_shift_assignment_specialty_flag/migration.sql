-- Per-assignment "covering the specialty clinic" flag, alongside the existing
-- triage / walkin / cc / remote tags.
--
-- Trimmed by hand from `prisma migrate diff`, which also folded in pre-existing
-- drift unrelated to this change (Training/VolunteerTraining constraint renames,
-- an Application.subcommitteeRanking default). Those belong to whichever change
-- introduced them.
--
-- Additive with a default, so a deploy still running the previous build keeps
-- working: old code never selects the column, and every existing row reads false.

-- AlterTable
ALTER TABLE "ShiftAssignment" ADD COLUMN "specialty" BOOLEAN NOT NULL DEFAULT false;
