-- Sender identity, Phase 3 Task 3: make an issued address assignable BY ROLE.
--
-- SendingIdentity carried `personId` directly and was unique on
-- (personId, address), so one shared mailbox issued to four people was four
-- rows. This splits the address from its holders exactly the way
-- AudienceScope / AudienceScopeGrant already do it, so a grant can name a ROLE
-- and everyone holding that role gains the address (and loses it) with no
-- per-person row to maintain.
--
-- A NEW MIGRATION, NOT AN EDIT OF 20260902140000. That one is applied to the
-- shared test template and to the dev databases, and PR #712 is open, so a
-- preview database may already carry it. Prisma checksums applied migrations:
-- rewriting, squashing or renaming it produces P3018 / 42P07 there. The cost is
-- that this file undoes structure the previous one created, which is the correct
-- trade.
--
-- THE THREE DECISIONS THIS FILE ENCODES:
--
--   UNIQUENESS moves. The address becomes globally unique (one row per address);
--   the property the old pair carried -- a shared mailbox is deliberately usable
--   by several people -- moves to SendingIdentityGrant's COALESCE unique index,
--   which stops the SAME holder being granted the SAME address twice. The
--   application lowercases `address` before writing, which is what keeps both
--   constraints case-insensitive WITHOUT an expression index; a raw-SQL index of
--   that kind is invisible to the Prisma schema and a later `migrate diff`
--   proposes DROPping it.
--
--   REVOCATION stays a flip, and stays on the ADDRESS. revokedAt now means "this
--   address is retired", which is the only revocation with an auditable trail in
--   the schema, and it is the single choke point every route to the address
--   passes through -- so a revoked identity cannot resolve through any grant,
--   direct or role, and a grant added later cannot silently resurrect it. Losing
--   ONE holder is the different event and is a DELETE of that grant, trailed in
--   the audit log the way revokeScope already does it. A revokedAt on the grant
--   instead would collide with the re-grant under the unique index below, and
--   would add a second nullable filter that a read could forget -- which is the
--   ServiceCredential bug this feature has been avoiding all along.
--
--   EXISTING ROWS carry across, with revocation resolved in the SAFE direction:
--   a revoked per-person row becomes NO GRANT (that person loses the address),
--   never an active one. An address every one of whose rows was revoked ends up
--   retired, carrying the LATEST revocation. Production has no rows (the feature
--   is unmerged) but the dev databases and the test template do.

-- ---------------------------------------------------------------------------
-- 1. The grant table. Created BEFORE the old columns are dropped: the backfill
--    below reads SendingIdentity."personId".
-- ---------------------------------------------------------------------------

