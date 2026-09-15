-- Removes the AI reviewer feature (#893) at the lead's request.
--
-- Forward-only on purpose: 20260914120000_ai_review stays in the history because
-- production has already applied it, and deleting an applied migration would
-- leave Prisma with a record it can no longer match to a file. This drops what
-- that migration created, including the imported FA26 advisory rows; nothing
-- else references the table.
--
-- rolling-deploy: a real but narrow window, accepted rather than split into two
-- releases. The table drops during `prisma migrate deploy`, before `next build`
-- promotes the code that no longer reads it. Until then the serving release
-- still queries AiReview in exactly three places, all recruitment.review_all
-- only: the applicants roster, the applicant detail page, and the speed-route
-- board. Those pages can 500 for recruitment leads for the few minutes of the
-- build. Committee scorers and directors never reach an AiReview query, and no
-- write path touches the table. Roll forward, not back: a rollback to a release
-- carrying #893 would keep those three pages broken for leads.

-- DropForeignKey
ALTER TABLE "AiReview" DROP CONSTRAINT "AiReview_applicationId_fkey";

-- DropTable
DROP TABLE "AiReview";

