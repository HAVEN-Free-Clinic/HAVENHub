-- CreateEnum
CREATE TYPE "CertificateExtraction" AS ENUM ('PARSED', 'MANUAL', 'AIRTABLE', 'NONE');

-- AlterTable
ALTER TABLE "HipaaCertificate" ADD COLUMN     "completionDate" TIMESTAMP(3),
ADD COLUMN     "extraction" "CertificateExtraction" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedById" TEXT;
