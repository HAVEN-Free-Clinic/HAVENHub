-- Swap-only clinical departments, confirmed with ops 2026-08-26.
--
-- The clinical team-member departments always need a named person to take the
-- shift, so their members must swap rather than drop. A member who cannot find
-- a swap partner emails their directors (the CAs for SCTP/JCTP, the RHD team
-- for SCTS/JCTS) and the drop is handled out of band.
--
-- Modelled as a per-department flag rather than a hardcoded code list because
-- departments are admin-maintained -- the same reasoning as
-- Department.autoRouteApplicants, and it keeps the setting editable at
-- /admin/departments/[id] without a deploy.
--
-- The column defaults to TRUE (drops allowed, today's behaviour), so this is a
-- no-op for every department except the five backfilled below. Rolling deploy:
-- adding a nullable-in-effect column with a default is additive, and the
-- serving release simply never reads it.

ALTER TABLE "Department" ADD COLUMN "allowShiftDrop" BOOLEAN NOT NULL DEFAULT true;

-- Backfill for the departments that already exist in production. Scoped by
-- code, so re-running is a no-op and a fresh DB seeded from
-- prisma/department-catalog.ts (which carries the same five) lands identically.
UPDATE "Department"
SET "allowShiftDrop" = false
WHERE "code" IN ('SCTP', 'JCTP', 'SCTS', 'JCTS', 'SCTL');
