-- Give attendings a Hub account, a place to record their own availability, and a
-- swap/drop request trail of their own.
--
-- Attendings were deliberately modelled as non-users: no Person, no login, email
-- as their only channel. This adds the bridge (Attending.personId) without moving
-- any clinical fact off the roster -- the grid still keys on Attending, and the
-- term-sheet importer still resolves by scheduleName.

-- AlterTable: the Hub account, nullable and SetNull. Deleting the account revokes
-- the login; it must never remove a doctor from the schedule.
ALTER TABLE "Attending" ADD COLUMN "personId" TEXT;

CREATE UNIQUE INDEX "Attending_personId_key" ON "Attending"("personId");

ALTER TABLE "Attending" ADD CONSTRAINT "Attending_personId_fkey"
  FOREIGN KEY ("personId") REFERENCES "Person"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: one attending's self-reported clinic dates for one term. ONE tier,
-- unlike TermMembership's three: an attending's availability arrives exactly one
-- way, so a baseline or director-override column would never be written.
CREATE TABLE "AttendingAvailability" (
    "id" TEXT NOT NULL,
    "attendingId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "dates" TIMESTAMP(3)[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendingAvailability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttendingAvailability_attendingId_termId_key" ON "AttendingAvailability"("attendingId", "termId");
CREATE INDEX "AttendingAvailability_termId_idx" ON "AttendingAvailability"("termId");

ALTER TABLE "AttendingAvailability" ADD CONSTRAINT "AttendingAvailability_attendingId_fkey"
  FOREIGN KEY ("attendingId") REFERENCES "Attending"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendingAvailability" ADD CONSTRAINT "AttendingAvailability_termId_fkey"
  FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: swap/drop against the attending grid. A sibling of ShiftRequest,
-- not a widening of it: an attending assignment is (attending, clinic day, SLOT),
-- and the swap has to name which COLUMN moves.
CREATE TABLE "AttendingShiftRequest" (
    "id" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "requesterDayId" TEXT NOT NULL,
    "requesterSlotId" TEXT NOT NULL,
    "targetId" TEXT,
    "targetDayId" TEXT,
    "targetSlotId" TEXT,
    "status" "ShiftRequestStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendingShiftRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AttendingShiftRequest_termId_status_idx" ON "AttendingShiftRequest"("termId", "status");
CREATE INDEX "AttendingShiftRequest_requesterId_idx" ON "AttendingShiftRequest"("requesterId");
CREATE INDEX "AttendingShiftRequest_targetId_idx" ON "AttendingShiftRequest"("targetId");

ALTER TABLE "AttendingShiftRequest" ADD CONSTRAINT "AttendingShiftRequest_termId_fkey"
  FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttendingShiftRequest" ADD CONSTRAINT "AttendingShiftRequest_requesterId_fkey"
  FOREIGN KEY ("requesterId") REFERENCES "Attending"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendingShiftRequest" ADD CONSTRAINT "AttendingShiftRequest_requesterDayId_fkey"
  FOREIGN KEY ("requesterDayId") REFERENCES "ClinicDay"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendingShiftRequest" ADD CONSTRAINT "AttendingShiftRequest_requesterSlotId_fkey"
  FOREIGN KEY ("requesterSlotId") REFERENCES "ClinicSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendingShiftRequest" ADD CONSTRAINT "AttendingShiftRequest_targetId_fkey"
  FOREIGN KEY ("targetId") REFERENCES "Attending"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AttendingShiftRequest" ADD CONSTRAINT "AttendingShiftRequest_targetDayId_fkey"
  FOREIGN KEY ("targetDayId") REFERENCES "ClinicDay"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AttendingShiftRequest" ADD CONSTRAINT "AttendingShiftRequest_targetSlotId_fkey"
  FOREIGN KEY ("targetSlotId") REFERENCES "ClinicSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AttendingShiftRequest" ADD CONSTRAINT "AttendingShiftRequest_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DB backstop, mirroring ShiftRequest_pending_unique: no two PENDING requests for
-- the same (requester, clinic day, slot). Prisma cannot express partial indexes,
-- so it lives here. The service layer's in-transaction check gives the friendly
-- error first; this closes the race window.
-- Guarded by src/modules/schedule/services/schedule-schema-guards.test.ts.
CREATE UNIQUE INDEX "AttendingShiftRequest_pending_unique"
  ON "AttendingShiftRequest"("requesterId", "requesterDayId", "requesterSlotId")
  WHERE "status" = 'PENDING';
