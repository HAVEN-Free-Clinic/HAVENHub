-- AlterEnum
ALTER TYPE "EpicRequestStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "EpicRequest" ADD COLUMN     "accessEndDate" TIMESTAMP(3),
ADD COLUMN     "accessStartDate" TIMESTAMP(3),
ADD COLUMN     "memberEmailTemplate" TEXT,
ADD COLUMN     "memberEmailedAt" TIMESTAMP(3),
ADD COLUMN     "outcomeNote" TEXT;

-- AlterTable
ALTER TABLE "YnhhTicket" ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "sentById" TEXT;

-- AddForeignKey
ALTER TABLE "YnhhTicket" ADD CONSTRAINT "YnhhTicket_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
