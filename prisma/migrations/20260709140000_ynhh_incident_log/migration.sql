-- AlterTable
ALTER TABLE "YnhhTicket" ADD COLUMN     "personId" TEXT,
ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "subject" TEXT;

-- AlterTable
ALTER TABLE "TechRequestAttachment" ADD COLUMN     "ynhhTicketId" TEXT;

-- CreateIndex
CREATE INDEX "TechRequestAttachment_ynhhTicketId_idx" ON "TechRequestAttachment"("ynhhTicketId");

-- AddForeignKey
ALTER TABLE "YnhhTicket" ADD CONSTRAINT "YnhhTicket_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechRequestAttachment" ADD CONSTRAINT "TechRequestAttachment_ynhhTicketId_fkey" FOREIGN KEY ("ynhhTicketId") REFERENCES "YnhhTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

