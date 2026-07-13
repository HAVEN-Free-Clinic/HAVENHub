-- CreateTable
CREATE TABLE "TermOnboardingStep" (
    "id" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT,
    "description" TEXT,
    "blocking" BOOLEAN,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TermOnboardingStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TermOnboardingStep_termId_idx" ON "TermOnboardingStep"("termId");

-- CreateIndex
CREATE UNIQUE INDEX "TermOnboardingStep_termId_kind_key" ON "TermOnboardingStep"("termId", "kind");

-- AddForeignKey
ALTER TABLE "TermOnboardingStep" ADD CONSTRAINT "TermOnboardingStep_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE CASCADE ON UPDATE CASCADE;
