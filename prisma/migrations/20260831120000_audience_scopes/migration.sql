-- Audience scopes: the delegation boundary for outreach campaigns.

CREATE TABLE "AudienceScope" (
  "id"           TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "audienceJson" JSONB NOT NULL,
  "fromEmail"    TEXT,
  "fromName"     TEXT,
  "createdById"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AudienceScope_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AudienceScopeGrant" (
  "id"       TEXT NOT NULL,
  "scopeId"  TEXT NOT NULL,
  "personId" TEXT,
  "roleId"   TEXT,
  CONSTRAINT "AudienceScopeGrant_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EmailCampaign" ADD COLUMN "scopeId" TEXT;

ALTER TABLE "AudienceScope" ADD CONSTRAINT "AudienceScope_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AudienceScopeGrant" ADD CONSTRAINT "AudienceScopeGrant_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "AudienceScope"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AudienceScopeGrant" ADD CONSTRAINT "AudienceScopeGrant_personId_fkey"
  FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AudienceScopeGrant" ADD CONSTRAINT "AudienceScopeGrant_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "AudienceScope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "AudienceScopeGrant_scopeId_idx"  ON "AudienceScopeGrant"("scopeId");
CREATE INDEX "AudienceScopeGrant_personId_idx" ON "AudienceScopeGrant"("personId");
CREATE INDEX "AudienceScopeGrant_roleId_idx"   ON "AudienceScopeGrant"("roleId");
CREATE INDEX "EmailCampaign_scopeId_idx"       ON "EmailCampaign"("scopeId");

-- Exactly one target. Mirrors RoleAssignment_target_xor; Prisma cannot model a
-- CHECK, so it lives here and is guarded by schema-guards.test.ts.
ALTER TABLE "AudienceScopeGrant" ADD CONSTRAINT "AudienceScopeGrant_target_xor"
  CHECK ((("personId" IS NOT NULL)::int + ("roleId" IS NOT NULL)::int) = 1);

-- Duplicate-grant guard. A plain multi-column unique treats NULLs as distinct,
-- so (scope, person, NULL) could be inserted twice. COALESCE to '' the way
-- RoleAssignment_unique_grant does.
CREATE UNIQUE INDEX "AudienceScopeGrant_unique_grant"
  ON "AudienceScopeGrant" ("scopeId", COALESCE("personId", ''), COALESCE("roleId", ''));
