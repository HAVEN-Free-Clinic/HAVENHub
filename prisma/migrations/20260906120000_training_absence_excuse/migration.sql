-- CreateTable
CREATE TABLE "TrainingAbsenceExcuse" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "personId" TEXT,
    "emailLower" TEXT,
    "reason" TEXT NOT NULL,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingAbsenceExcuse_pkey" PRIMARY KEY ("id")
);

-- Exactly one identity per row. Prisma cannot express "one of these two columns
-- is set", and without it a row with neither would be an excuse for nobody and a
-- row with both could be two people. Named so a violation is legible in a log.
ALTER TABLE "TrainingAbsenceExcuse"
  ADD CONSTRAINT "TrainingAbsenceExcuse_one_identity"
  CHECK (("personId" IS NULL) <> ("emailLower" IS NULL));

-- CreateIndex
CREATE INDEX "TrainingAbsenceExcuse_personId_idx" ON "TrainingAbsenceExcuse"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAbsenceExcuse_cycleId_personId_key" ON "TrainingAbsenceExcuse"("cycleId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAbsenceExcuse_cycleId_emailLower_key" ON "TrainingAbsenceExcuse"("cycleId", "emailLower");

-- AddForeignKey
ALTER TABLE "TrainingAbsenceExcuse" ADD CONSTRAINT "TrainingAbsenceExcuse_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAbsenceExcuse" ADD CONSTRAINT "TrainingAbsenceExcuse_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAbsenceExcuse" ADD CONSTRAINT "TrainingAbsenceExcuse_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
