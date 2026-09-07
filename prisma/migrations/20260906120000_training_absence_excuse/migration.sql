-- CreateTable
CREATE TABLE "TrainingAbsenceExcuse" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingAbsenceExcuse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrainingAbsenceExcuse_personId_idx" ON "TrainingAbsenceExcuse"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAbsenceExcuse_cycleId_personId_key" ON "TrainingAbsenceExcuse"("cycleId", "personId");

-- AddForeignKey
ALTER TABLE "TrainingAbsenceExcuse" ADD CONSTRAINT "TrainingAbsenceExcuse_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAbsenceExcuse" ADD CONSTRAINT "TrainingAbsenceExcuse_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAbsenceExcuse" ADD CONSTRAINT "TrainingAbsenceExcuse_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
