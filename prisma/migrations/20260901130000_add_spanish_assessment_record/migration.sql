-- The INTP Spanish assessment history: one row per person per term, covering
-- both the imported assessment list (Spring 2012 onward) and new assessments.
--
-- rolling-deploy: a brand-new table. No running code path reads or writes it
-- before this migration lands, so it is safe in either deploy order.
--
-- termRank is the sortable form of the free-text `term` label (year * 10 +
-- season). Ordering on the label itself is wrong: 'Summer 2012' sorts ahead of
-- 'Fall 2026' as text. See platform/languages/assessment-terms.ts.

-- CreateTable
CREATE TABLE "SpanishAssessmentRecord" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "score" INTEGER,
    "modifier" TEXT,
    "notes" TEXT,
    "term" TEXT NOT NULL,
    "termRank" INTEGER NOT NULL DEFAULT 0,
    "personId" TEXT,
    "verified" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpanishAssessmentRecord_pkey" PRIMARY KEY ("id")
);

-- One assessment per person per term. personId is nullable and Postgres treats
-- NULLs as distinct, so imported rows that are not yet linked to a Person do not
-- collide with each other.
-- CreateIndex
CREATE UNIQUE INDEX "SpanishAssessmentRecord_personId_term_key" ON "SpanishAssessmentRecord"("personId", "term");

-- CreateIndex
CREATE INDEX "SpanishAssessmentRecord_personId_termRank_idx" ON "SpanishAssessmentRecord"("personId", "termRank");

-- CreateIndex
CREATE INDEX "SpanishAssessmentRecord_termRank_idx" ON "SpanishAssessmentRecord"("termRank");

-- CreateIndex
CREATE INDEX "SpanishAssessmentRecord_email_idx" ON "SpanishAssessmentRecord"("email");

-- AddForeignKey
ALTER TABLE "SpanishAssessmentRecord" ADD CONSTRAINT "SpanishAssessmentRecord_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
