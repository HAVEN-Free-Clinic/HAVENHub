-- CreateTable
CREATE TABLE "ReferralNote" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferralNote_referralId_createdAt_idx" ON "ReferralNote"("referralId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReferralNote" ADD CONSTRAINT "ReferralNote_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralNote" ADD CONSTRAINT "ReferralNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
