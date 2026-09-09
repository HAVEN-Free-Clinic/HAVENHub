-- rolling-deploy: PersonLanguage.score and SpanishAssessmentRecord.score are
-- being widened from INTEGER to DOUBLE PRECISION (float). This is a safe
-- additive type change -- all existing integer values are valid floats, no
-- data is lost, and no code path breaks on a wider numeric type. The only
-- risk window is a running instance that still has the old Prisma client, which
-- would ignore the decimal part of any new float scores written during deploy.
-- That window is acceptable: INTP assessments happen manually and infrequently.
-- AlterTable
ALTER TABLE "PersonLanguage" ALTER COLUMN "score" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "SpanishAssessmentRecord" ALTER COLUMN "score" SET DATA TYPE DOUBLE PRECISION;