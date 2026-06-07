-- CreateTable
CREATE TABLE "HipaaCertificate" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HipaaCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HipaaCertificate_personId_uploadedAt_idx" ON "HipaaCertificate"("personId", "uploadedAt");

-- AddForeignKey
ALTER TABLE "HipaaCertificate" ADD CONSTRAINT "HipaaCertificate_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
