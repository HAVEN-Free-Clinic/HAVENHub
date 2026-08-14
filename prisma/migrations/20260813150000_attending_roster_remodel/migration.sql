-- Attendings become one clinic-wide roster and one clinic-wide schedule,
-- maintained by Faculty Relations.
--
-- What was wrong before:
--   * an attending "belonged to" a service line, but an attending has a
--     SPECIALTY and covers whatever slot the schedule puts them in;
--   * the schedule was one grid per service line, but it is really ONE grid per
--     clinic date with a column per role (9am-12pm, 11am-2pm, RHD, BHD,
--     Specialty Clinic, Shadowing);
--   * a slot could hold one attending, but the 9am-12pm column carries two;
--   * six reproductive-health procedure columns sat on every attending;
--   * there was no on-call (a WEEK-scoped assignment) and no closed-day flag.
--
-- Existing RhdAttending/RhdClinic rows are preserved: attendings keep their
-- names and become reproductive-health-specialty roster entries, and each
-- clinic row folds into the clinic-wide day for its date, with its attending
-- landing in the RHD Attending slot.

-- 1. Specialties -------------------------------------------------------------

CREATE TABLE "AttendingSpecialty" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "runsSpecialtyClinic" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL,

    CONSTRAINT "AttendingSpecialty_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AttendingSpecialty_code_key" ON "AttendingSpecialty"("code");
CREATE UNIQUE INDEX "AttendingSpecialty_name_key" ON "AttendingSpecialty"("name");
CREATE INDEX "AttendingSpecialty_order_idx" ON "AttendingSpecialty"("order");

INSERT INTO "AttendingSpecialty" ("id", "code", "name", "runsSpecialtyClinic", "order") VALUES
  (gen_random_uuid()::text, 'PC',     'Primary Care',        false, 0),
  (gen_random_uuid()::text, 'RHD',    'Reproductive Health', false, 1),
  (gen_random_uuid()::text, 'BHD',    'Behavioral Health',   false, 2),
  (gen_random_uuid()::text, 'DERM',   'Dermatology',         true,  3),
  (gen_random_uuid()::text, 'NEURO',  'Neurology',           true,  4),
  (gen_random_uuid()::text, 'NEPHRO', 'Nephrology',          true,  5);

-- 2. Rename the models -------------------------------------------------------

ALTER TABLE "RhdAttending" RENAME TO "Attending";
ALTER TABLE "RhdClinic" RENAME TO "ClinicDay";

ALTER INDEX "RhdAttending_pkey" RENAME TO "Attending_pkey";
ALTER INDEX "RhdAttending_scheduleName_key" RENAME TO "Attending_scheduleName_key";
ALTER INDEX "RhdClinic_pkey" RENAME TO "ClinicDay_pkey";

ALTER TABLE "ClinicDay" RENAME CONSTRAINT "RhdClinic_termId_fkey" TO "ClinicDay_termId_fkey";

-- The service-line scoping added earlier in this branch never shipped, so these
-- objects may or may not exist depending on where a database is starting from.
DROP INDEX IF EXISTS "RhdAttending_departmentId_idx";
DROP INDEX IF EXISTS "RhdClinic_departmentId_idx";
DROP INDEX IF EXISTS "RhdClinic_termId_departmentId_clinicDate_key";
DROP INDEX IF EXISTS "RhdClinic_termId_clinicDate_key";
ALTER TABLE "Attending" DROP CONSTRAINT IF EXISTS "RhdAttending_departmentId_fkey";
ALTER TABLE "ClinicDay" DROP CONSTRAINT IF EXISTS "RhdClinic_departmentId_fkey";
ALTER TABLE "ClinicDay" DROP CONSTRAINT IF EXISTS "RhdClinic_attendingId_fkey";

-- 3. Attending becomes a central roster entry --------------------------------

ALTER TABLE "Attending"
  ADD COLUMN "credentials" TEXT,
  ADD COLUMN "specialtyId" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "phone" TEXT;

-- Everything on the roster today came from the reproductive health sheet.
UPDATE "Attending" SET "specialtyId" = (SELECT "id" FROM "AttendingSpecialty" WHERE "code" = 'RHD');

-- The six procedure columns become capability rows (step 5); drop them after.
-- departmentId goes away entirely: an attending has a specialty, not a line.
ALTER TABLE "Attending" DROP COLUMN IF EXISTS "departmentId";

CREATE INDEX "Attending_specialtyId_idx" ON "Attending"("specialtyId");
CREATE INDEX "Attending_isActive_idx" ON "Attending"("isActive");
ALTER TABLE "Attending" ADD CONSTRAINT "Attending_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "AttendingSpecialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Slots become clinic-wide columns ----------------------------------------

