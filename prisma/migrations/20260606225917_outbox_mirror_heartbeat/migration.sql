-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- DropIndex
DROP INDEX "RoleAssignment_unique_grant";

-- CreateTable
CREATE TABLE "Outbox" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "changedFields" TEXT[],
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MirrorRecord" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "baseId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,

    CONSTRAINT "MirrorRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "beatAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Outbox_status_createdAt_idx" ON "Outbox"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MirrorRecord_entityType_entityId_baseId_key" ON "MirrorRecord"("entityType", "entityId", "baseId");
