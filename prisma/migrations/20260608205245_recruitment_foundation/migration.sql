-- CreateEnum
CREATE TYPE "RecruitmentTrack" AS ENUM ('VOLUNTEER', 'DIRECTOR');

-- CreateEnum
CREATE TYPE "CycleStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('SHORT_TEXT', 'LONG_TEXT', 'SINGLE_SELECT', 'MULTI_SELECT', 'CHECKBOX', 'EMAIL', 'PHONE', 'NUMBER', 'DATE', 'FILE', 'DEPARTMENT_CHOICE');

-- CreateEnum
CREATE TYPE "ApplicantScope" AS ENUM ('NEW', 'RENEWAL', 'BOTH');

-- CreateEnum
CREATE TYPE "ApplicantType" AS ENUM ('NEW', 'RENEWAL');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('SUBMITTED');

-- CreateTable
CREATE TABLE "RecruitmentCycle" (
    "id" TEXT NOT NULL,
    "track" "RecruitmentTrack" NOT NULL,
    "termId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "CycleStatus" NOT NULL DEFAULT 'DRAFT',
    "publicSlug" TEXT NOT NULL,
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "departments" TEXT[],
    "acceptsRenewals" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitmentCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormSection" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL,
    "departmentCode" TEXT,
    "appliesTo" "ApplicantScope" NOT NULL DEFAULT 'BOTH',

    CONSTRAINT "FormSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormField" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "helpText" TEXT,
    "type" "FieldType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB,
    "validation" JSONB,
    "order" INTEGER NOT NULL,

    CONSTRAINT "FormField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Applicant" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailLower" TEXT NOT NULL,
    "netId" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Applicant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "applicantType" "ApplicantType" NOT NULL DEFAULT 'NEW',
    "departmentChoices" TEXT[],
    "renewalDepartment" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentCycle_publicSlug_key" ON "RecruitmentCycle"("publicSlug");

-- CreateIndex
CREATE INDEX "RecruitmentCycle_status_track_idx" ON "RecruitmentCycle"("status", "track");

-- CreateIndex
CREATE INDEX "FormSection_cycleId_order_idx" ON "FormSection"("cycleId", "order");

-- CreateIndex
CREATE INDEX "FormField_sectionId_order_idx" ON "FormField"("sectionId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "FormField_cycleId_key_key" ON "FormField"("cycleId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Applicant_cycleId_emailLower_key" ON "Applicant"("cycleId", "emailLower");

-- CreateIndex
CREATE INDEX "Application_cycleId_submittedAt_idx" ON "Application"("cycleId", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Application_cycleId_applicantId_key" ON "Application"("cycleId", "applicantId");

-- AddForeignKey
ALTER TABLE "RecruitmentCycle" ADD CONSTRAINT "RecruitmentCycle_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentCycle" ADD CONSTRAINT "RecruitmentCycle_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSection" ADD CONSTRAINT "FormSection_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormField" ADD CONSTRAINT "FormField_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "FormSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormField" ADD CONSTRAINT "FormField_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Applicant" ADD CONSTRAINT "Applicant_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
