-- CreateTable
CREATE TABLE "ApplicantPortalToken" (
    "id" TEXT NOT NULL,
    "emailLower" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicantPortalToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApplicantPortalToken_tokenHash_key" ON "ApplicantPortalToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApplicantPortalToken_emailLower_idx" ON "ApplicantPortalToken"("emailLower");
