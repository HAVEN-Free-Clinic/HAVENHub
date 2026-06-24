-- Generalize VolunteerTraining -> Training (track-scoped)
CREATE TYPE "TrainingTrack" AS ENUM ('VOLUNTEER', 'DIRECTOR');

ALTER TABLE "VolunteerTraining" RENAME TO "Training";

ALTER TABLE "Training" ADD COLUMN "track" "TrainingTrack" NOT NULL DEFAULT 'VOLUNTEER';

DROP INDEX "VolunteerTraining_personId_termId_key";
CREATE UNIQUE INDEX "Training_personId_termId_track_key" ON "Training"("personId", "termId", "track");

ALTER INDEX "VolunteerTraining_termId_idx" RENAME TO "Training_termId_idx";
