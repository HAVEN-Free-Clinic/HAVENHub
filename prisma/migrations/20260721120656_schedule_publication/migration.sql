-- CreateTable
CREATE TABLE "SchedulePublication" (
    "id" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedById" TEXT,

    CONSTRAINT "SchedulePublication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SchedulePublication_termId_idx" ON "SchedulePublication"("termId");

-- CreateIndex
CREATE UNIQUE INDEX "SchedulePublication_termId_departmentId_key" ON "SchedulePublication"("termId", "departmentId");

-- AddForeignKey
ALTER TABLE "SchedulePublication" ADD CONSTRAINT "SchedulePublication_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchedulePublication" ADD CONSTRAINT "SchedulePublication_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchedulePublication" ADD CONSTRAINT "SchedulePublication_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
