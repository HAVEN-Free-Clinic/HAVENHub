-- CreateTable
CREATE TABLE "Subcommittee" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subcommittee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Subcommittee_isActive_order_idx" ON "Subcommittee"("isActive", "order");

-- AlterEnum
ALTER TYPE "FieldType" ADD VALUE 'SUBCOMMITTEE_RANK';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "subcommitteeRanking" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "assignedSubcommitteeId" TEXT,
ADD COLUMN     "assignedSubcommitteeById" TEXT,
ADD COLUMN     "assignedSubcommitteeAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Training" DROP COLUMN "subcommitteeInterest";

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_assignedSubcommitteeId_fkey" FOREIGN KEY ("assignedSubcommitteeId") REFERENCES "Subcommittee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_assignedSubcommitteeById_fkey" FOREIGN KEY ("assignedSubcommitteeById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
