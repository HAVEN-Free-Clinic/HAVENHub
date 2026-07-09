/*
  Warnings:

  - You are about to drop the `FCEvent` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Patient` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Referral` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ReferralNote` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ReferralTransition` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "FCEvent" DROP CONSTRAINT "FCEvent_enteredById_fkey";

-- DropForeignKey
ALTER TABLE "FCEvent" DROP CONSTRAINT "FCEvent_patientId_fkey";

-- DropForeignKey
ALTER TABLE "Referral" DROP CONSTRAINT "Referral_assignedDirectorId_fkey";

-- DropForeignKey
ALTER TABLE "Referral" DROP CONSTRAINT "Referral_patientId_fkey";

-- DropForeignKey
ALTER TABLE "Referral" DROP CONSTRAINT "Referral_patientNavigatorId_fkey";

-- DropForeignKey
ALTER TABLE "Referral" DROP CONSTRAINT "Referral_referringDepartmentId_fkey";

-- DropForeignKey
ALTER TABLE "ReferralNote" DROP CONSTRAINT "ReferralNote_authorId_fkey";

-- DropForeignKey
ALTER TABLE "ReferralNote" DROP CONSTRAINT "ReferralNote_referralId_fkey";

-- DropForeignKey
ALTER TABLE "ReferralTransition" DROP CONSTRAINT "ReferralTransition_changedById_fkey";

-- DropForeignKey
ALTER TABLE "ReferralTransition" DROP CONSTRAINT "ReferralTransition_referralId_fkey";

-- DropTable
DROP TABLE "FCEvent";

-- DropTable
DROP TABLE "Patient";

-- DropTable
DROP TABLE "Referral";

-- DropTable
DROP TABLE "ReferralNote";

-- DropTable
DROP TABLE "ReferralTransition";

-- DropEnum
DROP TYPE "FCStatus";

-- DropEnum
DROP TYPE "ReferralPurpose";

-- DropEnum
DROP TYPE "ReferralState";

-- DropEnum
DROP TYPE "ReferralType";

-- DropEnum
DROP TYPE "ReferralUrgency";
