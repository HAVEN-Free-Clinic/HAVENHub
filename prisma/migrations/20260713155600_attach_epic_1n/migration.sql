-- Add child-side FK column
ALTER TABLE "EpicRequest" ADD COLUMN "techRequestId" TEXT;

-- Backfill from the old parent-side link (each EpicRequest was referenced by at most one TechRequest via the @unique FK)
UPDATE "EpicRequest" e
SET "techRequestId" = t."id"
FROM "TechRequest" t
WHERE t."epicRequestId" = e."id";

-- Index + FK constraint
CREATE INDEX "EpicRequest_techRequestId_idx" ON "EpicRequest"("techRequestId");
ALTER TABLE "EpicRequest" ADD CONSTRAINT "EpicRequest_techRequestId_fkey"
  FOREIGN KEY ("techRequestId") REFERENCES "TechRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Drop the old parent-side link (drops its unique index too)
ALTER TABLE "TechRequest" DROP COLUMN "epicRequestId";
