-- All nullable on purpose. Every one of these is genuinely absent in local
-- development (there is no Vercel edge in `next dev`), and a person who has not
-- signed in since this shipped has no value rather than a misleading default.
ALTER TABLE "Person" ADD COLUMN "lastLoginAt" TIMESTAMP(3);
ALTER TABLE "Person" ADD COLUMN "lastLoginUserAgent" TEXT;
ALTER TABLE "Person" ADD COLUMN "lastLoginCity" TEXT;
ALTER TABLE "Person" ADD COLUMN "lastLoginCountry" TEXT;
