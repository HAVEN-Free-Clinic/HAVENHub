-- DropForeignKey
ALTER TABLE "OffboardFlag" DROP CONSTRAINT "OffboardFlag_flaggedById_fkey";

-- DropIndex
DROP INDEX "EpicRequest_personId_idx";

-- CreateIndex
CREATE INDEX "EpicRequest_personId_status_idx" ON "EpicRequest"("personId", "status");

-- AddForeignKey
ALTER TABLE "OffboardFlag" ADD CONSTRAINT "OffboardFlag_flaggedById_fkey" FOREIGN KEY ("flaggedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
