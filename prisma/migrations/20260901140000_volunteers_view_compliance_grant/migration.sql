-- Split the clinic-wide compliance READ out of volunteers.manage_compliance
-- into volunteers.view_compliance, and give it to every role that already holds
-- the manage half.
--
-- The split is enforced in code by canViewAllCompliance
-- (src/platform/compliance/access.ts), which admits EITHER permission on every
-- read surface. So no existing holder depends on this migration to keep working
-- -- it exists so the Roles screen states what a role can actually do, and so a
-- later tightening of a read site to view_compliance alone cannot silently lock
-- out a manager. Mirrors src/platform/rbac/system-roles.ts, which provisions the
-- same grant for fresh databases via the seed (which never runs in production).
--
-- Deliberately keyed off "whoever holds manage_compliance" rather than naming
-- the Compliance Manager role: the Roles screen lets an admin compose their own
-- role carrying that permission, and such a role must not come out of this
-- migration able to verify a certificate it cannot open. This is the same shape
-- as step 2 of 20260709120500_incidents_permission_backfill.
--
-- Idempotent: RoleGrant has a real unique index
-- (RoleGrant_roleId_permission_key), so ON CONFLICT DO NOTHING is safe.
--
-- Platform Admin already holds "*" and needs no row.
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, rg."roleId", 'volunteers.view_compliance'
FROM "RoleGrant" rg
WHERE rg."permission" = 'volunteers.manage_compliance'
ON CONFLICT ("roleId", "permission") DO NOTHING;
