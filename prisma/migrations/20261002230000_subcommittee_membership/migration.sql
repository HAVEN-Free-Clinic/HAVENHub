-- CreateEnum
CREATE TYPE "SubcommitteeRole" AS ENUM ('LEAD', 'MEMBER');

-- CreateEnum
CREATE TYPE "SubcommitteeMembershipSource" AS ENUM ('IMPORT', 'SIGNUP', 'STAFF');

-- AlterTable
ALTER TABLE "Subcommittee" ADD COLUMN     "capacity" INTEGER,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "signupOpen" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SubcommitteeMembership" (
    "id" TEXT NOT NULL,
    "subcommitteeId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" "SubcommitteeRole" NOT NULL DEFAULT 'MEMBER',
    "source" "SubcommitteeMembershipSource" NOT NULL,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubcommitteeMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubcommitteeMembership_personId_idx" ON "SubcommitteeMembership"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "SubcommitteeMembership_subcommitteeId_personId_key" ON "SubcommitteeMembership"("subcommitteeId", "personId");

-- AddForeignKey
ALTER TABLE "SubcommitteeMembership" ADD CONSTRAINT "SubcommitteeMembership_subcommitteeId_fkey" FOREIGN KEY ("subcommitteeId") REFERENCES "Subcommittee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubcommitteeMembership" ADD CONSTRAINT "SubcommitteeMembership_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

