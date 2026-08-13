-- Board meeting attendance for directors.
--
-- Greenfield: no backfill, nothing to migrate. The absence of an attendance row
-- means "not yet recorded", never "absent", so an empty table accrues nothing
-- against anyone.

-- CreateEnum
CREATE TYPE "BoardAttendanceStatus" AS ENUM ('PRESENT', 'EXCUSED', 'ABSENT');

-- CreateTable
CREATE TABLE "BoardMeeting" (
    "id" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "meetingDate" TIMESTAMP(3) NOT NULL,
    "title" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoardMeetingAttendance" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "status" "BoardAttendanceStatus" NOT NULL,
    "note" TEXT,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoardMeetingAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BoardMeeting_termId_idx" ON "BoardMeeting"("termId");
CREATE UNIQUE INDEX "BoardMeeting_termId_meetingDate_key" ON "BoardMeeting"("termId", "meetingDate");
CREATE INDEX "BoardMeetingAttendance_personId_idx" ON "BoardMeetingAttendance"("personId");
CREATE UNIQUE INDEX "BoardMeetingAttendance_meetingId_personId_key" ON "BoardMeetingAttendance"("meetingId", "personId");

-- AddForeignKey
ALTER TABLE "BoardMeeting" ADD CONSTRAINT "BoardMeeting_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BoardMeetingAttendance" ADD CONSTRAINT "BoardMeetingAttendance_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "BoardMeeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BoardMeetingAttendance" ADD CONSTRAINT "BoardMeetingAttendance_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BoardMeetingAttendance" ADD CONSTRAINT "BoardMeetingAttendance_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