CREATE TABLE "SendingIdentityGrant" (
    "id"          TEXT NOT NULL,
    "identityId"  TEXT NOT NULL,
    "personId"    TEXT,
    "roleId"      TEXT,
    "grantedById" TEXT,
    "grantedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SendingIdentityGrant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SendingIdentityGrant_identityId_idx" ON "SendingIdentityGrant"("identityId");
CREATE INDEX "SendingIdentityGrant_personId_idx"   ON "SendingIdentityGrant"("personId");
CREATE INDEX "SendingIdentityGrant_roleId_idx"     ON "SendingIdentityGrant"("roleId");

ALTER TABLE "SendingIdentityGrant" ADD CONSTRAINT "SendingIdentityGrant_identityId_fkey"
  FOREIGN KEY ("identityId") REFERENCES "SendingIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SendingIdentityGrant" ADD CONSTRAINT "SendingIdentityGrant_personId_fkey"
  FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SendingIdentityGrant" ADD CONSTRAINT "SendingIdentityGrant_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SendingIdentityGrant" ADD CONSTRAINT "SendingIdentityGrant_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Choose the surviving row per address, and back the grants off it.
--
--    Survivor = the earliest (issuedAt, id) for the address, which is genuinely
--    "who first minted this address" and therefore the right row to carry
--    createdAt / createdById. `id` breaks the tie so the choice is deterministic
--    rather than dependent on physical row order.
-- ---------------------------------------------------------------------------

CREATE TEMPORARY TABLE "_si_survivor" AS
SELECT DISTINCT ON (LOWER("address"))
  "id"                     AS "survivorId",
  LOWER("address")         AS "addressKey"
FROM "SendingIdentity"
ORDER BY LOWER("address"), "issuedAt", "id";

-- One grant per row that was still ACTIVE. A revoked row deliberately produces
-- nothing: the migration must not be the thing that hands anybody back an
-- address an admin took away.
INSERT INTO "SendingIdentityGrant" ("id", "identityId", "personId", "roleId", "grantedById", "grantedAt")
SELECT
  gen_random_uuid()::text,
  s."survivorId",
  si."personId",
  NULL,
  si."issuedById",
  si."issuedAt"
FROM "SendingIdentity" si
JOIN "_si_survivor" s ON s."addressKey" = LOWER(si."address")
WHERE si."revokedAt" IS NULL;

-- The surviving row's display name: prefer one an ACTIVE holder was showing,
-- since that is the From recipients have actually been seeing, and fall back to
-- whatever the survivor already carries.
UPDATE "SendingIdentity" tgt
SET "displayName" = live."displayName"
FROM "_si_survivor" s
JOIN LATERAL (
  SELECT si."displayName"
  FROM "SendingIdentity" si
  WHERE LOWER(si."address") = s."addressKey"
    AND si."revokedAt" IS NULL
    AND si."displayName" IS NOT NULL
  ORDER BY si."issuedAt", si."id"
  LIMIT 1
) live ON TRUE
WHERE tgt."id" = s."survivorId"
  AND tgt."displayName" IS DISTINCT FROM live."displayName";

-- An address whose every row was revoked is a RETIRED address, and it carries
-- the LATEST revocation: the address stopped being live when its last holder
-- lost it. An address with any active row is left alone, so the survivor's
-- revokedAt stays whatever it was -- which is why it is cleared explicitly here
-- rather than assumed: the survivor is chosen by issue date, so it can itself be
-- a revoked row sitting alongside a live one.
UPDATE "SendingIdentity" tgt
SET "revokedAt"   = agg."lastRevokedAt",
    "revokedById" = agg."lastRevokedById"
FROM "_si_survivor" s
JOIN LATERAL (
  SELECT
    bool_or(si."revokedAt" IS NULL)                                    AS "anyActive",
    (ARRAY_AGG(si."revokedAt"   ORDER BY si."revokedAt" DESC NULLS LAST))[1] AS "lastRevokedAt",
    (ARRAY_AGG(si."revokedById" ORDER BY si."revokedAt" DESC NULLS LAST))[1] AS "lastRevokedById"
  FROM "SendingIdentity" si
  WHERE LOWER(si."address") = s."addressKey"
) agg ON TRUE
WHERE tgt."id" = s."survivorId"
  AND NOT agg."anyActive";

UPDATE "SendingIdentity" tgt
SET "revokedAt" = NULL, "revokedById" = NULL
FROM "_si_survivor" s
WHERE tgt."id" = s."survivorId"
  AND EXISTS (
    SELECT 1 FROM "SendingIdentity" si
    WHERE LOWER(si."address") = s."addressKey" AND si."revokedAt" IS NULL
  );

-- Collapse. The grants above already point at the survivor, so the duplicates
-- carry nothing that is not preserved.
DELETE FROM "SendingIdentity" si
WHERE si."id" NOT IN (SELECT "survivorId" FROM "_si_survivor");

-- Normalize the surviving address. Every write path has lowercased it since Task
-- 2, but the unique index added below is a plain one, so a row written before
-- that (or by hand) would be a second identity for the same mailbox.
UPDATE "SendingIdentity" SET "address" = LOWER("address") WHERE "address" <> LOWER("address");

DROP TABLE "_si_survivor";

-- ---------------------------------------------------------------------------
-- 3. Reshape SendingIdentity itself.
--
--    issuedAt / issuedById are RENAMED rather than dropped and re-added, which
--    is the one place this file deviates from what `migrate diff` emitted: the
--    generated DROP + ADD produces the same structure but throws the values
--    away, and "who minted this address, and when" is exactly the audit fact the
--    admin screen shows. The FK is dropped and re-added so its NAME matches the
--    column, which Postgres does not do on a rename (the same trap
--    20260901150000_rename_training_constraints exists to clean up).
-- ---------------------------------------------------------------------------

ALTER TABLE "SendingIdentity" DROP CONSTRAINT "SendingIdentity_issuedById_fkey";
ALTER TABLE "SendingIdentity" DROP CONSTRAINT "SendingIdentity_personId_fkey";

DROP INDEX "SendingIdentity_personId_address_key";
DROP INDEX "SendingIdentity_personId_idx";

ALTER TABLE "SendingIdentity" RENAME COLUMN "issuedAt"   TO "createdAt";
ALTER TABLE "SendingIdentity" RENAME COLUMN "issuedById" TO "createdById";
ALTER TABLE "SendingIdentity" DROP COLUMN "personId";

ALTER TABLE "SendingIdentity" ADD CONSTRAINT "SendingIdentity_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "SendingIdentity_address_key" ON "SendingIdentity"("address");

-- ---------------------------------------------------------------------------
-- 4. The two db-level guards Prisma cannot model. Both mirror
--    AudienceScopeGrant's (migration 20260831120000) and are asserted by
--    src/platform/rbac/schema-guards.test.ts, because a later `migrate diff` is
--    blind to them and will propose DROPping both with no visible change to
--    schema.prisma at all.
-- ---------------------------------------------------------------------------

-- Exactly one target. A grant attached to neither reaches nobody but still makes
-- the address look held; one attached to both is two claims in one row.
ALTER TABLE "SendingIdentityGrant" ADD CONSTRAINT "SendingIdentityGrant_target_xor"
  CHECK ((("personId" IS NOT NULL)::int + ("roleId" IS NOT NULL)::int) = 1);

-- Duplicate-grant guard. A plain multi-column unique treats NULLs as distinct,
-- so (identity, person, NULL) could be inserted twice. COALESCE to '' the way
-- AudienceScopeGrant_unique_grant and RoleAssignment_unique_grant do.
CREATE UNIQUE INDEX "SendingIdentityGrant_unique_grant"
  ON "SendingIdentityGrant" ("identityId", COALESCE("personId", ''), COALESCE("roleId", ''));
