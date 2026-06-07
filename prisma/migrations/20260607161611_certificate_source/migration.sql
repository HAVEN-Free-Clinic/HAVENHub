-- CreateEnum
CREATE TYPE "CertificateSource" AS ENUM ('UPLOAD', 'IMPORT');

-- AlterTable
ALTER TABLE "HipaaCertificate" ADD COLUMN     "source" "CertificateSource" NOT NULL DEFAULT 'UPLOAD';
