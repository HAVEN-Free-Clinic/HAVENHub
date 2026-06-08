-- CreateTable
CREATE TABLE "ComplianceReminder" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "lastRemindedAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "escalatedAt" TIMESTAMP(3),

    CONSTRAINT "ComplianceReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceReminder_personId_key" ON "ComplianceReminder"("personId");

-- AddForeignKey
ALTER TABLE "ComplianceReminder" ADD CONSTRAINT "ComplianceReminder_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
