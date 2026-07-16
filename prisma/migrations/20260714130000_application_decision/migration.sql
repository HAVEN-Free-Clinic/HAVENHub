-- AlterTable
ALTER TABLE "Application" ADD COLUMN "decision" "InterviewDecision" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Application" ADD COLUMN "decidedById" TEXT;
ALTER TABLE "Application" ADD COLUMN "decidedAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
