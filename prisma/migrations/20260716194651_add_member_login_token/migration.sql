-- Single-use hashed magic-link tokens for non-Yale member hub login.
CREATE TABLE "MemberLoginToken" (
    "id" TEXT NOT NULL,
    "emailLower" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemberLoginToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MemberLoginToken_tokenHash_key" ON "MemberLoginToken"("tokenHash");
CREATE INDEX "MemberLoginToken_emailLower_idx" ON "MemberLoginToken"("emailLower");
CREATE INDEX "MemberLoginToken_personId_idx" ON "MemberLoginToken"("personId");
