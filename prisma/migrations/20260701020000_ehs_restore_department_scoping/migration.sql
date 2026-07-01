-- Restore per-department EHS training assignment (central admin managed).
-- Re-adds what 20260701010000 removed; requirements evolved back to dept scoping.
ALTER TABLE "EhsTraining" ADD COLUMN "requiredForAll" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "EhsTrainingDepartment" (
    "id" TEXT NOT NULL,
    "trainingId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    CONSTRAINT "EhsTrainingDepartment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EhsTrainingDepartment_trainingId_departmentId_key" ON "EhsTrainingDepartment"("trainingId", "departmentId");
CREATE INDEX "EhsTrainingDepartment_departmentId_idx" ON "EhsTrainingDepartment"("departmentId");

ALTER TABLE "EhsTrainingDepartment" ADD CONSTRAINT "EhsTrainingDepartment_trainingId_fkey" FOREIGN KEY ("trainingId") REFERENCES "EhsTraining"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EhsTrainingDepartment" ADD CONSTRAINT "EhsTrainingDepartment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
