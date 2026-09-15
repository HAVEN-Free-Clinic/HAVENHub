-- Draft shifts for first-time applicants.
--
-- Directors can already draft next term's schedule around accepted RETURNERS,
-- because a returner applied signed in and so has a Person a ShiftAssignment can
-- point at. A first-time applicant has no Person until roster build creates one,
-- so their row in the builder rendered as a line of dashes nobody could click.
--
-- This table holds those drafts keyed on the acceptance instead of a person.
-- promoteContracts moves them onto ShiftAssignment in the same transaction that
-- creates the Person and the membership. Additive only: nothing existing changes.

-- CreateTable
CREATE TABLE "IncomingShiftAssignment" (
    "id" TEXT NOT NULL,
    "acceptanceId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "clinicDate" TIMESTAMP(3) NOT NULL,
    "role" "ShiftRole" NOT NULL,
    "triage" BOOLEAN NOT NULL DEFAULT false,
    "walkin" BOOLEAN NOT NULL DEFAULT false,
    "cc" BOOLEAN NOT NULL DEFAULT false,
    "remote" BOOLEAN NOT NULL DEFAULT false,
    "specialty" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncomingShiftAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IncomingShiftAssignment_acceptanceId_clinicDate_key" ON "IncomingShiftAssignment"("acceptanceId", "clinicDate");

-- CreateIndex
CREATE INDEX "IncomingShiftAssignment_termId_departmentId_idx" ON "IncomingShiftAssignment"("termId", "departmentId");

-- AddForeignKey
ALTER TABLE "IncomingShiftAssignment" ADD CONSTRAINT "IncomingShiftAssignment_acceptanceId_fkey" FOREIGN KEY ("acceptanceId") REFERENCES "Acceptance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomingShiftAssignment" ADD CONSTRAINT "IncomingShiftAssignment_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomingShiftAssignment" ADD CONSTRAINT "IncomingShiftAssignment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
