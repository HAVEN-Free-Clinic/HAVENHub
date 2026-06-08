-- DropIndex
DROP INDEX "ShiftRequest_termId_status_idx";

-- CreateIndex
CREATE INDEX "ShiftRequest_termId_departmentId_status_idx" ON "ShiftRequest"("termId", "departmentId", "status");
