-- Data heal (issue #67): before offboarding converged on removing memberships,
-- the admin people page flipped Person.status to OFFBOARDED without ending the
-- person's TermMemberships. Those people still carry ACTIVE memberships, so they
-- keep showing up as current members in the compliance, disciplinary, and
-- offboarding rosters (which all key off TermMembership.status, not
-- Person.status). End those memberships so existing data matches the invariant
-- "OFFBOARDED => no ACTIVE memberships". Idempotent: only ACTIVE rows are touched.
UPDATE "TermMembership" tm
SET "status" = 'REMOVED'
FROM "Person" p
WHERE tm."personId" = p."id"
  AND p."status" = 'OFFBOARDED'
  AND tm."status" = 'ACTIVE';
