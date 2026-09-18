-- Department.maxVolunteersPerShift: the ceiling on how many volunteers may be
-- staffed on one clinic date.
--
-- Separate from idealHeadcount, which is only a target the capacity panel reads:
-- this one is enforced on every write, so a hand-placed assignment cannot walk
-- past a cap the generator respects.
--
-- The UPDATE is load-bearing, for the same reason as the backfill in
-- 20260914120000_department_spanish_regardless_of_claim: prisma/seed.ts upserts
-- departments with `update: { name, isActive }` only, and Vercel runs
-- `prisma migrate deploy`, never the seed. Without it INTP ships uncapped and
-- the cap ops actually asked for would silently do nothing in production.
--
-- rolling-deploy: a nullable column plus one row update. An old instance neither
-- reads nor writes it, and every other department stays uncapped exactly as before.

ALTER TABLE "Department" ADD COLUMN "maxVolunteersPerShift" INTEGER;

-- Idempotent: a re-run sets the same row to the same value.
UPDATE "Department" SET "maxVolunteersPerShift" = 20 WHERE "code" = 'INTP';
