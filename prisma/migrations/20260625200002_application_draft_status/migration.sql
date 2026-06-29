-- AlterTable: submittedAt becomes nullable with no default
ALTER TABLE "Application" ALTER COLUMN "submittedAt" DROP DEFAULT;
ALTER TABLE "Application" ALTER COLUMN "submittedAt" DROP NOT NULL;
