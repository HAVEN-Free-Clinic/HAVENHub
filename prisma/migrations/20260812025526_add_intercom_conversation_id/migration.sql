-- Adds the join key between a TechRequest and the Intercom conversation it was
-- opened from, when it came in through support chat rather than the Hub form.
-- Unique: a conversation maps to at most one ticket, which is what makes the
-- create path idempotent under Intercom retries.
--
-- Trimmed by hand: `prisma migrate dev` also folded in pre-existing drift
-- between the shadow database and the schema (Training constraint renames left
-- over from the VolunteerTraining rename, and an Application.subcommitteeRanking
-- default drop). Neither belongs to this change, and shipping them here would
-- attribute unrelated schema history to an Intercom join-key addition.
-- AlterTable
ALTER TABLE "TechRequest" ADD COLUMN     "intercomConversationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TechRequest_intercomConversationId_key" ON "TechRequest"("intercomConversationId");
