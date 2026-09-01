/*
  Warnings:

  - A unique constraint covering the columns `[email,term]` on the table `SpanishAssessmentRecord` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "SpanishAssessmentRecord_email_term_key" ON "SpanishAssessmentRecord"("email", "term");