CREATE TABLE "ClinicSlot" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "allowsMultiple" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ClinicSlot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClinicSlot_label_key" ON "ClinicSlot"("label");
CREATE INDEX "ClinicSlot_order_idx" ON "ClinicSlot"("order");

-- The columns Faculty Relations actually keeps. Editable afterwards.
INSERT INTO "ClinicSlot" ("id", "label", "startTime", "endTime", "order", "allowsMultiple") VALUES
  (gen_random_uuid()::text, '9am-12pm',         '09:00', '12:00', 0, true),
  (gen_random_uuid()::text, '11am-2pm',         '11:00', '14:00', 1, false),
  (gen_random_uuid()::text, 'RHD Attending',    '09:00', '13:00', 2, false),
  (gen_random_uuid()::text, 'BHD Clinic',       '09:00', '13:00', 3, false),
  (gen_random_uuid()::text, 'Specialty Clinic', '09:00', '13:00', 4, false),
  (gen_random_uuid()::text, 'Shadowing',        '09:00', '13:00', 5, true);

-- 5. Capabilities become data, scoped by specialty ---------------------------

CREATE TABLE "AttendingCapability" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "specialtyId" TEXT,

    CONSTRAINT "AttendingCapability_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AttendingCapability_key_key" ON "AttendingCapability"("key");
CREATE INDEX "AttendingCapability_specialtyId_idx" ON "AttendingCapability"("specialtyId");

