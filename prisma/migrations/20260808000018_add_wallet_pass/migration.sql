-- CreateTable
CREATE TABLE "WalletPass" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "WalletPass_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletPass_serialNumber_key" ON "WalletPass"("serialNumber");

-- CreateIndex
CREATE INDEX "WalletPass_personId_idx" ON "WalletPass"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletPass_personId_termId_key" ON "WalletPass"("personId", "termId");

-- AddForeignKey
ALTER TABLE "WalletPass" ADD CONSTRAINT "WalletPass_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletPass" ADD CONSTRAINT "WalletPass_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
