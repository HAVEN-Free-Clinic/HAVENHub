-- rolling-deploy: PersonLanguage.score and SpanishAssessmentRecord.score are
-- being widened from INTEGER to DOUBLE PRECISION (float). This is a safe
-- additive type change -- all existing integer values are valid floats, no
-- data is lost, and no code path breaks on a wider numeric type.
--
-- The risk window is a running instance that still has the old Prisma client.
-- It does NOT quietly ignore the decimal part of a float, which is what this
-- note claimed first: Prisma coerces the column into the Int the old schema
-- declares and raises P2023 on a non-integral value, so the old client FAILS
-- THE READ. vercel.json runs `prisma migrate deploy && next build`, so the
-- column widens before the new build is promoted, and a code rollback
-- afterwards leaves the previous client erroring on every page that selects a
-- widened row: roster, schedule builder, profile, language review queue. Not
-- one lost decimal on one write.
--
-- The window is still narrow, because it opens only once a half score has
-- actually been recorded, and INTP assessments happen manually and infrequently.
-- The response is to roll FORWARD, never back, from that point on.
-- AlterTable
ALTER TABLE "PersonLanguage" ALTER COLUMN "score" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "SpanishAssessmentRecord" ALTER COLUMN "score" SET DATA TYPE DOUBLE PRECISION;
