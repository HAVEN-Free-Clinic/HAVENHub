-- Manual include, exclude, and pasted-address lists layered on top of a
-- campaign's condition-matched audience. Written by hand: `prisma migrate dev`
-- folds pre-existing dev-database drift into generated migrations, and
-- String[] defaults are a shape it has gotten wrong in this repo before.

-- People always considered for this campaign regardless of the conditions.
-- Still intersected with the campaign's scope in resolveCampaignAudience: an
-- include is an addition WITHIN the boundary, never a way around it.
ALTER TABLE "EmailCampaign" ADD COLUMN "includePersonIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- People never mailed by this campaign. Applied last, so exclusion beats both
-- the conditions and an explicit include.
ALTER TABLE "EmailCampaign" ADD COLUMN "excludePersonIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Raw addresses pasted by the sender, resolved to people at send time and then
-- subject to exactly the same scope intersection as includePersonIds.
ALTER TABLE "EmailCampaign" ADD COLUMN "pastedEmails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
