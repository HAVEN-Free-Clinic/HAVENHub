-- CreateTable
CREATE TABLE "SpanishAssessmentRecord" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "score" INTEGER,
    "modifier" TEXT,
    "notes" TEXT,
    "term" TEXT NOT NULL,
    "personId" TEXT,
    "verified" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpanishAssessmentRecord_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "SpanishAssessmentRecord" ADD CONSTRAINT "SpanishAssessmentRecord_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
