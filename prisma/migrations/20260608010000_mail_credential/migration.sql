-- CreateTable
CREATE TABLE "MailCredential" (
    "id" TEXT NOT NULL DEFAULT 'mailer',
    "refreshToken" TEXT NOT NULL,
    "account" TEXT,
    "scope" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailCredential_pkey" PRIMARY KEY ("id")
);
