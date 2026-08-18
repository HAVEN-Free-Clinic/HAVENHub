-- Trimmed by hand from `prisma migrate dev`, which also folded in pre-existing
-- drift unrelated to this change (an Application.subcommitteeRanking default
-- drop, Training/VolunteerTraining constraint renames). Those belong to
-- whichever change introduced them.

/*
  Warnings:

  - Added the required column `messageBody` to the `TriageChat` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TriageChat" ADD COLUMN     "messageBody" TEXT NOT NULL;
