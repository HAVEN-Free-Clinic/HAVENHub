-- Sender identity, Phase 3 Task 2: WHO may send as WHAT.
--
-- SendingIdentity is the per-person issued address. Uniqueness is
-- (personId, address) and NOT address alone, because a shared mailbox such as
-- recruitment@havenfreeclinic.org is deliberately issuable to several people.
-- The application lowercases `address` before writing, which is what makes the
-- pair constraint case-insensitive WITHOUT an expression index -- a raw-SQL
-- index of that kind is invisible to the Prisma schema and a later
-- `prisma migrate diff` proposes DROPping it.
--
-- Revocation is a flip of revokedAt on the SAME row, never a second row, which
-- is what lets the pair stay unique across a revoke-then-reissue.
--
-- EmailCampaign.fromEmail stores the CHOSEN identity as an address rather than a
-- foreign key: the same address can arrive from the scope, from an issued row,
-- or from the sender's own contactEmail, and the choice has to survive the
-- issued row being revoked (the run then re-resolves down the order).
-- EmailCampaign.fromEmailSetById records WHO made that choice, because the
-- enqueue-time re-check has to run against the chooser's claims and a campaign in
-- a shared scope can be created by one person and composed by another.
--
-- Generated with `prisma migrate diff --from-migrations`, not `migrate dev`, so
-- no pre-existing drift is folded in. The one thing that diff DID surface was a
-- `DROP INDEX "EmailCampaign_scopeId_idx"`: that index is created by migration
-- 20260831120000 but was never declared on the model, so every diff since Phase 1
-- has wanted to drop it. Fixed at the source by adding @@index([scopeId]) to the
-- model instead of trimming the DROP out of this file, so the drift is gone
-- rather than deferred. No DDL for it appears here, and none should.

-- AlterTable
ALTER TABLE "EmailCampaign" ADD COLUMN     "fromEmail" TEXT,
ADD COLUMN     "fromEmailSetById" TEXT;

-- AddForeignKey
ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_fromEmailSetById_fkey" FOREIGN KEY ("fromEmailSetById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "SendingIdentity" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "displayName" TEXT,
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "SendingIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SendingIdentity_personId_idx" ON "SendingIdentity"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "SendingIdentity_personId_address_key" ON "SendingIdentity"("personId", "address");

-- AddForeignKey
ALTER TABLE "SendingIdentity" ADD CONSTRAINT "SendingIdentity_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendingIdentity" ADD CONSTRAINT "SendingIdentity_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendingIdentity" ADD CONSTRAINT "SendingIdentity_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
