-- CreateTable
CREATE TABLE "RecruitmentInvite" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "expiresAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "claimedByEmailLower" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecruitmentInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentInvite_tokenHash_key" ON "RecruitmentInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "RecruitmentInvite_cycleId_idx" ON "RecruitmentInvite"("cycleId");

-- CreateIndex
CREATE INDEX "RecruitmentInvite_claimedByEmailLower_idx" ON "RecruitmentInvite"("claimedByEmailLower");

-- AddForeignKey
ALTER TABLE "RecruitmentInvite" ADD CONSTRAINT "RecruitmentInvite_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentInvite" ADD CONSTRAINT "RecruitmentInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
