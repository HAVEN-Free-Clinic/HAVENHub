-- A separate migration because Postgres cannot use an enum value in the same
-- transaction that added it (MOCK_CLINIC arrives in 20260919200000).
--
-- Mock clinic was taken as an OTHER event before the kind existed. Moving it
-- to MOCK_CLINIC is what lets its existing check-ins count: the attendance
-- rows are untouched, only what they mean changes.
UPDATE "AttendanceEvent" SET "kind" = 'MOCK_CLINIC'
WHERE "kind" = 'OTHER' AND "cycleId" IS NOT NULL AND "title" ILIKE '%mock clinic%';
