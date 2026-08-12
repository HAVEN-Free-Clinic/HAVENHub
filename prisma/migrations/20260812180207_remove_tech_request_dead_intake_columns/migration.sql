-- Drops seven dead TechRequest columns. Each was written in at most one place
-- (createTechRequest, gated on category EPIC) and nothing ever supplied the
-- input: absent from the submit form, from every page under /support, and
-- from the ITCM generation path. epicSubtype is kept -- it is genuinely read
-- (src/modules/support/services/tech-request.ts's LIST_SELECT and
-- TechRequestListRow) -- these seven are not read anywhere.
--
-- Trimmed by hand: `prisma migrate dev` also folded in pre-existing drift
-- between the shadow database and the schema (Training constraint renames left
-- over from the VolunteerTraining rename, and an Application.subcommitteeRanking
-- default drop). Neither belongs to this change, and shipping them here would
-- attribute unrelated schema history to a dead-column removal.
ALTER TABLE "TechRequest" DROP COLUMN "epicEndDate",
DROP COLUMN "epicJobTitle",
DROP COLUMN "epicMirrorId",
DROP COLUMN "epicStartDate",
DROP COLUMN "govId",
DROP COLUMN "netId",
DROP COLUMN "worksAtYnhh";
