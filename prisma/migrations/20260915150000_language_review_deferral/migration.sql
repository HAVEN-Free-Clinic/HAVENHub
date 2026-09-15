-- LanguageReviewDeferral: a reviewer's "review later" on one row of the
-- language review queue. It records no verdict. It only moves the row from the
-- queue tab to the Review later tab until someone assesses it or moves it back.
--
-- A member row points at its PersonLanguage claim. An applicant row names the
-- application and the language, because the applicant half of the queue is
-- derived and has no row of its own to point at. The CHECK holds each row to
-- exactly one of the two shapes; Prisma cannot express it in schema.prisma.

CREATE TABLE "LanguageReviewDeferral" (
    "id" TEXT NOT NULL,
    "personLanguageId" TEXT,
    "applicationId" TEXT,
    "language" TEXT,
    "deferredById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LanguageReviewDeferral_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LanguageReviewDeferral_one_shape" CHECK (
        ("personLanguageId" IS NOT NULL AND "applicationId" IS NULL AND "language" IS NULL)
        OR ("personLanguageId" IS NULL AND "applicationId" IS NOT NULL AND "language" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "LanguageReviewDeferral_personLanguageId_key" ON "LanguageReviewDeferral"("personLanguageId");

CREATE UNIQUE INDEX "LanguageReviewDeferral_applicationId_language_key" ON "LanguageReviewDeferral"("applicationId", "language");

ALTER TABLE "LanguageReviewDeferral" ADD CONSTRAINT "LanguageReviewDeferral_personLanguageId_fkey" FOREIGN KEY ("personLanguageId") REFERENCES "PersonLanguage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LanguageReviewDeferral" ADD CONSTRAINT "LanguageReviewDeferral_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
