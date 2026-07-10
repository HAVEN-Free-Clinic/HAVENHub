-- Per-row send claim so a concurrent email drain cannot double-send a queued row.
-- A drain claims a row (updateMany status=QUEUED, lock free -> lockedAt=now) before
-- sending; the loser of a concurrent claim skips the row. Null means unclaimed; the
-- claim is cleared on completion, and a stale lock (crashed worker) is reclaimable.
ALTER TABLE "EmailLog" ADD COLUMN "lockedAt" TIMESTAMP(3);
