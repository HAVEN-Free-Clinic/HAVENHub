-- Dual-role fallback: a rejection no longer ends an application whose applicant
-- ticked a VADM or INTP dual box. It passes to that department instead (VADM
-- first, then INTP), still undecided, and the rejection only stands once every
-- ticked department has said no. See nextDualFallback in
-- src/platform/dual-roles/catalog.ts.
--
-- No backfill. A rejection recorded before this column existed stays a
-- rejection; the one-off can be routed by hand.

-- AlterTable
-- dualRoleDeclinedBy: the dual departments that have rejected this applicant,
-- so the fallback never loops back to one and promotion never offers the person
-- to a department that already said no. Same list shape and default as
-- "dualRoleDepartments" beside it.
--
-- dualFallbackAt / dualFallbackFromDepartmentCode: set while the application
-- sits with a dual department because of a fallback, and where that fallback
-- started. A null department with a set timestamp means the recruitment lead
-- rejected it before routing. Cleared when the lead routes the application
-- somewhere else.
ALTER TABLE "Application"
  ADD COLUMN "dualRoleDeclinedBy" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "dualFallbackAt" TIMESTAMP(3),
  ADD COLUMN "dualFallbackFromDepartmentCode" TEXT;
