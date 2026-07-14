-- Convert Evaluation.recommendation (enum) -> score (1-5 int), preserving data.
ALTER TABLE "Evaluation" ADD COLUMN "score" INTEGER;
UPDATE "Evaluation" SET "score" = CASE "recommendation"
  WHEN 'STRONG_YES' THEN 5
  WHEN 'YES' THEN 4
  WHEN 'MAYBE' THEN 3
  WHEN 'NO' THEN 1
END;
ALTER TABLE "Evaluation" ALTER COLUMN "score" SET NOT NULL;
ALTER TABLE "Evaluation" DROP COLUMN "recommendation";
DROP TYPE "Recommendation";