CREATE TABLE "AttendingCapabilityValue" (
    "id" TEXT NOT NULL,
    "attendingId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT 'unknown',

    CONSTRAINT "AttendingCapabilityValue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AttendingCapabilityValue_attendingId_capabilityId_key" ON "AttendingCapabilityValue"("attendingId", "capabilityId");
CREATE INDEX "AttendingCapabilityValue_attendingId_idx" ON "AttendingCapabilityValue"("attendingId");
CREATE INDEX "AttendingCapabilityValue_capabilityId_idx" ON "AttendingCapabilityValue"("capabilityId");

ALTER TABLE "AttendingCapability" ADD CONSTRAINT "AttendingCapability_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "AttendingSpecialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AttendingCapabilityValue" ADD CONSTRAINT "AttendingCapabilityValue_attendingId_fkey" FOREIGN KEY ("attendingId") REFERENCES "Attending"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendingCapabilityValue" ADD CONSTRAINT "AttendingCapabilityValue_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "AttendingCapability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The six reproductive-health procedures, asked only of that specialty. GAC
-- signing spans specialties in practice, but it is one of the six here and stays
-- with them; a clinic-wide question can be added later with specialtyId null.
INSERT INTO "AttendingCapability" ("id", "key", "label", "order", "specialtyId")
SELECT gen_random_uuid()::text, c."key", c."label", c."order",
       (SELECT "id" FROM "AttendingSpecialty" WHERE "code" = 'RHD')
  FROM (VALUES
    ('iudIn',     'IUD In',    0),
    ('iudOut',    'IUD Out',   1),
    ('nexplanon', 'Nexplanon', 2),
    ('gac',       'GAC',       3),
    ('emb',       'EMB',       4),
    ('seesMale',  'Sees Male', 5)
  ) AS c("key", "label", "order");

-- Carry each existing answer across. "unknown" stores no row, matching the
-- absence-is-unknown rule, so a re-read cannot disagree with itself.
INSERT INTO "AttendingCapabilityValue" ("id", "attendingId", "capabilityId", "value")
SELECT gen_random_uuid()::text, a."id", cap."id",
       CASE cap."key"
         WHEN 'iudIn'     THEN a."iudIn"
         WHEN 'iudOut'    THEN a."iudOut"
         WHEN 'nexplanon' THEN a."nexplanon"
         WHEN 'gac'       THEN a."gac"
         WHEN 'emb'       THEN a."emb"
         WHEN 'seesMale'  THEN a."seesMale"
       END
  FROM "Attending" a
 CROSS JOIN "AttendingCapability" cap;

DELETE FROM "AttendingCapabilityValue" WHERE "value" = 'unknown' OR "value" IS NULL;

ALTER TABLE "Attending" DROP COLUMN "iudIn",
                        DROP COLUMN "iudOut",
                        DROP COLUMN "nexplanon",
                        DROP COLUMN "gac",
                        DROP COLUMN "emb",
                        DROP COLUMN "seesMale";

-- 6. ClinicDay becomes one row per clinic date -------------------------------

ALTER TABLE "ClinicDay"
  ADD COLUMN "isClosed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "closedNote" TEXT,
  ADD COLUMN "onCallAttendingId" TEXT,
  ADD COLUMN "specialtyId" TEXT;

-- Collapse any per-department duplicates for the same date onto one row before
-- the new key is applied. Only reproductive health ever had rows, so in practice
-- this is a no-op; it is here so a database that did get a second line's rows
-- migrates rather than aborting on the unique index.
DELETE FROM "ClinicDay" a
 USING "ClinicDay" b
 WHERE a."termId" = b."termId"
   AND a."clinicDate" = b."clinicDate"
   AND a."id" > b."id";

CREATE UNIQUE INDEX "ClinicDay_termId_clinicDate_key" ON "ClinicDay"("termId", "clinicDate");
CREATE INDEX "ClinicDay_onCallAttendingId_idx" ON "ClinicDay"("onCallAttendingId");
CREATE INDEX "ClinicDay_specialtyId_idx" ON "ClinicDay"("specialtyId");

-- 7. Assignments: many attendings per slot -----------------------------------

CREATE TABLE "ClinicDayAttending" (
    "id" TEXT NOT NULL,
    "clinicDayId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "attendingId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ClinicDayAttending_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClinicDayAttending_clinicDayId_slotId_attendingId_key" ON "ClinicDayAttending"("clinicDayId", "slotId", "attendingId");
CREATE INDEX "ClinicDayAttending_clinicDayId_idx" ON "ClinicDayAttending"("clinicDayId");
CREATE INDEX "ClinicDayAttending_slotId_idx" ON "ClinicDayAttending"("slotId");
CREATE INDEX "ClinicDayAttending_attendingId_idx" ON "ClinicDayAttending"("attendingId");

-- Existing assignments were all reproductive health, so they land in that slot.
INSERT INTO "ClinicDayAttending" ("id", "clinicDayId", "slotId", "attendingId", "order")
SELECT gen_random_uuid()::text, cd."id",
       (SELECT "id" FROM "ClinicSlot" WHERE "label" = 'RHD Attending'),
       cd."attendingId", 0
  FROM "ClinicDay" cd
 WHERE cd."attendingId" IS NOT NULL;

-- Refuse to drop the column while any assignment would be lost.
DO $$
DECLARE orphaned INTEGER;
BEGIN
  SELECT count(*) INTO orphaned
    FROM "ClinicDay" cd
   WHERE cd."attendingId" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "ClinicDayAttending" a WHERE a."clinicDayId" = cd."id");
  IF orphaned > 0 THEN
    RAISE EXCEPTION 'Refusing to drop ClinicDay.attendingId: % assignment(s) did not migrate.', orphaned;
  END IF;
END $$;

ALTER TABLE "ClinicDay" DROP COLUMN "attendingId";
ALTER TABLE "ClinicDay" DROP COLUMN IF EXISTS "departmentId";

ALTER TABLE "ClinicDay" ADD CONSTRAINT "ClinicDay_onCallAttendingId_fkey" FOREIGN KEY ("onCallAttendingId") REFERENCES "Attending"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClinicDay" ADD CONSTRAINT "ClinicDay_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "AttendingSpecialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClinicDayAttending" ADD CONSTRAINT "ClinicDayAttending_clinicDayId_fkey" FOREIGN KEY ("clinicDayId") REFERENCES "ClinicDay"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClinicDayAttending" ADD CONSTRAINT "ClinicDayAttending_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "ClinicSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClinicDayAttending" ADD CONSTRAINT "ClinicDayAttending_attendingId_fkey" FOREIGN KEY ("attendingId") REFERENCES "Attending"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 8. Credentialing pipeline ---------------------------------------------------

CREATE TABLE "AttendingCredentialing" (
    "id" TEXT NOT NULL,
    "attendingId" TEXT NOT NULL,
    "infoEmailSent" BOOLEAN NOT NULL DEFAULT false,
    "formsReceived" BOOLEAN NOT NULL DEFAULT false,
    "npdbCheck" BOOLEAN NOT NULL DEFAULT false,
    "oapd" BOOLEAN NOT NULL DEFAULT false,
    "needsFtca" BOOLEAN NOT NULL DEFAULT false,
    "ftcaSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "medDirectorApprovalNeeded" BOOLEAN NOT NULL DEFAULT false,
    "medDirectorApproved" BOOLEAN NOT NULL DEFAULT false,
    "steeringCommitteeApprovalNeeded" BOOLEAN NOT NULL DEFAULT false,
    "steeringCommitteeApproved" BOOLEAN NOT NULL DEFAULT false,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendingCredentialing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AttendingCredentialing_attendingId_key" ON "AttendingCredentialing"("attendingId");
ALTER TABLE "AttendingCredentialing" ADD CONSTRAINT "AttendingCredentialing_attendingId_fkey" FOREIGN KEY ("attendingId") REFERENCES "Attending"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 9. Departments no longer own attendings ------------------------------------

ALTER TABLE "Department" DROP COLUMN IF EXISTS "hasAttendingRoster";
