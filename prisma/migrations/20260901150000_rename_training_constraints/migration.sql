-- Finish the VolunteerTraining -> Training rename.
--
-- 20260624000000_generalize_training_to_track renamed the TABLE and its indexes,
-- but Postgres does not rename a table's CONSTRAINTS along with it, and that
-- migration did not do it by hand. So the primary key and four foreign keys have
-- been sitting there called "VolunteerTraining_*" on a table called Training ever
-- since, and Prisma has wanted to rename them on every diff.
--
-- That is half of the pre-existing drift `prisma migrate dev` has been folding
-- into unrelated migrations for months; at least seven of them carry a comment
-- explaining that it was trimmed back out (see 20260812020028, 20260816130000,
-- 20260817195346, and others). The other half is Application.subcommitteeRanking,
-- fixed in the schema in the same commit as this migration by declaring the
-- default the column already has.
--
-- rolling-deploy: constraint names are catalog-only. Nothing in the application
-- references them (Prisma addresses constraints by the columns they cover, and
-- no code here uses ON CONFLICT ON CONSTRAINT), and FK and PK enforcement is
-- unaffected by a rename. Each statement takes a brief ACCESS EXCLUSIVE lock on
-- Training to update the catalog row; the table is small and the lock is held for
-- microseconds. Both the old and new application versions run against either
-- naming.
--
-- Safe to apply exactly once: every database built by replaying this migration
-- history still carries the VolunteerTraining_* names, verified against a fresh
-- replay. A database where these have already been renamed by hand would fail
-- here with "constraint does not exist", which is the intended loud failure
-- rather than a silent divergence.

-- AlterTable
ALTER TABLE "Training" RENAME CONSTRAINT "VolunteerTraining_pkey" TO "Training_pkey";

-- RenameForeignKey
ALTER TABLE "Training" RENAME CONSTRAINT "VolunteerTraining_attendanceRecordedById_fkey" TO "Training_attendanceRecordedById_fkey";

-- RenameForeignKey
ALTER TABLE "Training" RENAME CONSTRAINT "VolunteerTraining_cycleId_fkey" TO "Training_cycleId_fkey";

-- RenameForeignKey
ALTER TABLE "Training" RENAME CONSTRAINT "VolunteerTraining_personId_fkey" TO "Training_personId_fkey";

-- RenameForeignKey
ALTER TABLE "Training" RENAME CONSTRAINT "VolunteerTraining_termId_fkey" TO "Training_termId_fkey";
