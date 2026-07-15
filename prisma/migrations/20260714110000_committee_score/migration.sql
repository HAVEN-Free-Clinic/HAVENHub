-- CreateTable
CREATE TABLE "CommitteeScore" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "scorerId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "comments" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommitteeScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommitteeScore_applicationId_scorerId_key" ON "CommitteeScore"("applicationId", "scorerId");

-- CreateIndex
CREATE INDEX "CommitteeScore_applicationId_idx" ON "CommitteeScore"("applicationId");

-- AddForeignKey
ALTER TABLE "CommitteeScore" ADD CONSTRAINT "CommitteeScore_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommitteeScore" ADD CONSTRAINT "CommitteeScore_scorerId_fkey" FOREIGN KEY ("scorerId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
