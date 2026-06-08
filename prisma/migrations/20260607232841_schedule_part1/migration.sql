-- CreateEnum
CREATE TYPE "ShiftRole" AS ENUM ('DIRECTOR', 'VOLUNTEER', 'SHADOW');

-- AlterTable
ALTER TABLE "TermMembership" ADD COLUMN     "directorAvailabilityDates" TIMESTAMP(3)[],
ADD COLUMN     "directorAvailabilitySetAt" TIMESTAMP(3),
ADD COLUMN     "selfAvailabilityDates" TIMESTAMP(3)[];

-- CreateTable
CREATE TABLE "ShiftAssignment" (
    "id" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "clinicDate" TIMESTAMP(3) NOT NULL,
    "role" "ShiftRole" NOT NULL,
    "triage" BOOLEAN NOT NULL DEFAULT false,
    "walkin" BOOLEAN NOT NULL DEFAULT false,
    "cc" BOOLEAN NOT NULL DEFAULT false,
    "remote" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShiftAssignment_termId_clinicDate_idx" ON "ShiftAssignment"("termId", "clinicDate");

-- CreateIndex
CREATE INDEX "ShiftAssignment_personId_termId_idx" ON "ShiftAssignment"("personId", "termId");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftAssignment_termId_departmentId_clinicDate_personId_key" ON "ShiftAssignment"("termId", "departmentId", "clinicDate", "personId");

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
