-- Issue #82: schedule.edit_own_dept is now an enforced member-department grant.
-- It was a no-op on the auto-attached Director system role (nothing read it), and
-- once enforced it would widen directors' edit reach to their non-director
-- memberships. Directors keep their scope via director membership, so drop the
-- stale grant. Inverse of 20260627210000_grant_director_learning_access.
--
-- Idempotent: the DELETE affects zero rows when the grant or the Director role is
-- absent (fresh DB, or already removed). The dev seed (prisma/seed.ts via
-- src/platform/rbac/system-roles.ts) provisions the corrected grant list for new
-- databases.
DELETE FROM "RoleGrant"
USING "Role" r
WHERE "RoleGrant"."roleId" = r."id"
  AND r."name" = 'Director' AND r."isSystem" = true
  AND "RoleGrant"."permission" = 'schedule.edit_own_dept';
