-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "returnedById" TEXT,
ADD COLUMN     "returnedFromDepartmentCode" TEXT,
ADD COLUMN     "returnedReason" TEXT,
ADD COLUMN     "returnedToRoutingAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_returnedById_fkey" FOREIGN KEY ("returnedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
