-- CreateTable
CREATE TABLE "AiReview" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "runLabel" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "merit" INTEGER NOT NULL,
    "engagement" INTEGER NOT NULL,
    "skills" INTEGER NOT NULL,
    "effort" INTEGER NOT NULL,
    "reliability" INTEGER NOT NULL,
    "firstChoiceDepartmentCode" TEXT,
    "firstChoiceFit" INTEGER,
    "bestFitDepartmentCode" TEXT,
    "justification" TEXT NOT NULL,
    "flags" TEXT[],
    "overrideNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiReview_applicationId_key" ON "AiReview"("applicationId");

-- AddForeignKey
ALTER TABLE "AiReview" ADD CONSTRAINT "AiReview_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

