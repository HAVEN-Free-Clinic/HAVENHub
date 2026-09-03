-- CreateEnum
CREATE TYPE "AttendanceEventKind" AS ENUM ('TRAINING', 'INFO_SESSION', 'OTHER');

-- CreateEnum
CREATE TYPE "EventCheckInMethod" AS ENUM ('STAFF', 'WALK_UP');

-- CreateTable
CREATE TABLE "AttendanceEvent" (
    "id" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "cycleId" TEXT,
    "kind" "AttendanceEventKind" NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "location" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventAttendance" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "personId" TEXT,
    "attendeeName" TEXT,
    "attendeeEmail" TEXT,
    "method" "EventCheckInMethod" NOT NULL,
    "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT,
    "note" TEXT,
    "blockersAtCheckIn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nudgeLastSentAt" TIMESTAMP(3),
    "nudgeCount" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendanceEvent_termId_startsAt_idx" ON "AttendanceEvent"("termId", "startsAt");

-- CreateIndex
CREATE INDEX "AttendanceEvent_cycleId_idx" ON "AttendanceEvent"("cycleId");

-- CreateIndex
CREATE INDEX "EventAttendance_eventId_idx" ON "EventAttendance"("eventId");

-- CreateIndex
CREATE INDEX "EventAttendance_personId_idx" ON "EventAttendance"("personId");

-- CreateIndex
CREATE INDEX "EventAttendance_attendeeEmail_idx" ON "EventAttendance"("attendeeEmail");

-- CreateIndex
CREATE UNIQUE INDEX "EventAttendance_eventId_personId_key" ON "EventAttendance"("eventId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "EventAttendance_eventId_attendeeEmail_key" ON "EventAttendance"("eventId", "attendeeEmail");

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventAttendance" ADD CONSTRAINT "EventAttendance_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "AttendanceEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventAttendance" ADD CONSTRAINT "EventAttendance_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventAttendance" ADD CONSTRAINT "EventAttendance_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Backfill: move existing training attendance into the event model.
--
-- Before this migration, live-session attendance was ONLY a pair of columns on
-- Training (attendanceRecordedById / attendanceRecordedAt) written by the roster
-- button. Those columns stay (they are still what the Training row records), but
-- attendance itself now lives on an event, and the roster button writes through
-- it. Without this backfill the attendance already taken this term would be
-- invisible on every event surface, and taking attendance again at the same
-- session would look like the first time it had ever been taken.
--
-- One TRAINING event per cycle that actually has attendance-completed training
-- rows -- not per cycle with a training date. A cycle nobody took attendance at
-- gets its event created on demand later (see ensureTrainingEventForCycle), and
-- inventing empty events here would put rows on the events list for sessions
-- that may never have happened.
-- ---------------------------------------------------------------------------

INSERT INTO "AttendanceEvent" ("id", "termId", "cycleId", "kind", "title", "startsAt", "location", "notes", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  c."termId",
  c."id",
  'TRAINING',
  c."title" || ' training',
  -- The cycle's in-person date when it has one, else the earliest attendance
  -- actually recorded against it: a real moment either way, never now().
  COALESCE(c."inPersonTrainingDate", MIN(COALESCE(t."attendanceRecordedAt", t."completedAt", t."createdAt"))),
  c."trainingLocation",
  'Created by migration from attendance recorded before events existed.',
  NOW(),
  NOW()
FROM "RecruitmentCycle" c
JOIN "Training" t ON t."cycleId" = c."id" AND t."completedVia" = 'ATTENDANCE'
GROUP BY c."id", c."termId", c."title", c."inPersonTrainingDate", c."trainingLocation";

-- One attendance row per attendance-completed Training row.
--
-- resolvedAt is set to the check-in time on purpose: these are historical rows,
-- and leaving them unresolved would hand the nudge stream every person who
-- attended training in any past term as a fresh candidate to email. Deploying
-- this feature must not mail hundreds of people about sessions they attended
-- months ago.
INSERT INTO "EventAttendance" ("id", "eventId", "personId", "method", "checkedInAt", "recordedById", "blockersAtCheckIn", "resolvedAt", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  e."id",
  t."personId",
  'STAFF',
  COALESCE(t."attendanceRecordedAt", t."completedAt", t."createdAt"),
  t."attendanceRecordedById",
  ARRAY[]::TEXT[],
  COALESCE(t."attendanceRecordedAt", t."completedAt", t."createdAt"),
  NOW(),
  NOW()
FROM "Training" t
JOIN "AttendanceEvent" e ON e."cycleId" = t."cycleId" AND e."kind" = 'TRAINING'
WHERE t."completedVia" = 'ATTENDANCE'
ON CONFLICT DO NOTHING;
