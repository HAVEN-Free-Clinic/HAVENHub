-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "scormScos" JSONB;

-- CreateTable
CREATE TABLE "ScoProgress" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "scoId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "lessonStatus" TEXT,
    "scoreRaw" INTEGER,
    "suspendData" TEXT,
    "lessonLocation" TEXT,

    CONSTRAINT "ScoProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScoProgress_courseId_idx" ON "ScoProgress"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "ScoProgress_personId_courseId_scoId_key" ON "ScoProgress"("personId", "courseId", "scoId");

-- AddForeignKey
ALTER TABLE "ScoProgress" ADD CONSTRAINT "ScoProgress_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoProgress" ADD CONSTRAINT "ScoProgress_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
