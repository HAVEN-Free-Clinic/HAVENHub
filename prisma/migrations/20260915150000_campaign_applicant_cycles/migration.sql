-- Recruitment cycles whose applicants a campaign also emails, at the address
-- each applied with, whether or not they have a HAVEN Hub account. Written by
-- hand, like the manual-lists migration before it: `prisma migrate dev` folds
-- pre-existing dev-database drift into generated migrations.
--
-- Honoured only on an unscoped campaign. An applicant with no Person cannot be
-- tested against a scope, so resolveCampaignAudience ignores this column on a
-- scoped campaign rather than let it route around the boundary.
ALTER TABLE "EmailCampaign" ADD COLUMN "applicantCycleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
