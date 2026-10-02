-- CreateEnum
CREATE TYPE "FormStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "FormResponseSource" AS ENUM ('HUB', 'AIRTABLE');

-- CreateTable
CREATE TABLE "Form" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "FormStatus" NOT NULL DEFAULT 'DRAFT',
    "layout" JSONB NOT NULL,
    "layoutVersion" INTEGER NOT NULL DEFAULT 0,
    "openToAnyone" BOOLEAN NOT NULL DEFAULT false,
    "allowEdits" BOOLEAN NOT NULL DEFAULT true,
    "closesAt" TIMESTAMP(3),
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Form_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormAssignment" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remindedAt" TIMESTAMP(3),

    CONSTRAINT "FormAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormResponse" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "personId" TEXT,
    "answers" JSONB NOT NULL,
    "layoutSnapshot" JSONB NOT NULL,
    "source" "FormResponseSource" NOT NULL DEFAULT 'HUB',
    "importedName" TEXT,
    "externalId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Form_status_idx" ON "Form"("status");

-- CreateIndex
CREATE INDEX "FormAssignment_personId_idx" ON "FormAssignment"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "FormAssignment_formId_personId_key" ON "FormAssignment"("formId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "FormResponse_externalId_key" ON "FormResponse"("externalId");

-- CreateIndex
CREATE INDEX "FormResponse_formId_submittedAt_idx" ON "FormResponse"("formId", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FormResponse_formId_personId_key" ON "FormResponse"("formId", "personId");

-- AddForeignKey
ALTER TABLE "Form" ADD CONSTRAINT "Form_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Form" ADD CONSTRAINT "Form_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormAssignment" ADD CONSTRAINT "FormAssignment_formId_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormAssignment" ADD CONSTRAINT "FormAssignment_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormResponse" ADD CONSTRAINT "FormResponse_formId_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormResponse" ADD CONSTRAINT "FormResponse_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

