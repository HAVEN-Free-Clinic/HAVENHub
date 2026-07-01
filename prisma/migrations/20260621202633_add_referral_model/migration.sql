-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "referralType" "ReferralType" NOT NULL,
    "purpose" "ReferralPurpose" NOT NULL,
    "urgency" "ReferralUrgency" NOT NULL DEFAULT 'ROUTINE',
    "state" "ReferralState" NOT NULL DEFAULT 'ENTERED',
    "referringDepartmentId" TEXT,
    "assignedDirectorId" TEXT,
    "specialty" TEXT,
    "reasonForReferral" TEXT,
    "appointmentDate" TIMESTAMP(3),
    "patientNavigatorId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Referral_state_idx" ON "Referral"("state");

-- CreateIndex
CREATE INDEX "Referral_patientId_idx" ON "Referral"("patientId");

-- CreateIndex
CREATE INDEX "Referral_referringDepartmentId_idx" ON "Referral"("referringDepartmentId");

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referringDepartmentId_fkey" FOREIGN KEY ("referringDepartmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_assignedDirectorId_fkey" FOREIGN KEY ("assignedDirectorId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_patientNavigatorId_fkey" FOREIGN KEY ("patientNavigatorId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
