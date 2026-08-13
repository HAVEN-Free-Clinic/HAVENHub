-- Adds the HAVEN_HUB support category, for problems with the Hub itself rather
-- than the external systems the other categories cover.
--
-- Trimmed by hand: `prisma migrate dev` also folded in pre-existing drift
-- between the shadow database and the schema (Training constraint renames left
-- over from the VolunteerTraining rename, and an Application.subcommitteeRanking
-- default drop). Neither belongs to this change, and shipping them here would
-- attribute unrelated schema history to a support-category addition.
ALTER TYPE "TechRequestCategory" ADD VALUE 'HAVEN_HUB';
