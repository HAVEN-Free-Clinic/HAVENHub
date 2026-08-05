-- Add the onboarding leg's own claim state plus the shared stall marker.
ALTER TABLE "ComplianceReminder"
  ADD COLUMN "onboardingRemindersSent" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "onboardingLastRemindedAt" TIMESTAMP(3),
  ADD COLUMN "stalledSince" TIMESTAMP(3);

-- Backfill. Without this, the first run after deploy sees a null
-- onboardingLastRemindedAt on every row and sends an onboarding reminder to every
-- uncleared member regardless of when they last heard from the HIPAA stream: a
-- one-time double-tap on exactly the population already getting the most email.
-- Seeding stalledSince from the same column also gives the first weekly digest a
-- real "outstanding since" per member instead of showing everyone as new.
UPDATE "ComplianceReminder"
SET "onboardingLastRemindedAt" = "lastRemindedAt",
    "stalledSince" = "lastRemindedAt"
WHERE "lastRemindedAt" IS NOT NULL;

-- The threshold escalation these guarded is gone (see the weekly clearance digest),
-- and lastStatus was written but never read.
ALTER TABLE "ComplianceReminder" DROP COLUMN "escalatedAt";
ALTER TABLE "ComplianceReminder" DROP COLUMN "lastStatus";
