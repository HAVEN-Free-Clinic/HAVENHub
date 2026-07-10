-- Per-row send claim for the Teams drain, mirroring EmailLog.lockedAt (#214).
-- Lets two overlapping cron drains avoid double-sending the same Teams message.
ALTER TABLE "TeamsMessage" ADD COLUMN "lockedAt" TIMESTAMP(3);
