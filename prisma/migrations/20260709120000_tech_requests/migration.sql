-- CreateEnum
CREATE TYPE "TechRequestCategory" AS ENUM ('EPIC', 'DUO_MFA', 'GENERAL_IT', 'TEAMS', 'OTHER');

-- CreateEnum
CREATE TYPE "TechRequestPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TechRequestStatus" AS ENUM ('SUBMITTED', 'IN_PROGRESS', 'AWAITING_REQUESTER', 'AWAITING_YNHH', 'RESOLVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CommentVisibility" AS ENUM ('PUBLIC', 'INTERNAL');

-- CreateTable
CREATE TABLE "TechRequest" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "requesterId" TEXT NOT NULL,
    "category" "TechRequestCategory" NOT NULL,
    "epicSubtype" "EpicRequestKind",
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "TechRequestPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "TechRequestStatus" NOT NULL DEFAULT 'SUBMITTED',
    "assignedToId" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "epicRequestId" TEXT,
    "epicJobTitle" TEXT,
    "epicMirrorId" TEXT,
    "epicStartDate" TIMESTAMP(3),
    "epicEndDate" TIMESTAMP(3),
    "worksAtYnhh" BOOLEAN,
    "govId" TEXT,
    "netId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TechRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechRequestComment" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" "CommentVisibility" NOT NULL DEFAULT 'PUBLIC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechRequestComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechRequestAttachment" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "commentId" TEXT,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechRequestAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TechRequest_number_key" ON "TechRequest"("number");

-- CreateIndex
CREATE UNIQUE INDEX "TechRequest_epicRequestId_key" ON "TechRequest"("epicRequestId");

-- CreateIndex
CREATE INDEX "TechRequest_status_idx" ON "TechRequest"("status");

-- CreateIndex
CREATE INDEX "TechRequest_requesterId_idx" ON "TechRequest"("requesterId");

-- CreateIndex
CREATE INDEX "TechRequest_assignedToId_idx" ON "TechRequest"("assignedToId");

-- CreateIndex
CREATE INDEX "TechRequestComment_requestId_idx" ON "TechRequestComment"("requestId");

-- CreateIndex
CREATE INDEX "TechRequestAttachment_requestId_idx" ON "TechRequestAttachment"("requestId");

-- CreateIndex
CREATE INDEX "TechRequestAttachment_commentId_idx" ON "TechRequestAttachment"("commentId");

-- AddForeignKey
ALTER TABLE "TechRequest" ADD CONSTRAINT "TechRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechRequest" ADD CONSTRAINT "TechRequest_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechRequest" ADD CONSTRAINT "TechRequest_epicRequestId_fkey" FOREIGN KEY ("epicRequestId") REFERENCES "EpicRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechRequestComment" ADD CONSTRAINT "TechRequestComment_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "TechRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechRequestComment" ADD CONSTRAINT "TechRequestComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechRequestAttachment" ADD CONSTRAINT "TechRequestAttachment_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "TechRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechRequestAttachment" ADD CONSTRAINT "TechRequestAttachment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "TechRequestComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechRequestAttachment" ADD CONSTRAINT "TechRequestAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

