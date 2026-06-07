-- CreateEnum
CREATE TYPE "EpicRequestKind" AS ENUM ('NEW', 'MODIFY', 'RENEW');

-- CreateEnum
CREATE TYPE "EpicRequestStatus" AS ENUM ('PENDING', 'SUBMITTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "YnhhTicketStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "OffboardFlag" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "flaggedById" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OffboardFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpicRequest" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "kind" "EpicRequestKind" NOT NULL,
    "status" "EpicRequestStatus" NOT NULL DEFAULT 'PENDING',
    "jobTitle" TEXT,
    "mirrorEpicId" TEXT,
    "notes" TEXT,
    "requestedById" TEXT NOT NULL,
    "ticketId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EpicRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YnhhTicket" (
    "id" TEXT NOT NULL,
    "serviceRequestNumber" TEXT,
    "description" TEXT,
    "status" "YnhhTicketStatus" NOT NULL DEFAULT 'OPEN',
    "submittedById" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "YnhhTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisciplinaryAction" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "issuedById" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "followUpActions" TEXT,
    "policyReference" TEXT,
    "notes" TEXT,
    "confidential" BOOLEAN NOT NULL DEFAULT false,
    "patientInvolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisciplinaryAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "personId" TEXT,
    "triggeredById" TEXT,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OffboardFlag_personId_termId_key" ON "OffboardFlag"("personId", "termId");

-- CreateIndex
CREATE INDEX "EpicRequest_status_idx" ON "EpicRequest"("status");

-- CreateIndex
CREATE INDEX "EpicRequest_personId_idx" ON "EpicRequest"("personId");

-- CreateIndex
CREATE INDEX "DisciplinaryAction_personId_idx" ON "DisciplinaryAction"("personId");

-- CreateIndex
CREATE INDEX "EmailLog_personId_idx" ON "EmailLog"("personId");

-- CreateIndex
CREATE INDEX "EmailLog_status_createdAt_idx" ON "EmailLog"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "OffboardFlag" ADD CONSTRAINT "OffboardFlag_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OffboardFlag" ADD CONSTRAINT "OffboardFlag_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OffboardFlag" ADD CONSTRAINT "OffboardFlag_flaggedById_fkey" FOREIGN KEY ("flaggedById") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpicRequest" ADD CONSTRAINT "EpicRequest_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpicRequest" ADD CONSTRAINT "EpicRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpicRequest" ADD CONSTRAINT "EpicRequest_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "YnhhTicket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YnhhTicket" ADD CONSTRAINT "YnhhTicket_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisciplinaryAction" ADD CONSTRAINT "DisciplinaryAction_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisciplinaryAction" ADD CONSTRAINT "DisciplinaryAction_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
