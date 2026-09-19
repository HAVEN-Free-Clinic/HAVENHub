-- Rejecting a HIPAA certificate: a compliance manager refuses a file that is not
-- the certificate (a Workday transcript, someone else's PDF, an unreadable scan)
-- instead of leaving it sitting in the verification queue forever.
--
-- Additive and entirely nullable, so this is safe to run ahead of the code that
-- writes it: an instance still serving the previous build neither reads nor
-- writes these columns, and every existing certificate keeps exactly the status
-- it already had (rejectedAt NULL = never rejected, which is how complianceStatus
-- reads an untouched row).
--
-- No foreign key on rejectedById, matching verifiedById on the same table: the
-- stamp is a historical record of who acted, and it must survive that person's
-- Person row being deleted rather than cascade the certificate away with it.

-- CreateEnum
CREATE TYPE "CertificateRejectionReason" AS ENUM ('NOT_A_CERTIFICATE', 'WRONG_PERSON', 'UNREADABLE', 'OUT_OF_DATE', 'OTHER');

-- AlterTable
ALTER TABLE "HipaaCertificate" ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedById" TEXT,
ADD COLUMN     "rejectionReason" "CertificateRejectionReason",
ADD COLUMN     "rejectionNote" TEXT;
