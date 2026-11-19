-- CreateTable
CREATE TABLE "CycleReviewException" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CycleReviewException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CycleReviewException_personId_idx" ON "CycleReviewException"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "CycleReviewException_cycleId_personId_key" ON "CycleReviewException"("cycleId", "personId");

-- AddForeignKey
ALTER TABLE "CycleReviewException" ADD CONSTRAINT "CycleReviewException_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleReviewException" ADD CONSTRAINT "CycleReviewException_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleReviewException" ADD CONSTRAINT "CycleReviewException_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
