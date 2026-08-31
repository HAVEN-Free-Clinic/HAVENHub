/*
 * admin.send_email_campaign becomes outreach.send_unrestricted: same meaning
 * (send with no audience constraint), new module namespace.
 *
 * Platform Admin holds "*" and needs nothing here. Only hand-made custom roles
 * carry the string explicitly.
 *
 * ON CONFLICT DO NOTHING guards the case where a role somehow already holds the
 * new permission, which would otherwise violate RoleGrant's (roleId, permission)
 * unique and abort the deploy.
 */

INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT
  'ogr_' || substr(md5(random()::text || "roleId"), 1, 20),
  "roleId",
  'outreach.send_unrestricted'
FROM "RoleGrant"
WHERE "permission" = 'admin.send_email_campaign'
ON CONFLICT ("roleId", "permission") DO NOTHING;

/* Every sender also needs to reach the module. */
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT
  'oga_' || substr(md5(random()::text || "roleId"), 1, 20),
  "roleId",
  'outreach.access'
FROM "RoleGrant"
WHERE "permission" = 'admin.send_email_campaign'
ON CONFLICT ("roleId", "permission") DO NOTHING;

DELETE FROM "RoleGrant" WHERE "permission" = 'admin.send_email_campaign';
