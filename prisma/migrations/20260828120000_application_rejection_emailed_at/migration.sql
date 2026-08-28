-- Per-application "we told them they were not selected" stamp.
--
-- Until now the only decision email the app could send was the acceptance, and
-- its idempotency handle was Acceptance.emailedAt. A rejected applicant has no
-- Acceptance row, so there was nowhere to record that a rejection went out and
-- no way to make a second Send a no-op. This column is that handle: the
-- rejection counterpart of Acceptance.emailedAt, claimed the same way (an
-- UPDATE gated on the column still being NULL), so a repeated Send or two
-- concurrent ones cannot email the same applicant twice.
--
-- Nullable with no default, so this is additive and a no-op for every existing
-- row: applications decided in past cycles read as "not yet emailed". That is
-- the correct starting state -- nothing has ever sent a rejection, and the Send
-- button is scoped to one cycle at a time, so no historical cycle can be
-- swept up by a click on a current one. Rolling deploy is safe: the serving
-- release simply never reads the column.

ALTER TABLE "Application" ADD COLUMN "rejectionEmailedAt" TIMESTAMP(3);
