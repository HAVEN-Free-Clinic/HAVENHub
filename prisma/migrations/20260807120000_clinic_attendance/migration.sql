-- CreateEnum
CREATE TYPE "CheckInMethod" AS ENUM ('SELF_GEO', 'SELF_REMOTE', 'STAFF');

-- CreateTable
CREATE TABLE "ClinicAttendance" (
    "id" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "clinicDate" TIMESTAMP(3) NOT NULL,
    "personId" TEXT NOT NULL,
    "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" "CheckInMethod" NOT NULL,
    "distanceMeters" INTEGER,
    "accuracyMeters" INTEGER,
    "recordedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicAttendance_termId_clinicDate_idx" ON "ClinicAttendance"("termId", "clinicDate");

-- CreateIndex
CREATE INDEX "ClinicAttendance_personId_termId_idx" ON "ClinicAttendance"("personId", "termId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicAttendance_termId_clinicDate_personId_key" ON "ClinicAttendance"("termId", "clinicDate", "personId");

-- AddForeignKey
ALTER TABLE "ClinicAttendance" ADD CONSTRAINT "ClinicAttendance_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicAttendance" ADD CONSTRAINT "ClinicAttendance_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicAttendance" ADD CONSTRAINT "ClinicAttendance_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
