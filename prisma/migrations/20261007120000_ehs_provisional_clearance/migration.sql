-- CreateTable
CREATE TABLE "EhsProvisionalClearance" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "trainingId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remindedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "EhsProvisionalClearance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EhsProvisionalClearance_personId_trainingId_idx" ON "EhsProvisionalClearance"("personId", "trainingId");

-- CreateIndex
CREATE INDEX "EhsProvisionalClearance_expiresAt_idx" ON "EhsProvisionalClearance"("expiresAt");

-- AddForeignKey
ALTER TABLE "EhsProvisionalClearance" ADD CONSTRAINT "EhsProvisionalClearance_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EhsProvisionalClearance" ADD CONSTRAINT "EhsProvisionalClearance_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EhsProvisionalClearance" ADD CONSTRAINT "EhsProvisionalClearance_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EhsProvisionalClearance" ADD CONSTRAINT "EhsProvisionalClearance_trainingId_fkey" FOREIGN KEY ("trainingId") REFERENCES "EhsTraining"("id") ON DELETE CASCADE ON UPDATE CASCADE;

