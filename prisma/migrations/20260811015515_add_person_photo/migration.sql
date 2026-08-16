-- AlterTable
ALTER TABLE "Person" ADD COLUMN     "photoKey" TEXT,
ADD COLUMN     "photoSource" TEXT,
ADD COLUMN     "photoSuppressed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "photoSyncMisses" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "photoSyncedAt" TIMESTAMP(3),
ADD COLUMN     "photoUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "photoVersion" INTEGER NOT NULL DEFAULT 0;
