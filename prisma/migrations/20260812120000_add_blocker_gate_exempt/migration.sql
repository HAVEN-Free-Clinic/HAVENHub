-- Additive and defaulted on purpose: nothing existing reads this column, so a
-- deploy where code and database briefly disagree cannot break. Older code
-- ignores it; newer code sees the default.
ALTER TABLE "Person" ADD COLUMN "blockerGateExempt" BOOLEAN NOT NULL DEFAULT false;
