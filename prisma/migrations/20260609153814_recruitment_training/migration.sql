-- CreateEnum
CREATE TYPE "FormPurpose" AS ENUM ('APPLICATION', 'QUIZ');

-- CreateEnum
CREATE TYPE "TrainingStatus" AS ENUM ('PENDING', 'COMPLETE');

-- CreateEnum
CREATE TYPE "TrainingMethod" AS ENUM ('ATTENDANCE', 'QUIZ');

-- AlterTable
ALTER TABLE "FormField" ADD COLUMN     "correctValue" TEXT;

-- AlterTable
ALTER TABLE "FormSection" ADD COLUMN     "purpose" "FormPurpose" NOT NULL DEFAULT 'APPLICATION';

-- AlterTable
ALTER TABLE "RecruitmentCycle" ADD COLUMN     "isTermTraining" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "quizMaxAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "quizPassPercent" INTEGER NOT NULL DEFAULT 80;

-- CreateTable
CREATE TABLE "VolunteerTraining" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "status" "TrainingStatus" NOT NULL DEFAULT 'PENDING',
    "completedVia" "TrainingMethod",
    "completedAt" TIMESTAMP(3),
    "attendanceRecordedById" TEXT,
    "attendanceRecordedAt" TIMESTAMP(3),
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "lockResetAt" TIMESTAMP(3),
    "subcommitteeInterest" TEXT,
    "additionalShiftAvailability" TEXT,
    "minShiftsWanted" TEXT,
    "feedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerTraining_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizAttempt" (
    "id" TEXT NOT NULL,
    "trainingId" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "score" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VolunteerTraining_termId_idx" ON "VolunteerTraining"("termId");

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerTraining_personId_termId_key" ON "VolunteerTraining"("personId", "termId");

-- CreateIndex
CREATE INDEX "QuizAttempt_trainingId_takenAt_idx" ON "QuizAttempt"("trainingId", "takenAt");

-- AddForeignKey
ALTER TABLE "VolunteerTraining" ADD CONSTRAINT "VolunteerTraining_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerTraining" ADD CONSTRAINT "VolunteerTraining_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerTraining" ADD CONSTRAINT "VolunteerTraining_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerTraining" ADD CONSTRAINT "VolunteerTraining_attendanceRecordedById_fkey" FOREIGN KEY ("attendanceRecordedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_trainingId_fkey" FOREIGN KEY ("trainingId") REFERENCES "VolunteerTraining"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One designated training cycle per term (partial unique; Prisma cannot express this predicate).
CREATE UNIQUE INDEX "RecruitmentCycle_termId_training_unique"
  ON "RecruitmentCycle"("termId") WHERE "isTermTraining";
