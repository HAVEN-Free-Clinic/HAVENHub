-- CreateEnum
CREATE TYPE "TeamsMessageStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'FALLBACK');

-- CreateTable
CREATE TABLE "TeamsMessage" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "link" TEXT,
    "bodyHtml" TEXT NOT NULL,
    "chatId" TEXT,
    "fallbackSubject" TEXT NOT NULL,
    "fallbackHtml" TEXT NOT NULL,
    "status" "TeamsMessageStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeamsMessage_personId_idx" ON "TeamsMessage"("personId");

-- CreateIndex
CREATE INDEX "TeamsMessage_status_createdAt_idx" ON "TeamsMessage"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "TeamsMessage" ADD CONSTRAINT "TeamsMessage_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
