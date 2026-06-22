-- CreateEnum
CREATE TYPE "ProviderCategory" AS ENUM ('COMMUNITY_HEALTH', 'CARDIOLOGY', 'ENDOCRINOLOGY', 'GASTROENTEROLOGY', 'BEHAVIORAL_HEALTH', 'OBGYN', 'ORTHOPEDICS', 'DERMATOLOGY', 'PULMONOLOGY', 'NEUROLOGY', 'OPHTHALMOLOGY', 'ENT', 'DENTAL', 'SOCIAL_SERVICES', 'INTERNAL_MEDICINE', 'SURGERY', 'PEDIATRICS', 'ANESTHESIOLOGY', 'EMERGENCY_MEDICINE', 'PSYCHIATRY', 'MEDICINE', 'UROLOGY', 'NEUROSURGERY', 'PODIATRY', 'THERAPEUTIC_RADIOLOGY', 'RADIOLOGY', 'RADIATION_ONCOLOGY', 'CHILD_PSYCHIATRY', 'REHAB_MEDICINE', 'PATHOLOGY', 'ORAL_MAXILLOFACIAL_SURGERY');

-- CreateEnum
CREATE TYPE "ProviderSystem" AS ENUM ('YNHH', 'COMMUNITY_HC', 'COMMUNITY_NONPROFIT', 'STATE_RESOURCE_HUB', 'NONPROFIT_LEGAL_AID');

-- CreateEnum
CREATE TYPE "ProviderFlag" AS ENUM ('SUCCESS', 'WARN', 'INFO');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'CONFIRMED');

-- CreateTable
CREATE TABLE "ReferralSite" (
    "id" TEXT NOT NULL,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "name" TEXT NOT NULL,
    "category" "ProviderCategory" NOT NULL,
    "specialty" TEXT NOT NULL,
    "system" "ProviderSystem" NOT NULL,
    "acceptsUninsured" BOOLEAN NOT NULL DEFAULT false,
    "freeCareEligible" BOOLEAN NOT NULL DEFAULT false,
    "slidingScale" BOOLEAN NOT NULL DEFAULT false,
    "waitWeeks" INTEGER,
    "waitNote" TEXT,
    "phone" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "languages" TEXT[],
    "schedulingContact" TEXT NOT NULL,
    "fax" TEXT,
    "referralSteps" TEXT[],
    "notes" TEXT,
    "flag" "ProviderFlag",
    "flagText" TEXT,
    "lastReviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderContact" (
    "id" TEXT NOT NULL,
    "referralSiteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,

    CONSTRAINT "ProviderContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferralSite_category_idx" ON "ReferralSite"("category");

-- CreateIndex
CREATE INDEX "ProviderContact_referralSiteId_idx" ON "ProviderContact"("referralSiteId");

-- AddForeignKey
ALTER TABLE "ProviderContact" ADD CONSTRAINT "ProviderContact_referralSiteId_fkey" FOREIGN KEY ("referralSiteId") REFERENCES "ReferralSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
