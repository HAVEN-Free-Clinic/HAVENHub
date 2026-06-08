-- CreateEnum
CREATE TYPE "ShiftRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "idealHeadcount" INTEGER,
ADD COLUMN     "patientCapacityPerProvider" INTEGER;

-- AlterTable
ALTER TABLE "Person" ADD COLUMN     "licensedRN" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "spanishSpeaking" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ShiftRequest" (
    "id" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "requesterDate" TIMESTAMP(3) NOT NULL,
    "departmentId" TEXT NOT NULL,
    "targetId" TEXT,
    "targetDate" TIMESTAMP(3),
    "status" "ShiftRequestStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleDay" (
    "id" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "clinicDate" TIMESTAMP(3) NOT NULL,
    "patientsBooked" INTEGER,

    CONSTRAINT "ScheduleDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RhdAttending" (
    "id" TEXT NOT NULL,
    "scheduleName" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "iudIn" TEXT NOT NULL DEFAULT 'unknown',
    "iudOut" TEXT NOT NULL DEFAULT 'unknown',
    "nexplanon" TEXT NOT NULL DEFAULT 'unknown',
    "gac" TEXT NOT NULL DEFAULT 'unknown',
    "emb" TEXT NOT NULL DEFAULT 'unknown',
    "seesMale" TEXT NOT NULL DEFAULT 'unknown',
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RhdAttending_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RhdClinic" (
    "id" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "clinicDate" TIMESTAMP(3) NOT NULL,
    "attendingId" TEXT,
    "directorName" TEXT,
    "proceduresBooked" INTEGER,

    CONSTRAINT "RhdClinic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShiftRequest_termId_status_idx" ON "ShiftRequest"("termId", "status");

-- CreateIndex
CREATE INDEX "ShiftRequest_requesterId_idx" ON "ShiftRequest"("requesterId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleDay_termId_departmentId_clinicDate_key" ON "ScheduleDay"("termId", "departmentId", "clinicDate");

-- CreateIndex
CREATE UNIQUE INDEX "RhdAttending_scheduleName_key" ON "RhdAttending"("scheduleName");

-- CreateIndex
CREATE UNIQUE INDEX "RhdClinic_termId_clinicDate_key" ON "RhdClinic"("termId", "clinicDate");

-- AddForeignKey
ALTER TABLE "ShiftRequest" ADD CONSTRAINT "ShiftRequest_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftRequest" ADD CONSTRAINT "ShiftRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftRequest" ADD CONSTRAINT "ShiftRequest_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftRequest" ADD CONSTRAINT "ShiftRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftRequest" ADD CONSTRAINT "ShiftRequest_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleDay" ADD CONSTRAINT "ScheduleDay_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleDay" ADD CONSTRAINT "ScheduleDay_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RhdClinic" ADD CONSTRAINT "RhdClinic_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RhdClinic" ADD CONSTRAINT "RhdClinic_attendingId_fkey" FOREIGN KEY ("attendingId") REFERENCES "RhdAttending"("id") ON DELETE SET NULL ON UPDATE CASCADE;
