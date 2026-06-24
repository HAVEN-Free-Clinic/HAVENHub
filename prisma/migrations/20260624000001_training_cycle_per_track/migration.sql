-- One designated training cycle per term PER TRACK
-- Replace the old single-track partial unique index with a per-track version.
DROP INDEX "RecruitmentCycle_termId_training_unique";

CREATE UNIQUE INDEX "RecruitmentCycle_termId_track_training_unique"
  ON "RecruitmentCycle"("termId", "track") WHERE "isTermTraining";
