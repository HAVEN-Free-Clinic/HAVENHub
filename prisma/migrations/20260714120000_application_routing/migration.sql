-- AlterTable
ALTER TABLE "Application" ADD COLUMN "routedDepartmentCode" TEXT;
ALTER TABLE "Application" ADD COLUMN "routedById" TEXT;
ALTER TABLE "Application" ADD COLUMN "routedAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_routedById_fkey" FOREIGN KEY ("routedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
