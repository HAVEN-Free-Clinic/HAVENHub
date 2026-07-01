-- CreateEnum
CREATE TYPE "EhsCompletionSource" AS ENUM ('MANUAL', 'IMPORT');

-- CreateTable
CREATE TABLE "EhsTraining" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "requiredForAll" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EhsTraining_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EhsTrainingDepartment" (
    "id" TEXT NOT NULL,
    "trainingId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    CONSTRAINT "EhsTrainingDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EhsCompletion" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "trainingId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "source" "EhsCompletionSource" NOT NULL DEFAULT 'MANUAL',
    "markedById" TEXT,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EhsCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EhsTraining_name_key" ON "EhsTraining"("name");

-- CreateIndex
CREATE UNIQUE INDEX "EhsTrainingDepartment_trainingId_departmentId_key" ON "EhsTrainingDepartment"("trainingId", "departmentId");

-- CreateIndex
CREATE INDEX "EhsTrainingDepartment_departmentId_idx" ON "EhsTrainingDepartment"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "EhsCompletion_personId_trainingId_key" ON "EhsCompletion"("personId", "trainingId");

-- CreateIndex
CREATE INDEX "EhsCompletion_trainingId_idx" ON "EhsCompletion"("trainingId");

-- AddForeignKey
ALTER TABLE "EhsTrainingDepartment" ADD CONSTRAINT "EhsTrainingDepartment_trainingId_fkey" FOREIGN KEY ("trainingId") REFERENCES "EhsTraining"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EhsTrainingDepartment" ADD CONSTRAINT "EhsTrainingDepartment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EhsCompletion" ADD CONSTRAINT "EhsCompletion_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EhsCompletion" ADD CONSTRAINT "EhsCompletion_markedById_fkey" FOREIGN KEY ("markedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EhsCompletion" ADD CONSTRAINT "EhsCompletion_trainingId_fkey" FOREIGN KEY ("trainingId") REFERENCES "EhsTraining"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the catalog (idempotent). "everyone" items required for all; level-specific
-- items start unassigned (required for nobody) until an admin maps them to departments.
INSERT INTO "EhsTraining" ("id", "name", "description", "isActive", "requiredForAll", "position", "createdAt", "updatedAt") VALUES
  ('ehs_added_to_ehs', 'Added to EHS?', NULL, true, true, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ehs_hazard_comm', 'Chemical - Hazard Communication', NULL, true, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ehs_tb_awareness', 'Biological - TB Awareness', NULL, true, true, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ehs_bbp_clinical', 'BBP Clinical', NULL, true, false, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ehs_bbp_student', 'BBP Student', NULL, true, false, 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ehs_tb_baseline', 'TB Baseline Screening', NULL, true, false, 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ehs_respiration', 'Physical Safety - Respiration', NULL, true, false, 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
