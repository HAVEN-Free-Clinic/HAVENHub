-- Recurring reminders for applicants who started an application and never
-- submitted it. Two counters because the cadence tightens toward the cycle's
-- closesAt: a single budget would be spent by the routine weekly sends before
-- the final days ever arrived. See services/draft-reminders.ts.
ALTER TABLE "Application"
  ADD COLUMN "draftReminderCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "draftFinalReminderCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "draftReminderLastSentAt" TIMESTAMP(3);

-- The reminder pass asks for DRAFT rows that are due. Without this it is a
-- sequential scan of every application ever submitted to find the few hundred
-- drafts that are still live.
CREATE INDEX "Application_status_draftReminderLastSentAt_idx"
  ON "Application" ("status", "draftReminderLastSentAt");
