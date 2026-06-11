/*
  Warnings:

  - You are about to drop the `CourseModule` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `CourseQuizAttempt` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModuleProgress` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "CourseModule" DROP CONSTRAINT "CourseModule_courseId_fkey";

-- DropForeignKey
ALTER TABLE "CourseQuizAttempt" DROP CONSTRAINT "CourseQuizAttempt_moduleProgressId_fkey";

-- DropForeignKey
ALTER TABLE "ModuleProgress" DROP CONSTRAINT "ModuleProgress_moduleId_fkey";

-- DropForeignKey
ALTER TABLE "ModuleProgress" DROP CONSTRAINT "ModuleProgress_personId_fkey";

-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "scormEntryHref" TEXT,
ADD COLUMN     "scormUploadedAt" TIMESTAMP(3),
ADD COLUMN     "scormVersion" TEXT;

-- AlterTable
ALTER TABLE "CourseProgress" ADD COLUMN     "lessonLocation" TEXT,
ADD COLUMN     "lessonStatus" TEXT,
ADD COLUMN     "scoreRaw" INTEGER,
ADD COLUMN     "suspendData" TEXT;

-- DropTable
DROP TABLE "CourseModule";

-- DropTable
DROP TABLE "CourseQuizAttempt";

-- DropTable
DROP TABLE "ModuleProgress";

-- DropEnum
DROP TYPE "CourseModuleKind";
