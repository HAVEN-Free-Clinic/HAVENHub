/*
  Warnings:

  - Added the required column `updatedAt` to the `Department` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Term` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `TermMembership` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "RoleAssignment" DROP CONSTRAINT "RoleAssignment_departmentId_fkey";

-- DropForeignKey
ALTER TABLE "RoleAssignment" DROP CONSTRAINT "RoleAssignment_personId_fkey";

-- DropForeignKey
ALTER TABLE "RoleAssignment" DROP CONSTRAINT "RoleAssignment_termId_fkey";

-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "Term" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "TermMembership" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "AuditLog_actorPersonId_idx" ON "AuditLog"("actorPersonId");

-- CreateIndex
CREATE INDEX "RoleAssignment_termId_idx" ON "RoleAssignment"("termId");

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Case-insensitive uniqueness: prevents case-variant duplicate people that would
-- break login matching and the Airtable importer. (App queries use mode:"insensitive".)
CREATE UNIQUE INDEX "Person_netId_lower_key" ON "Person" (LOWER("netId")) WHERE "netId" IS NOT NULL;
CREATE UNIQUE INDEX "Person_contactEmail_lower_key" ON "Person" (LOWER("contactEmail")) WHERE "contactEmail" IS NOT NULL;
CREATE UNIQUE INDEX "Person_yaleEmail_lower_key" ON "Person" (LOWER("yaleEmail")) WHERE "yaleEmail" IS NOT NULL;

-- Exactly one of personId/departmentId per assignment (DB-enforced, not just convention).
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_target_xor"
  CHECK (("personId" IS NOT NULL AND "departmentId" IS NULL) OR ("personId" IS NULL AND "departmentId" IS NOT NULL));

-- No duplicate grants (PG16 NULLS NOT DISTINCT treats NULL termId as equal).
CREATE UNIQUE INDEX "RoleAssignment_unique_grant" ON "RoleAssignment" ("roleId", "personId", "departmentId", "termId") NULLS NOT DISTINCT;
