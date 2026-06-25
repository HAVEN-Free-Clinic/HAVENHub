-- AlterTable
ALTER TABLE "Applicant" ADD COLUMN     "applicantPersonId" TEXT;

-- CreateIndex
CREATE INDEX "Applicant_applicantPersonId_idx" ON "Applicant"("applicantPersonId");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "Applicant_cycleId_applicantPersonId_key" ON "Applicant"("cycleId", "applicantPersonId");

-- AddForeignKey
ALTER TABLE "Applicant" ADD CONSTRAINT "Applicant_applicantPersonId_fkey" FOREIGN KEY ("applicantPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
