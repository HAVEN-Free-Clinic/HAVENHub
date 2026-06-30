-- CreateEnum
CREATE TYPE "EmailSenderScope" AS ENUM ('CATEGORY', 'TEMPLATE');

-- AlterTable
ALTER TABLE "EmailLog" ADD COLUMN     "fromEmail" TEXT,
ADD COLUMN     "fromName" TEXT;

-- CreateTable
CREATE TABLE "EmailSenderRule" (
    "id" TEXT NOT NULL,
    "scope" "EmailSenderScope" NOT NULL,
    "target" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSenderRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailSenderRule_scope_target_key" ON "EmailSenderRule"("scope", "target");

-- AddForeignKey
ALTER TABLE "EmailSenderRule" ADD CONSTRAINT "EmailSenderRule_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
