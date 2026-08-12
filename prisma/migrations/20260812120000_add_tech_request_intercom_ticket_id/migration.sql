-- Adds TechRequest.intercomTicketId, the second (and distinct) Intercom link
-- alongside intercomConversationId: the conversation resolves identity and
-- receives internal notes, while the ticket id carries state and the "Hub
-- ticket number" attribute (see docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md,
-- Direction 1's 2026-08-12 revision).
--
-- Trimmed by hand, same as 20260812020028_add_haven_hub_tech_request_category:
-- `prisma migrate diff` against the live test database also surfaced
-- pre-existing drift (the same Training constraint/FK renames left over from
-- the VolunteerTraining rename, and the same Application.subcommitteeRanking
-- default drop) that a prior migration already deliberately trimmed out.
-- Neither belongs to this change, so it is excluded here again rather than
-- re-attributed to a ticket-id column addition.
ALTER TABLE "TechRequest" ADD COLUMN "intercomTicketId" TEXT;

CREATE UNIQUE INDEX "TechRequest_intercomTicketId_key" ON "TechRequest"("intercomTicketId");
