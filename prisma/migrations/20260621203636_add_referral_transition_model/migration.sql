-- CreateTable
CREATE TABLE "ReferralTransition" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "fromState" "ReferralState",
    "toState" "ReferralState" NOT NULL,
    "reason" TEXT,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferralTransition_referralId_createdAt_idx" ON "ReferralTransition"("referralId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReferralTransition" ADD CONSTRAINT "ReferralTransition_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralTransition" ADD CONSTRAINT "ReferralTransition_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
