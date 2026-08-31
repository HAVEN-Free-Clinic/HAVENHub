# Outreach Phase 1: Delegated, Scope-Bounded Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-admin send an email campaign, bounded to an admin-defined audience scope they cannot widen.

**Architecture:** A new `outreach` top-level module owns campaigns. An `AudienceScope` is itself an `Audience` tree, granted to a Person or a Role. At resolve time the scope's compiled Prisma `where` is intersected with the campaign's at the root, so no campaign audience can escape its scope. Campaigns store `scopeId`, never a pre-merged tree, so narrowing a scope narrows every campaign already scheduled under it.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma/Postgres, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-31-outreach-campaigns-design.md`

## Global Constraints

- **No em-dash (U+2014) anywhere in `src/**/*.{ts,tsx}`.** CI-enforced by the `local/no-em-dash` eslint rule. Use a comma, colon, parentheses, or hyphen.
- **Every permission string MUST be prefixed by its module id.** Enforced by `src/platform/modules/registry.test.ts`. `outreach.*` for everything in this plan.
- **Every permission string MUST be declared in a `MODULES` entry.** `src/modules/admin/services/rbac.ts` builds `VALID_PERMISSIONS` from the registry and rejects anything else, so removing a permission from the registry invalidates existing `RoleGrant` rows holding it.
- **Nav-row module titles are capped at 12 characters.** Enforced by `registry.test.ts`. The title for this module is `Outreach` (8).
- **A condition or audience that cannot be satisfied MUST compile to `MATCH_NOBODY`, never to `undefined`.** Prisma drops `undefined` from a `where`, silently matching every Person. This plan extends that invariant: an absent scope must never read as an absent constraint.
- **Never write raw-SQL constraints into `schema.prisma`.** CHECK constraints and expression indexes live in migration SQL and are guarded by `src/platform/rbac/schema-guards.test.ts`. A `prisma migrate diff` cannot model them and will silently drop them.
- **Do not run the full local suite as a gate.** Run the focused test files named in each task, plus `npx tsc --noEmit` and `npx eslint src e2e`, then push and let GitHub Actions be the authority.

## Test database

This worktree needs its own test database so concurrent sessions do not deadlock on a shared one. Every `vitest` command in this plan is prefixed with it. Vitest does **not** load `.env`, so the variable must be set inline.

```
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach
```

---

### Task 1: Audience scope schema and DB-level guards

**Files:**
- Modify: `prisma/schema.prisma` (add two models near `EmailCampaign`, around line 1108)
- Create: `prisma/migrations/20260831120000_audience_scopes/migration.sql`
- Modify: `src/platform/rbac/schema-guards.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `AudienceScope` and `AudienceScopeGrant`. `AudienceScope` fields: `id: string`, `name: string`, `description: string | null`, `audienceJson: Prisma.JsonValue`, `fromEmail: string | null`, `fromName: string | null`, `createdById: string | null`, `createdAt: Date`, `updatedAt: Date`. `AudienceScopeGrant` fields: `id: string`, `scopeId: string`, `personId: string | null`, `roleId: string | null`.

- [ ] **Step 1: Create the worktree test database**

```bash
psql "postgresql://haven:haven_dev@127.0.0.1:5434/postgres" \
  -c "CREATE DATABASE havenhub_test_outreach OWNER haven"
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx prisma migrate deploy
```

Expected: `CREATE DATABASE`, then migrations applied with no error.

- [ ] **Step 2: Write the failing schema-guard tests**

Append these three cases inside the existing `describe("db-level schema guards", ...)` block in `src/platform/rbac/schema-guards.test.ts`:

```ts
  it("rejects an audience scope grant with neither target set", async () => {
    const scope = await prisma.audienceScope.create({
      data: { name: "S", audienceJson: { recordType: "PERSON", match: "ALL", conditions: [] } },
    });
    await expect(
      prisma.audienceScopeGrant.create({ data: { scopeId: scope.id } }),
    ).rejects.toThrow();
  });

  it("rejects an audience scope grant with both targets set", async () => {
    const scope = await prisma.audienceScope.create({
      data: { name: "S", audienceJson: { recordType: "PERSON", match: "ALL", conditions: [] } },
    });
    const role = await prisma.role.create({ data: { name: "R" } });
    const person = await prisma.person.create({ data: { name: "P" } });
    await expect(
      prisma.audienceScopeGrant.create({
        data: { scopeId: scope.id, personId: person.id, roleId: role.id },
      }),
    ).rejects.toThrow();
  });

  it("rejects a duplicate audience scope grant to the same target", async () => {
    const scope = await prisma.audienceScope.create({
      data: { name: "S", audienceJson: { recordType: "PERSON", match: "ALL", conditions: [] } },
    });
    const person = await prisma.person.create({ data: { name: "P" } });
    await prisma.audienceScopeGrant.create({ data: { scopeId: scope.id, personId: person.id } });
    await expect(
      prisma.audienceScopeGrant.create({ data: { scopeId: scope.id, personId: person.id } }),
    ).rejects.toThrow();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx vitest run src/platform/rbac/schema-guards.test.ts
```

Expected: FAIL. `prisma.audienceScope` is undefined, so the tests error before reaching the constraint.

- [ ] **Step 4: Add the Prisma models**

Insert into `prisma/schema.prisma` immediately before `model EmailCampaign` (line 1108). Note the doc comment pointing at the raw-SQL guards, mirroring the `RoleAssignment` convention:

```prisma
/// A reusable, named audience tree. Doubles as the delegation boundary: a
/// campaign sent under a scope can only ever narrow it, never widen it.
model AudienceScope {
  id           String               @id @default(cuid())
  name         String
  description  String?
  /// An `Audience` tree, the exact shape EmailCampaign.audienceJson holds.
  audienceJson Json
  /// Sending identity for campaigns sent under this scope. Unused until Phase 4.
  fromEmail    String?
  fromName     String?
  createdById  String?
  createdBy    Person?              @relation("audienceScopeCreatedBy", fields: [createdById], references: [id], onDelete: SetNull)
  createdAt    DateTime             @default(now())
  updatedAt    DateTime             @updatedAt
  grants       AudienceScopeGrant[]
  campaigns    EmailCampaign[]
}

/// Exactly one of personId / roleId is set.
/// DB-LEVEL GUARDS LIVE IN RAW SQL (see migration 20260831120000): a CHECK
/// constraint (target = exactly one) and a COALESCE unique index (duplicate
/// grants). Guarded by src/platform/rbac/schema-guards.test.ts. Never resolve a
/// prisma migrate diff by accepting a DROP of objects you do not recognize.
model AudienceScopeGrant {
  id       String        @id @default(cuid())
  scopeId  String
  personId String?
  roleId   String?
  scope    AudienceScope @relation(fields: [scopeId], references: [id], onDelete: Cascade)
  person   Person?       @relation("audienceScopeGrantPerson", fields: [personId], references: [id], onDelete: Cascade)
  role     Role?         @relation(fields: [roleId], references: [id], onDelete: Cascade)

  @@index([scopeId])
  @@index([personId])
  @@index([roleId])
}
```

- [ ] **Step 5: Add the back-relations**

In `model Person`, add these two lines alongside the other relation fields:

```prisma
  audienceScopesCreated AudienceScope[]      @relation("audienceScopeCreatedBy")
  audienceScopeGrants   AudienceScopeGrant[] @relation("audienceScopeGrantPerson")
```

In `model Role` (line 529), add:

```prisma
  audienceScopeGrants AudienceScopeGrant[]
```

In `model EmailCampaign` (line 1108), add the scope link. The campaign side of `scopeId` is wired up in Task 4, but the relation field must exist now for `AudienceScope.campaigns` to compile:

```prisma
  scopeId      String?
  scope        AudienceScope?      @relation(fields: [scopeId], references: [id], onDelete: Restrict)
```

`onDelete: Restrict` is deliberate: deleting a scope that campaigns still reference must fail loudly rather than silently unscoping them into a send-all.

- [ ] **Step 6: Write the migration SQL by hand**

Create `prisma/migrations/20260831120000_audience_scopes/migration.sql`. Write it by hand rather than using `prisma migrate dev`, which folds any pre-existing drift on the dev database into the generated file:

```sql
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
```

- [ ] **Step 7: Apply the migration to the dev and test databases**

```bash
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub \
  npx prisma migrate deploy
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx prisma migrate deploy
npx prisma generate
```

Expected: both report the new migration applied.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx vitest run src/platform/rbac/schema-guards.test.ts
```

Expected: PASS, all cases including the three new ones.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260831120000_audience_scopes src/platform/rbac/schema-guards.test.ts
git commit -m "feat(outreach): add AudienceScope schema with XOR and duplicate guards"
```

---

### Task 2: Scope service

**Files:**
- Create: `src/platform/email/audience/scopes.ts`
- Create: `src/platform/email/audience/scopes.test.ts`
- Modify: `src/platform/rbac/engine.ts` (add `id` to the role select, export `roleIdsForPerson`)

**Interfaces:**
- Consumes: the Prisma models from Task 1.
- Produces:
  - `type AudienceScopeView = { id: string; name: string; description: string | null; audience: Audience; fromEmail: string | null; fromName: string | null }`
  - `listScopes(): Promise<AudienceScopeView[]>`
  - `getScope(id: string): Promise<AudienceScopeView | null>`
  - `createScope(actorId: string | null, input: { name: string; description?: string; audience: Audience }): Promise<AudienceScopeView>`
  - `updateScope(actorId: string | null, id: string, input: { name: string; description?: string; audience: Audience }): Promise<AudienceScopeView>`
  - `deleteScope(actorId: string | null, id: string): Promise<void>`
  - `grantScope(actorId: string | null, scopeId: string, target: { personId: string } | { roleId: string }): Promise<void>`
  - `revokeScope(actorId: string | null, grantId: string): Promise<void>`
  - `scopesForPerson(personId: string): Promise<AudienceScopeView[]>`
  - `class ScopeValidationError extends Error`
  - From `engine.ts`: `roleIdsForPerson(personId: string): Promise<string[]>`

- [ ] **Step 1: Write the failing tests**

Create `src/platform/email/audience/scopes.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createScope, updateScope, deleteScope, listScopes, getScope,
  grantScope, revokeScope, scopesForPerson, ScopeValidationError,
} from "./scopes";
import type { Audience } from "./types";

beforeEach(resetDb);

const ACTIVE_ONLY: Audience = {
  recordType: "PERSON",
  match: "ALL",
  conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
};

describe("audience scopes", () => {
  it("creates, reads, updates and lists a scope", async () => {
    const s = await createScope(null, { name: "Peds", audience: ACTIVE_ONLY });
    expect(s.name).toBe("Peds");
    expect(s.audience).toEqual(ACTIVE_ONLY);

    await updateScope(null, s.id, { name: "Pediatrics", audience: ACTIVE_ONLY });
    expect((await getScope(s.id))?.name).toBe("Pediatrics");
    expect(await listScopes()).toHaveLength(1);
  });

  it("rejects a blank name and a malformed audience", async () => {
    await expect(
      createScope(null, { name: "  ", audience: ACTIVE_ONLY }),
    ).rejects.toBeInstanceOf(ScopeValidationError);
    await expect(
      createScope(null, { name: "X", audience: { bogus: true } as unknown as Audience }),
    ).rejects.toBeInstanceOf(ScopeValidationError);
  });

  it("returns scopes granted directly to a person", async () => {
    const p = await prisma.person.create({ data: { name: "P" } });
    const s = await createScope(null, { name: "Direct", audience: ACTIVE_ONLY });
    await grantScope(null, s.id, { personId: p.id });

    const mine = await scopesForPerson(p.id);
    expect(mine.map((x) => x.name)).toEqual(["Direct"]);
  });

  it("returns scopes granted to a role the person holds", async () => {
    const p = await prisma.person.create({ data: { name: "P" } });
    const role = await prisma.role.create({ data: { name: "Lead" } });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: p.id, termId: null } });
    const s = await createScope(null, { name: "ViaRole", audience: ACTIVE_ONLY });
    await grantScope(null, s.id, { roleId: role.id });

    expect((await scopesForPerson(p.id)).map((x) => x.name)).toEqual(["ViaRole"]);
  });

  it("returns nothing for a person with no grants", async () => {
    const p = await prisma.person.create({ data: { name: "P" } });
    await createScope(null, { name: "Unrelated", audience: ACTIVE_ONLY });
    expect(await scopesForPerson(p.id)).toEqual([]);
  });

  it("deduplicates a scope granted both directly and via a role", async () => {
    const p = await prisma.person.create({ data: { name: "P" } });
    const role = await prisma.role.create({ data: { name: "Lead" } });
    await prisma.roleAssignment.create({ data: { roleId: role.id, personId: p.id, termId: null } });
    const s = await createScope(null, { name: "Both", audience: ACTIVE_ONLY });
    await grantScope(null, s.id, { personId: p.id });
    await grantScope(null, s.id, { roleId: role.id });

    expect(await scopesForPerson(p.id)).toHaveLength(1);
  });

  it("revokes a grant", async () => {
    const p = await prisma.person.create({ data: { name: "P" } });
    const s = await createScope(null, { name: "Temp", audience: ACTIVE_ONLY });
    await grantScope(null, s.id, { personId: p.id });
    const grant = await prisma.audienceScopeGrant.findFirstOrThrow({ where: { scopeId: s.id } });

    await revokeScope(null, grant.id);
    expect(await scopesForPerson(p.id)).toEqual([]);
  });

  it("refuses to delete a scope a campaign still references", async () => {
    const s = await createScope(null, { name: "InUse", audience: ACTIVE_ONLY });
    await prisma.emailCampaign.create({
      data: {
        name: "C",
        scopeId: s.id,
        audienceJson: { recordType: "PERSON", match: "ALL", conditions: [] },
      },
    });
    await expect(deleteScope(null, s.id)).rejects.toBeInstanceOf(ScopeValidationError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx vitest run src/platform/email/audience/scopes.test.ts
```

Expected: FAIL, cannot resolve `./scopes`.

- [ ] **Step 3: Expose the person's role ids from the RBAC engine**

In `src/platform/rbac/engine.ts`, add `id: true` to the role select inside `loadAssignmentContext` (around line 61), so the memoized context carries role ids at no extra query cost:

```ts
        role: { select: { id: true, grants: { select: { permission: true } } } },
```

Then add this exported helper next to `getEffectivePermissions`:

```ts
/**
 * Role ids the person effectively holds, by the same union getEffectivePermissions
 * uses: directly assigned, via an active-term department, or via a membership kind.
 * Exposed so audience-scope grants can target a Role without re-deriving that union.
 */
export const roleIdsForPerson = cache(
  async (personId: string): Promise<string[]> => {
    const { assignments } = await loadAssignmentContext(personId, await activeTermId());
    return [...new Set(assignments.map((a) => a.role.id))];
  },
);
```

- [ ] **Step 4: Write the scope service**

Create `src/platform/email/audience/scopes.ts`:

```ts
/**
 * Audience scopes: named, reusable audience trees that also act as the
 * delegation boundary for outreach campaigns.
 *
 * A scope holds exactly the same `Audience` shape a campaign holds, so scopes
 * and campaigns share one compiler, one builder, and one set of safety
 * invariants. Enforcement (intersecting a scope with a campaign's own audience)
 * lives in resolve.ts, not here: this module only owns storage and grants.
 */
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { roleIdsForPerson } from "@/platform/rbac/engine";
import { isAudience } from "./types";
import type { Audience } from "./types";

export type AudienceScopeView = {
  id: string;
  name: string;
  description: string | null;
  audience: Audience;
  fromEmail: string | null;
  fromName: string | null;
};

export class ScopeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeValidationError";
  }
}

type ScopeRow = {
  id: string;
  name: string;
  description: string | null;
  audienceJson: unknown;
  fromEmail: string | null;
  fromName: string | null;
};

/**
 * A stored audienceJson that no longer parses becomes an EMPTY audience, which
 * compiles to MATCH_NOBODY. Failing closed matters more here than anywhere else
 * in the engine: this value is a send boundary, so a corrupt one must narrow to
 * nobody rather than be skipped as "no constraint".
 */
function toView(row: ScopeRow): AudienceScopeView {
  const audience: Audience = isAudience(row.audienceJson)
    ? row.audienceJson
    : { recordType: "PERSON", match: "ALL", conditions: [] };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    audience,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
  };
}

function validate(input: { name: string; audience: Audience }): void {
  if (input.name.trim() === "") throw new ScopeValidationError("Name is required.");
  if (!isAudience(input.audience)) throw new ScopeValidationError("Invalid audience.");
}

export async function listScopes(): Promise<AudienceScopeView[]> {
  const rows = await prisma.audienceScope.findMany({ orderBy: { name: "asc" } });
  return rows.map(toView);
}

export async function getScope(id: string): Promise<AudienceScopeView | null> {
  const row = await prisma.audienceScope.findUnique({ where: { id } });
  return row ? toView(row) : null;
}

export async function createScope(
  actorId: string | null,
  input: { name: string; description?: string; audience: Audience },
): Promise<AudienceScopeView> {
  validate(input);
  const row = await prisma.audienceScope.create({
    data: {
      name: input.name.trim(),
      description: input.description?.trim() || null,
      audienceJson: input.audience,
      createdById: actorId,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "audience_scope.create",
    entityType: "AudienceScope",
    entityId: row.id,
    after: { name: row.name },
  });
  return toView(row);
}

export async function updateScope(
  actorId: string | null,
  id: string,
  input: { name: string; description?: string; audience: Audience },
): Promise<AudienceScopeView> {
  validate(input);
  const before = await prisma.audienceScope.findUniqueOrThrow({ where: { id } });
  const row = await prisma.audienceScope.update({
    where: { id },
    data: {
      name: input.name.trim(),
      description: input.description?.trim() || null,
      audienceJson: input.audience,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "audience_scope.update",
    entityType: "AudienceScope",
    entityId: id,
    before: { name: before.name, audienceJson: before.audienceJson },
    after: { name: row.name, audienceJson: row.audienceJson },
  });
  return toView(row);
}

export async function deleteScope(actorId: string | null, id: string): Promise<void> {
  // Checked here rather than relying on the FK's onDelete: Restrict so the
  // caller gets a typed, explainable error instead of a raw Prisma failure.
  const inUse = await prisma.emailCampaign.count({ where: { scopeId: id } });
  if (inUse > 0) {
    throw new ScopeValidationError(
      `This scope is used by ${inUse} campaign(s). Reassign or delete them first.`,
    );
  }
  await prisma.audienceScope.delete({ where: { id } });
  await recordAudit({
    actorPersonId: actorId,
    action: "audience_scope.delete",
    entityType: "AudienceScope",
    entityId: id,
  });
}

export async function grantScope(
  actorId: string | null,
  scopeId: string,
  target: { personId: string } | { roleId: string },
): Promise<void> {
  await prisma.audienceScopeGrant.create({ data: { scopeId, ...target } });
  await recordAudit({
    actorPersonId: actorId,
    action: "audience_scope.grant",
    entityType: "AudienceScope",
    entityId: scopeId,
    after: target,
  });
}

export async function revokeScope(actorId: string | null, grantId: string): Promise<void> {
  const grant = await prisma.audienceScopeGrant.delete({ where: { id: grantId } });
  await recordAudit({
    actorPersonId: actorId,
    action: "audience_scope.revoke",
    entityType: "AudienceScope",
    entityId: grant.scopeId,
    before: { personId: grant.personId, roleId: grant.roleId },
  });
}

/**
 * Scopes this person may send under: granted to them directly, or to any role
 * they effectively hold. Deduplicated, because both paths can name one scope.
 */
export async function scopesForPerson(personId: string): Promise<AudienceScopeView[]> {
  const roleIds = await roleIdsForPerson(personId);
  const rows = await prisma.audienceScope.findMany({
    where: {
      grants: {
        some: {
          OR: [{ personId }, ...(roleIds.length ? [{ roleId: { in: roleIds } }] : [])],
        },
      },
    },
    orderBy: { name: "asc" },
  });
  return rows.map(toView);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx vitest run src/platform/email/audience/scopes.test.ts src/platform/rbac/engine.test.ts
```

Expected: PASS. `engine.test.ts` is included because the role select changed.

- [ ] **Step 6: Commit**

```bash
git add src/platform/email/audience/scopes.ts src/platform/email/audience/scopes.test.ts src/platform/rbac/engine.ts
git commit -m "feat(outreach): add audience scope service with person and role grants"
```

---

### Task 3: Scope enforcement in resolveAudience

This is the security-critical task. The intersection must survive a root-`ANY` campaign audience, and precomputes must consider both trees.

**Files:**
- Modify: `src/platform/email/audience/resolve.ts`
- Modify: `src/platform/email/audience/resolve.test.ts`

**Interfaces:**
- Consumes: `Audience` from `./types`, `compilePersonWhere` from `./compile`.
- Produces: `resolveAudience(audience: Audience, opts?: { scope?: Audience | null }): Promise<ResolvedAudience>`. `ResolvedAudience` is unchanged: `{ recipients: Recipient[]; excludedNoEmail: number }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/platform/email/audience/resolve.test.ts`:

```ts
describe("scope enforcement", () => {
  async function twoPeople() {
    const inScope = await prisma.person.create({
      data: { name: "In Scope", contactEmail: "in@example.com", status: "ACTIVE" },
    });
    const outOfScope = await prisma.person.create({
      data: { name: "Out Of Scope", contactEmail: "out@example.com", status: "OFFBOARDED" },
    });
    return { inScope, outOfScope };
  }

  const ACTIVE_SCOPE: Audience = {
    recordType: "PERSON",
    match: "ALL",
    conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
  };

  it("narrows a campaign audience to the scope", async () => {
    await twoPeople();
    const everyone: Audience = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "name", op: "isNotEmpty" }],
    };
    const { recipients } = await resolveAudience(everyone, { scope: ACTIVE_SCOPE });
    expect(recipients.map((r) => r.email)).toEqual(["in@example.com"]);
  });

  // The bug this guards: appending the scope as a sibling CONDITION of a
  // root-ANY audience would OR it away, turning a narrowing into a widening.
  it("cannot be widened by a root-ANY campaign audience", async () => {
    await twoPeople();
    const anyOf: Audience = {
      recordType: "PERSON",
      match: "ANY",
      conditions: [
        { field: "name", op: "contains", value: "Out Of Scope" },
        { field: "name", op: "contains", value: "In Scope" },
      ],
    };
    const { recipients } = await resolveAudience(anyOf, { scope: ACTIVE_SCOPE });
    expect(recipients.map((r) => r.email)).toEqual(["in@example.com"]);
  });

  it("matches nobody when the scope is an empty tree", async () => {
    await twoPeople();
    const everyone: Audience = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "name", op: "isNotEmpty" }],
    };
    const emptyScope: Audience = { recordType: "PERSON", match: "ALL", conditions: [] };
    const { recipients } = await resolveAudience(everyone, { scope: emptyScope });
    expect(recipients).toEqual([]);
  });

  it("is unchanged when no scope is supplied", async () => {
    await twoPeople();
    const everyone: Audience = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "name", op: "isNotEmpty" }],
    };
    const { recipients } = await resolveAudience(everyone);
    expect(recipients).toHaveLength(2);
  });

  // A precompute keyed off only the campaign's conditions would leave
  // complianceStatusByPerson undefined while the SCOPE needs it, and the field
  // compiler would then resolve the scope half to nobody (or throw).
  it("runs precomputes for conditions that appear only in the scope", async () => {
    await twoPeople();
    const scopeNeedingPrecompute: Audience = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "complianceStatus", op: "in", value: ["NO_CERTIFICATE"] }],
    };
    const everyone: Audience = {
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "name", op: "isNotEmpty" }],
    };
    const { recipients } = await resolveAudience(everyone, { scope: scopeNeedingPrecompute });
    // Nobody has a certificate, so both people carry NO_CERTIFICATE and the
    // scope admits them. The point of the assertion is that this does not throw
    // and does not silently return zero.
    expect(recipients.length).toBeGreaterThan(0);
  });
});
```

Make sure `resolve.test.ts` imports `Audience`:

```ts
import type { Audience } from "./types";
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx vitest run src/platform/email/audience/resolve.test.ts
```

Expected: FAIL. `resolveAudience` takes one argument, so the scope is ignored and the narrowing assertions return both people.

- [ ] **Step 3: Thread the scope through resolveAudience**

In `src/platform/email/audience/resolve.ts`, change the signature (line 78) and the two places that derive from `audience`.

Replace the function opening:

```ts
export async function resolveAudience(audience: Audience): Promise<ResolvedAudience> {
  const activeTerm = await getActiveTerm();
  const conditions = collectConditions(audience.conditions);
```

with:

```ts
/**
 * Resolve an audience to its recipients.
 *
 * `opts.scope`, when present, is an audience the result may not escape: the two
 * trees compile independently and are intersected at the ROOT of the Prisma
 * where. Appending the scope as a sibling condition instead would be a security
 * bug, because a campaign whose root match is ANY would OR the scope straight
 * back out and mail everyone.
 */
export async function resolveAudience(
  audience: Audience,
  opts: { scope?: Audience | null } = {},
): Promise<ResolvedAudience> {
  const activeTerm = await getActiveTerm();
  // Precompute detection must span BOTH trees. A condition that appears only in
  // the scope still needs its precomputed map, or the field compiler resolves
  // the scope half against an undefined map.
  const conditions = [
    ...collectConditions(audience.conditions),
    ...(opts.scope ? collectConditions(opts.scope.conditions) : []),
  ];
```

Then replace the `compilePersonWhere` call (around line 128):

```ts
  const where = compilePersonWhere(audience, {
    activeTermId: activeTerm?.id ?? null,
    complianceStatusByPerson,
    clearanceByPerson,
    appliedByCycle,
  });
```

with:

```ts
  const ctx = {
    activeTermId: activeTerm?.id ?? null,
    complianceStatusByPerson,
    clearanceByPerson,
    appliedByCycle,
  };
  const campaignWhere = compilePersonWhere(audience, ctx);
  const where = opts.scope
    ? { AND: [compilePersonWhere(opts.scope, ctx), campaignWhere] }
    : campaignWhere;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx vitest run src/platform/email/audience/
```

Expected: PASS, the whole audience directory including the new scope-enforcement block.

- [ ] **Step 5: Commit**

```bash
git add src/platform/email/audience/resolve.ts src/platform/email/audience/resolve.test.ts
git commit -m "feat(outreach): intersect campaign audiences with their scope at the compiled root"
```

---

### Task 4: Campaign scope binding and send authorization

**Files:**
- Modify: `src/platform/email/campaigns/service.ts`
- Modify: `src/platform/email/campaigns/service.test.ts`

**Interfaces:**
- Consumes: `scopesForPerson`, `getScope`, `AudienceScopeView` from `../audience/scopes`; `resolveAudience(audience, opts)` from Task 3.
- Produces:
  - `class CampaignScopeError extends Error`
  - `assertMaySendUnderScope(personId: string, scopeId: string | null): Promise<AudienceScopeView | null>`
  - `createDraft(actorId, name, opts?: { starterId?: string; scopeId?: string | null })` (extended)
  - `resolveCampaignAudience(campaign: { audienceJson: unknown; scopeId: string | null }): Promise<ResolvedAudience>`

- [ ] **Step 1: Write the failing tests**

Append to `src/platform/email/campaigns/service.test.ts`:

```ts
describe("campaign scope authorization", () => {
  async function scopedSetup() {
    const sender = await prisma.person.create({ data: { name: "Sender" } });
    const scope = await createScope(null, {
      name: "Active only",
      audience: {
        recordType: "PERSON",
        match: "ALL",
        conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
      },
    });
    return { sender, scope };
  }

  it("lets an unrestricted sender send with no scope", async () => {
    const admin = await prisma.person.create({ data: { name: "Admin" } });
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send_unrestricted");
    await expect(assertMaySendUnderScope(admin.id, null)).resolves.toBeNull();
  });

  it("refuses an unscoped send from a scoped-only sender", async () => {
    const { sender } = await scopedSetup();
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send");
    await expect(assertMaySendUnderScope(sender.id, null)).rejects.toBeInstanceOf(CampaignScopeError);
  });

  it("refuses a scope the sender was not granted", async () => {
    const { sender, scope } = await scopedSetup();
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send");
    await expect(assertMaySendUnderScope(sender.id, scope.id)).rejects.toBeInstanceOf(CampaignScopeError);
  });

  it("allows a scope the sender was granted", async () => {
    const { sender, scope } = await scopedSetup();
    await grantScope(null, scope.id, { personId: sender.id });
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send");
    const resolved = await assertMaySendUnderScope(sender.id, scope.id);
    expect(resolved?.id).toBe(scope.id);
  });

  it("lets an unrestricted sender use any scope without a grant", async () => {
    const { sender, scope } = await scopedSetup();
    vi.spyOn(rbac, "can").mockImplementation(async (_id, p) => p === "outreach.send_unrestricted");
    expect((await assertMaySendUnderScope(sender.id, scope.id))?.id).toBe(scope.id);
  });

  it("resolves a scoped campaign's audience through its scope", async () => {
    await prisma.person.create({ data: { name: "Yes", contactEmail: "yes@x.com", status: "ACTIVE" } });
    await prisma.person.create({ data: { name: "No", contactEmail: "no@x.com", status: "OFFBOARDED" } });
    const { scope } = await scopedSetup();
    const { recipients } = await resolveCampaignAudience({
      audienceJson: { recordType: "PERSON", match: "ALL", conditions: [{ field: "name", op: "isNotEmpty" }] },
      scopeId: scope.id,
    });
    expect(recipients.map((r) => r.email)).toEqual(["yes@x.com"]);
  });

  // A campaign scheduled under a scope that is later deleted must not fall back
  // to unscoped. It has to resolve to nobody.
  it("resolves to nobody when the referenced scope has vanished", async () => {
    await prisma.person.create({ data: { name: "Yes", contactEmail: "yes@x.com", status: "ACTIVE" } });
    const { recipients } = await resolveCampaignAudience({
      audienceJson: { recordType: "PERSON", match: "ALL", conditions: [{ field: "name", op: "isNotEmpty" }] },
      scopeId: "scope-that-does-not-exist",
    });
    expect(recipients).toEqual([]);
  });
});
```

Add these imports at the top of `service.test.ts`:

```ts
import { createScope, grantScope } from "@/platform/email/audience/scopes";
import * as rbac from "@/platform/rbac/engine";
import { assertMaySendUnderScope, resolveCampaignAudience, CampaignScopeError } from "./service";
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx vitest run src/platform/email/campaigns/service.test.ts
```

Expected: FAIL, `assertMaySendUnderScope` is not exported from `./service`.

- [ ] **Step 3: Add the authorization and resolution helpers**

In `src/platform/email/campaigns/service.ts`, add these imports:

```ts
import { can } from "@/platform/rbac/engine";
import { getScope, scopesForPerson } from "@/platform/email/audience/scopes";
import type { AudienceScopeView } from "@/platform/email/audience/scopes";
```

Add the error class next to the other typed errors:

```ts
/** Thrown when a sender may not send under the scope a campaign names. */
export class CampaignScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignScopeError";
  }
}
```

Add these two functions after `listCampaigns`:

```ts
/**
 * The permission matrix for a send, re-checked on EVERY send rather than only at
 * schedule time: a campaign can be scheduled under one permission set and
 * dispatched after the sender's grants have changed.
 *
 * outreach.send_unrestricted is strictly stronger and does not require
 * outreach.send. A null scopeId is permitted only for an unrestricted sender,
 * because for anyone else "no scope" would mean "no constraint", which is a
 * send-all.
 */
export async function assertMaySendUnderScope(
  personId: string,
  scopeId: string | null,
): Promise<AudienceScopeView | null> {
  const unrestricted = await can(personId, "outreach.send_unrestricted");

  if (scopeId === null) {
    if (unrestricted) return null;
    throw new CampaignScopeError(
      "Select an audience scope. Only unrestricted senders may send without one.",
    );
  }

  const scope = await getScope(scopeId);
  if (!scope) throw new CampaignScopeError("That audience scope no longer exists.");
  if (unrestricted) return scope;

  const mine = await scopesForPerson(personId);
  if (!mine.some((s) => s.id === scopeId)) {
    throw new CampaignScopeError("You have not been granted that audience scope.");
  }
  return scope;
}

/**
 * Resolve a campaign's recipients, honoring its scope.
 *
 * A campaign naming a scope that has since vanished resolves to NOBODY. Falling
 * back to an unscoped resolve would turn a deleted boundary into a send-all,
 * which is exactly the failure this whole mechanism exists to prevent.
 */
export async function resolveCampaignAudience(campaign: {
  audienceJson: unknown;
  scopeId: string | null;
}): Promise<{ recipients: Recipient[]; excludedNoEmail: number }> {
  const audience = campaign.audienceJson as Audience;
  if (campaign.scopeId === null) return resolveAudience(audience);

  const scope = await getScope(campaign.scopeId);
  if (!scope) return { recipients: [], excludedNoEmail: 0 };
  return resolveAudience(audience, { scope: scope.audience });
}
```

- [ ] **Step 4: Route every existing resolve through the scope-aware helper**

Replace all four `resolveAudience(campaign.audienceJson)` call sites in `service.ts` (lines 168, 241, 328, 376) with `resolveCampaignAudience(campaign)`. Each surrounding call already has a `campaign` in scope holding both `audienceJson` and (after Task 1) `scopeId`.

For example, in `previewAudience`:

```ts
  const { recipients, excludedNoEmail } = await resolveCampaignAudience(campaign);
```

- [ ] **Step 5: Accept a scope on draft creation**

Change the `createDraft` signature and its `data` block:

```ts
export async function createDraft(
  actorId: string | null,
  name: string,
  opts: { starterId?: string; scopeId?: string | null } = {},
) {
  const starter = opts.starterId ? getStarter(opts.starterId) : undefined;
  return prisma.emailCampaign.create({
    data: {
      name: name || starter?.name || "Untitled campaign",
      createdById: actorId,
      status: "DRAFT",
      scopeId: opts.scopeId ?? null,
      audienceJson: { recordType: "PERSON", match: "ALL", conditions: [] },
      subject: starter?.subject ?? "",
      body: starter?.body ?? "",
    },
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx vitest run src/platform/email/campaigns/
```

Expected: PASS, including the pre-existing campaign tests, which must be unaffected because every one of them uses an unscoped campaign.

- [ ] **Step 7: Commit**

```bash
git add src/platform/email/campaigns/service.ts src/platform/email/campaigns/service.test.ts
git commit -m "feat(outreach): bind campaigns to a scope and re-check authorization on every send"
```

---

### Task 5: The outreach module, route move, and permission backfill

The registry rename and the data backfill MUST land together. `VALID_PERMISSIONS` in `src/modules/admin/services/rbac.ts` is built from `MODULES`, so the moment `admin.send_email_campaign` leaves the registry, any `RoleGrant` row still holding it becomes unknown to the roles editor.

**Files:**
- Modify: `src/platform/modules/registry.ts`
- Modify: `src/platform/modules/registry.test.ts`
- Create: `src/app/(app)/outreach/layout.tsx`
- Move: `src/app/(app)/admin/email/campaigns/**` to `src/app/(app)/outreach/campaigns/**`
- Modify: `src/app/(app)/admin/email/page.tsx`
- Create: `prisma/migrations/20260831130000_outreach_permission_rename/migration.sql`
- Create: `src/platform/rbac/outreach-permission-rename.migration.test.ts`
- Modify: `e2e/email-campaigns.spec.ts`

**Interfaces:**
- Consumes: `assertMaySendUnderScope` from Task 4.
- Produces: module id `outreach` with permissions `outreach.access`, `outreach.send`, `outreach.send_unrestricted`, `outreach.manage_scopes`. Routes `/outreach/campaigns`, `/outreach/campaigns/new`, `/outreach/campaigns/[id]`, `/outreach/scopes` (the last built in Task 6).

- [ ] **Step 1: Write the failing registry test**

In `src/platform/modules/registry.test.ts`, add `"outreach"` to the expected id list in the `registers all known modules` case (line 39):

```ts
  it("registers all known modules", () => {
    expect(MODULES.map((m) => m.id).sort()).toEqual(
      [
        "admin",
        "clinic",
        "incidents",
        "learning",
        "my-info",
        "outreach",
        "recruitment",
        "schedule",
        "support",
        "volunteers",
      ].sort()
    );
  });
```

Add a case asserting the old permission is gone:

```ts
  it("no longer declares the pre-delegation campaign permission", () => {
    const all = MODULES.flatMap((m) => m.permissions);
    expect(all).not.toContain("admin.send_email_campaign");
    expect(all).toContain("outreach.send_unrestricted");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/platform/modules/registry.test.ts
```

Expected: FAIL, `outreach` is missing and `admin.send_email_campaign` is still declared.

- [ ] **Step 3: Add the outreach module and drop the old permission**

In `src/platform/modules/registry.ts`, import the icon by adding `Megaphone` to the existing `lucide-react` import list.

Remove the line `"admin.send_email_campaign",` from the `admin` module's `permissions` array (line 193).

Add this manifest after the `admin` entry:

```ts
  {
    id: "outreach",
    title: "Outreach",
    description: "Send targeted email campaigns to a filtered audience",
    icon: Megaphone,
    accessPermission: "outreach.access",
    // A scoped sender holds outreach.send without outreach.access, and an admin
    // may hold only manage_scopes. Both must still reach the module.
    additionalAccessPermissions: ["outreach.send", "outreach.send_unrestricted", "outreach.manage_scopes"],
    permissions: [
      "outreach.access",
      // Compose and send, bounded to the audience scopes granted to the sender.
      "outreach.send",
      // Strictly stronger than outreach.send: may send with no scope at all.
      // This is what admin.send_email_campaign used to mean.
      "outreach.send_unrestricted",
      "outreach.manage_scopes",
    ],
    status: "active",
    nav: [
      { label: "Campaigns", href: "/outreach/campaigns" },
      { label: "Audience scopes", href: "/outreach/scopes", permission: "outreach.manage_scopes" },
    ],
  },
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/platform/modules/registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Move the campaign routes**

```bash
mkdir -p "src/app/(app)/outreach"
git mv "src/app/(app)/admin/email/campaigns" "src/app/(app)/outreach/campaigns"
```

Create `src/app/(app)/outreach/layout.tsx`, mirroring `src/app/(app)/clinic/layout.tsx`:

```tsx
import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { ModuleNav } from "@/platform/ui/module-nav";
import { moduleMetadata } from "@/platform/branding/metadata";

export function generateMetadata() {
  return moduleMetadata("outreach");
}

export default async function OutreachLayout({ children }: { children: ReactNode }) {
  await requireModuleAccess("outreach");
  const mod = getModule("outreach")!;
  return (
    <>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </>
  );
}
```

Create `src/app/(app)/outreach/page.tsx` so the module root is not a 404:

```tsx
import { redirect } from "next/navigation";

export default function OutreachIndexPage() {
  redirect("/outreach/campaigns");
}
```

**The move breaks two relative imports.** Fix both now or the build fails:

1. `src/app/(app)/outreach/campaigns/[id]/page.tsx:33` imports the rich editor as
   `import { TemplateEditor } from "../../templates/[key]/preview";`. From the old
   location that resolved to `src/app/(app)/admin/email/templates/[key]/preview`;
   from the new one it resolves to a path that does not exist. Templates stay in
   Admin (a spec non-goal), so make it an absolute import:

```ts
import { TemplateEditor } from "@/app/(app)/admin/email/templates/[key]/preview";
```

2. The same file redirects to the old list URL on a missing campaign (line 54).
   Change it:

```ts
  if (!campaign) redirect("/outreach/campaigns");
```

Confirm nothing else reaches across the boundary:

```bash
grep -rn "\.\./\.\./" "src/app/(app)/outreach"
```

Expected: no match resolving outside `src/app/(app)/outreach`.

- [ ] **Step 6: Swap the permission strings in the moved routes**

Replace every `requirePermission("admin.send_email_campaign")` in the three moved page files with `requireAnyPermission(["outreach.send", "outreach.send_unrestricted"])`. The call sites are:

- `src/app/(app)/outreach/campaigns/page.tsx:28`
- `src/app/(app)/outreach/campaigns/new/page.tsx:13` and `:17`
- `src/app/(app)/outreach/campaigns/[id]/page.tsx` at lines 50, 144, 176, 187, 205, 236, 262, 283

Update the import in each file from `requirePermission` to `requireAnyPermission`.

In the `[id]/page.tsx` actions that actually send or schedule (the ones at lines 187, 205, 236, 262 handling test send, send, schedule-later and schedule-recurring), add the scope check immediately after the permission gate:

```ts
    const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
    await assertMaySendUnderScope(actor.personId, campaign.scopeId);
```

Import it at the top of the file:

```ts
import { assertMaySendUnderScope } from "@/platform/email/campaigns/service";
```

- [ ] **Step 7: Update the links out of the admin email hub**

In `src/app/(app)/admin/email/page.tsx`, update the campaign capability check (line 91) and the comment at line 86:

```ts
    canAny(personId, ["outreach.send", "outreach.send_unrestricted"]),
```

and point the card's href at `/outreach/campaigns`. If no `canAny` helper exists in that file, use two `can` calls combined with `||`:

```ts
    (await can(personId, "outreach.send")) || (await can(personId, "outreach.send_unrestricted")),
```

- [ ] **Step 8: Write the failing backfill migration test**

The obvious test here (count `RoleGrant` rows still holding the old string) is
worthless: `resetDb` truncates the table, so it would assert `0 === 0` and could
never fail. Test the migration's **transformation** instead, by seeding the
pre-migration state inside the test and running the migration's SQL against it.

Create `src/platform/rbac/outreach-permission-rename.migration.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { MODULES } from "@/platform/modules/registry";

beforeEach(resetDb);

/**
 * Runs the shipped migration SQL against a seeded pre-migration state, so this
 * exercises the real statements rather than a re-implementation of them. A
 * plain "no stale rows exist" assertion would be vacuous: resetDb empties the
 * table, so it could not fail.
 */
const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260831130000_outreach_permission_rename/migration.sql",
  ),
  "utf8",
);

async function runMigration(): Promise<void> {
  for (const statement of MIGRATION_SQL.split(";")) {
    const sql = statement.trim();
    if (sql === "" || sql.startsWith("--")) continue;
    await prisma.$executeRawUnsafe(sql);
  }
}

describe("outreach permission rename migration", () => {
  it("converts a custom role's campaign grant and adds module access", async () => {
    const role = await prisma.role.create({ data: { name: "Comms Lead" } });
    await prisma.roleGrant.create({
      data: { roleId: role.id, permission: "admin.send_email_campaign" },
    });

    await runMigration();

    const perms = (
      await prisma.roleGrant.findMany({ where: { roleId: role.id }, select: { permission: true } })
    ).map((g) => g.permission).sort();
    expect(perms).toEqual(["outreach.access", "outreach.send_unrestricted"]);
  });

  it("leaves a wildcard role untouched", async () => {
    const role = await prisma.role.create({ data: { name: "Platform Admin", isSystem: true } });
    await prisma.roleGrant.create({ data: { roleId: role.id, permission: "*" } });

    await runMigration();

    const perms = (
      await prisma.roleGrant.findMany({ where: { roleId: role.id }, select: { permission: true } })
    ).map((g) => g.permission);
    expect(perms).toEqual(["*"]);
  });

  it("is idempotent and never violates the roleId/permission unique", async () => {
    const role = await prisma.role.create({ data: { name: "Already Migrated" } });
    await prisma.roleGrant.create({
      data: { roleId: role.id, permission: "admin.send_email_campaign" },
    });
    // Pre-existing new-permission rows are exactly the ON CONFLICT case.
    await prisma.roleGrant.create({
      data: { roleId: role.id, permission: "outreach.access" },
    });

    await runMigration();
    await runMigration();

    const perms = (
      await prisma.roleGrant.findMany({ where: { roleId: role.id }, select: { permission: true } })
    ).map((g) => g.permission).sort();
    expect(perms).toEqual(["outreach.access", "outreach.send_unrestricted"]);
  });

  it("leaves every resulting permission declared in the registry", async () => {
    const role = await prisma.role.create({ data: { name: "Comms Lead" } });
    await prisma.roleGrant.create({
      data: { roleId: role.id, permission: "admin.send_email_campaign" },
    });

    await runMigration();

    const valid = new Set<string>(["*", ...MODULES.flatMap((m) => m.permissions)]);
    const granted = await prisma.roleGrant.findMany({ select: { permission: true } });
    expect(granted.map((g) => g.permission).filter((p) => !valid.has(p))).toEqual([]);
  });
});
```

- [ ] **Step 9: Run the test to verify it fails**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx vitest run src/platform/rbac/outreach-permission-rename.migration.test.ts
```

Expected: FAIL with ENOENT on the migration file, which does not exist yet. That
failure is the proof the test is wired to the real SQL rather than a copy.

- [ ] **Step 10: Write the backfill migration**

Create `prisma/migrations/20260831130000_outreach_permission_rename/migration.sql`:

```sql
-- admin.send_email_campaign becomes outreach.send_unrestricted: same meaning
-- (send with no audience constraint), new module namespace.
--
-- Platform Admin holds "*" and needs nothing here. Only hand-made custom roles
-- carry the string explicitly.
--
-- ON CONFLICT DO NOTHING guards the case where a role somehow already holds the
-- new permission, which would otherwise violate RoleGrant's (roleId, permission)
-- unique and abort the deploy.

INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT
  'ogr_' || substr(md5(random()::text || "roleId"), 1, 20),
  "roleId",
  'outreach.send_unrestricted'
FROM "RoleGrant"
WHERE "permission" = 'admin.send_email_campaign'
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- Every sender also needs to reach the module.
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT
  'oga_' || substr(md5(random()::text || "roleId"), 1, 20),
  "roleId",
  'outreach.access'
FROM "RoleGrant"
WHERE "permission" = 'admin.send_email_campaign'
ON CONFLICT ("roleId", "permission") DO NOTHING;

DELETE FROM "RoleGrant" WHERE "permission" = 'admin.send_email_campaign';
```

- [ ] **Step 11: Apply the migration and update the e2e spec**

```bash
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub \
  npx prisma migrate deploy
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx prisma migrate deploy
```

In `e2e/email-campaigns.spec.ts`, update the three URL references (lines 30, 34, 35):

```ts
    await page.goto("/outreach/campaigns/new");
    // Server action creates the draft and redirects to /outreach/campaigns/[id].
    await page.waitForURL(/\/outreach\/campaigns\/[a-z0-9]+$/);
```

Also grep the repo for any remaining reference and fix each:

```bash
grep -rn "admin/email/campaigns\|admin.send_email_campaign" src e2e prisma/seed.ts
```

Expected after fixing: no matches.

- [ ] **Step 12: Run the checks**

```bash
npx tsc --noEmit
npx eslint src e2e
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx vitest run src/platform/modules src/platform/rbac src/platform/email
```

Expected: PASS on all three.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat(outreach): move campaigns into a delegatable outreach module"
```

---

### Task 6: Audience scope admin UI

**Files:**
- Create: `src/platform/email/audience/builder-options.ts`
- Create: `src/app/(app)/outreach/scopes/page.tsx`
- Create: `src/app/(app)/outreach/scopes/[id]/page.tsx`
- Create: `src/app/(app)/outreach/scopes/[id]/grant-form.tsx`
- Modify: `src/app/(app)/outreach/campaigns/[id]/page.tsx` (replace the inline option loaders with the extracted helper)

**Interfaces:**
- Consumes: everything exported from `src/platform/email/audience/scopes.ts` (Task 2), `AudienceBuilder` from `src/app/(app)/outreach/campaigns/[id]/audience-builder.tsx`, and `PERSON_FIELD_VIEWS` from `src/platform/email/audience/person-fields.ts`.
- Produces: `loadAudienceBuilderOptions(audience: Audience): Promise<AudienceBuilderOptions>` where `AudienceBuilderOptions = { departments: { code: string; name: string }[]; terms: { id: string; label: string }[]; cycles: { id: string; label: string }[] }`. No other exports beyond the route components.

- [ ] **Step 1: Write the list page**

Create `src/app/(app)/outreach/scopes/page.tsx`. It mirrors the structure of the campaigns list page (`src/app/(app)/outreach/campaigns/page.tsx`), which is the house pattern for a gated list with a create action:

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { listScopes, createScope } from "@/platform/email/audience/scopes";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";
import { cardClasses } from "@/platform/ui/card";
import { Button } from "@/platform/ui/button";
import { Input, Field } from "@/platform/ui/input";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";

export default async function ScopesPage() {
  await requirePermission("outreach.manage_scopes");
  const scopes = await listScopes();

  async function createAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("outreach.manage_scopes");
    const name = ((formData.get("name") as string | null) ?? "").trim();
    // A new scope starts EMPTY, which compiles to match-nobody. The admin then
    // builds it up on the detail page. Starting empty rather than
    // match-everyone is deliberate: an unfinished send boundary must be closed.
    const scope = await createScope(actor.personId, {
      name,
      audience: { recordType: "PERSON", match: "ALL", conditions: [] },
    });
    redirect(`/outreach/scopes/${scope.id}`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audience scopes"
        description="Named audiences you can grant to a person or role. A campaign sent under a scope can only narrow it."
      />

      <form action={createAction} className="max-w-md">
        <Card className="space-y-4">
          <Field label="New scope name">
            <Input name="name" type="text" placeholder="e.g. Pediatrics outreach" required />
          </Field>
          <FormActions>
            <Button type="submit">Create</Button>
          </FormActions>
        </Card>
      </form>

      {scopes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No scopes yet. A sender with no granted scope can email nobody.
        </p>
      ) : (
        <ul className={`${cardClasses({ pad: false })} divide-y`}>
          {scopes.map((s) => (
            <li key={s.id} className="flex items-center justify-between px-5 py-3">
              <Link
                className="text-sm font-medium underline underline-offset-2"
                href={`/outreach/scopes/${s.id}`}
              >
                {s.name}
              </Link>
              <span className="text-xs text-subtle-foreground">
                {s.audience.conditions.length} condition(s)
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Extract the shared builder-options loader**

The campaign editor spends about 50 lines (`src/app/(app)/outreach/campaigns/[id]/page.tsx`, roughly lines 61 to 125) assembling the department, term and cycle option lists the `AudienceBuilder` needs, including the care that keeps a stored-but-deleted department, term or cycle visible and removable rather than becoming an invisible filter (#82). The scope editor needs exactly the same options over exactly the same builder. Copying that logic would mean two places to fix the next time a reference kind is added, so extract it.

Create `src/platform/email/audience/builder-options.ts`:

```ts
/**
 * Option lists for the AudienceBuilder, shared by the campaign editor and the
 * audience-scope editor.
 *
 * The non-obvious part is the union with referenced-but-missing values. A stored
 * condition naming a department, term or cycle that was later deactivated or
 * deleted has no option in the active-only list, so it renders as neither
 * checked nor uncheckable while still serialising into every save and filtering
 * forever. Every list below therefore unions in whatever the stored audience
 * references, labelled so it can be recognised and removed (#82).
 */
import { prisma } from "@/platform/db";
import { collectAudienceReferences } from "./references";
import type { Audience } from "./types";

export type AudienceBuilderOptions = {
  departments: { code: string; name: string }[];
  terms: { id: string; label: string }[];
  cycles: { id: string; label: string }[];
};

export async function loadAudienceBuilderOptions(
  audience: Audience,
): Promise<AudienceBuilderOptions> {
  const [departments, terms, cycles] = await Promise.all([
    prisma.department.findMany({
      where: { isActive: true },
      select: { code: true, name: true },
      orderBy: { code: "asc" },
    }),
    // EVERY term, archived included, unlike the RBAC term picker which hides
    // archived terms because an assignment scoped to one is permanently inert.
    // Here a past term is the whole point: "email everyone who volunteered in
    // spring" is a question about a roster that is now archived.
    prisma.term.findMany({
      select: { id: true, code: true, name: true, status: true },
      orderBy: { startDate: "desc" },
    }),
    prisma.recruitmentCycle.findMany({
      select: { id: true, title: true, status: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const referenced = collectAudienceReferences(audience.conditions);

  const activeCodes = new Set(departments.map((d) => d.code));
  const missingCodes = [...referenced.departmentCodes].filter((c) => !activeCodes.has(c));
  const inactiveReferenced = missingCodes.length
    ? await prisma.department.findMany({
        where: { code: { in: missingCodes } },
        select: { code: true, name: true },
        orderBy: { code: "asc" },
      })
    : [];
  const foundCodes = new Set(inactiveReferenced.map((d) => d.code));

  return {
    departments: [
      ...departments,
      ...inactiveReferenced.map((d) => ({ code: d.code, name: `${d.name} (inactive)` })),
      // Codes with no surviving Department row at all (department fully
      // deleted): still render them so the admin can uncheck the dead value.
      ...missingCodes
        .filter((c) => !foundCodes.has(c))
        .map((c) => ({ code: c, name: `${c} (removed)` })),
    ],
    terms: [
      ...terms.map((t) => ({
        id: t.id,
        label: t.status === "ACTIVE" ? `${t.code} (current)` : `${t.code} - ${t.name}`,
      })),
      ...[...referenced.termIds]
        .filter((tid) => !terms.some((t) => t.id === tid))
        .map((tid) => ({ id: tid, label: "Deleted term" })),
    ],
    cycles: [
      ...cycles.map((c) => ({ id: c.id, label: c.title })),
      ...[...referenced.cycleIds]
        .filter((cid) => !cycles.some((c) => c.id === cid))
        .map((cid) => ({ id: cid, label: "Deleted cycle" })),
    ],
  };
}
```

Before writing this, read `src/app/(app)/outreach/campaigns/[id]/page.tsx` lines 61 to 145 and `src/platform/email/audience/references.ts`, and make the `cycles` and `terms` shapes match **exactly** what `AudienceBuilder` already receives today. If the campaign editor labels cycles differently, copy its labelling, not the sketch above.

Then rewrite the campaign editor to use it, deleting the lines the helper replaces:

```ts
  const { departments: audienceDepartments, terms: audienceTerms, cycles: audienceCycles } =
    await loadAudienceBuilderOptions(parsedAudience);
```

Keep `loadLayoutSource()` and `getSetting("branding.brandColor")` where they are: those feed the template editor, not the audience builder.

- [ ] **Step 3: Verify the campaign editor is unchanged in behavior**

```bash
npx tsc --noEmit
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx vitest run "src/app/(app)/outreach/campaigns/[id]/audience-builder.test.tsx"
```

Expected: PASS. The extraction is a pure refactor; if this fails, the helper's output shape drifted from what the builder expects.

- [ ] **Step 4: Write the detail page**

Create `src/app/(app)/outreach/scopes/[id]/page.tsx`.

```tsx
import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  getScope, updateScope, deleteScope, grantScope, revokeScope, ScopeValidationError,
} from "@/platform/email/audience/scopes";
import { prisma } from "@/platform/db";
import { isAudience } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Input, Field } from "@/platform/ui/input";
import { Alert } from "@/platform/ui/alert";
import { AudienceBuilder } from "../../campaigns/[id]/audience-builder";
import { GrantForm } from "./grant-form";

export default async function ScopeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requirePermission("outreach.manage_scopes");
  const { id } = await params;
  const { error } = await searchParams;
  const scope = await getScope(id);
  if (!scope) notFound();

  const grants = await prisma.audienceScopeGrant.findMany({
    where: { scopeId: id },
    include: { person: { select: { name: true } }, role: { select: { name: true } } },
  });
  const people = await prisma.person.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const roles = await prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });

  async function saveAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("outreach.manage_scopes");
    const raw = (formData.get("audience") as string | null) ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      redirect(`/outreach/scopes/${id}?error=Invalid+audience`);
    }
    if (!isAudience(parsed)) redirect(`/outreach/scopes/${id}?error=Invalid+audience`);
    await updateScope(actor.personId, id, {
      name: ((formData.get("name") as string | null) ?? "").trim(),
      audience: parsed as Audience,
    });
    redirect(`/outreach/scopes/${id}`);
  }

  async function deleteAction() {
    "use server";
    const actor = await requirePermission("outreach.manage_scopes");
    try {
      await deleteScope(actor.personId, id);
    } catch (e) {
      if (e instanceof ScopeValidationError) {
        redirect(`/outreach/scopes/${id}?error=${encodeURIComponent(e.message)}`);
      }
      throw e;
    }
    redirect("/outreach/scopes");
  }

  async function grantAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("outreach.manage_scopes");
    const personId = ((formData.get("personId") as string | null) ?? "").trim();
    const roleId = ((formData.get("roleId") as string | null) ?? "").trim();
    if (personId) await grantScope(actor.personId, id, { personId });
    else if (roleId) await grantScope(actor.personId, id, { roleId });
    redirect(`/outreach/scopes/${id}`);
  }

  async function revokeAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("outreach.manage_scopes");
    await revokeScope(actor.personId, (formData.get("grantId") as string) ?? "");
    redirect(`/outreach/scopes/${id}`);
  }

  return (
    <div className="space-y-8">
      <PageHeader title={scope.name} description="Who campaigns sent under this scope may reach." />
      {error && <Alert tone="warning">{error}</Alert>}

      <form action={saveAction} className="space-y-6">
        <div className="max-w-sm">
          <Field label="Scope name">
            <Input name="name" type="text" defaultValue={scope.name} required />
          </Field>
        </div>
        <AudienceBuilder
          fields={PERSON_FIELD_VIEWS}
          departments={audienceDepartments}
          terms={audienceTerms}
          cycles={audienceCycles}
          initial={scope.audience}
        />
        <Button type="submit">Save scope</Button>
      </form>

      <div className="space-y-4 border-t border-border pt-6">
        <h2 className="text-base font-semibold text-foreground">Granted to</h2>
        {grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Not granted to anyone yet, so nobody can send under it.
          </p>
        ) : (
          <ul className="divide-y">
            {grants.map((g) => (
              <li key={g.id} className="flex items-center justify-between py-2">
                <span className="text-sm text-foreground-soft">
                  {g.person ? g.person.name : `Role: ${g.role?.name}`}
                </span>
                <form action={revokeAction}>
                  <input type="hidden" name="grantId" value={g.id} />
                  <Button type="submit" variant="outline">Revoke</Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <GrantForm action={grantAction} people={people} roles={roles} />
      </div>

      <div className="border-t border-border pt-6">
        <form action={deleteAction}>
          <Button type="submit" variant="outline">Delete scope</Button>
        </form>
      </div>
    </div>
  );
}
```

Load the builder options through the Step 2 helper, and import `PERSON_FIELD_VIEWS` directly, so this page and the campaign editor stay in lockstep:

```ts
import { PERSON_FIELD_VIEWS } from "@/platform/email/audience/person-fields";
import { loadAudienceBuilderOptions } from "@/platform/email/audience/builder-options";
```

```ts
  const {
    departments: audienceDepartments,
    terms: audienceTerms,
    cycles: audienceCycles,
  } = await loadAudienceBuilderOptions(scope.audience);
```

- [ ] **Step 5: Write the grant form client component**

Create `src/app/(app)/outreach/scopes/[id]/grant-form.tsx`. It is a client component only because it needs to blank the opposite select, keeping the XOR the database enforces from ever being violated by the UI:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/platform/ui/button";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";

type Option = { id: string; name: string };

export function GrantForm({
  action,
  people,
  roles,
}: {
  action: (formData: FormData) => Promise<void>;
  people: Option[];
  roles: Option[];
}) {
  const [personId, setPersonId] = useState("");
  const [roleId, setRoleId] = useState("");

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <Field label="Grant to a person">
        <Select
          name="personId"
          value={personId}
          onChange={(e) => {
            setPersonId(e.target.value);
            if (e.target.value) setRoleId("");
          }}
        >
          <option value="">None</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </Field>
      <Field label="or a role">
        <Select
          name="roleId"
          value={roleId}
          onChange={(e) => {
            setRoleId(e.target.value);
            if (e.target.value) setPersonId("");
          }}
        >
          <option value="">None</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </Select>
      </Field>
      <Button type="submit" disabled={!personId && !roleId}>Grant</Button>
    </form>
  );
}
```

Confirm the import path and prop shape of `Select` against an existing usage before writing this file:

```bash
grep -rn "from \"@/platform/ui/select\"" src/app | head -3
```

- [ ] **Step 6: Verify the pages compile and lint**

```bash
npx tsc --noEmit
npx eslint src
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/outreach/scopes" src/platform/email/audience/builder-options.ts "src/app/(app)/outreach/campaigns/[id]/page.tsx"
git commit -m "feat(outreach): add audience scope management UI"
```

---

### Task 7: Scope selection on a campaign, and nav-row verification

**Files:**
- Modify: `src/app/(app)/outreach/campaigns/new/page.tsx`
- Modify: `src/app/(app)/outreach/campaigns/[id]/page.tsx`
- Modify: `e2e/global-nav.spec.ts` (only if the row overflows)

**Interfaces:**
- Consumes: `scopesForPerson`, `assertMaySendUnderScope`.
- Produces: no new exports.

- [ ] **Step 1: Offer a scope picker on campaign creation**

In `src/app/(app)/outreach/campaigns/new/page.tsx`, load the actor's scopes and render a required picker for anyone who is not unrestricted.

Add to the imports:

```ts
import { requireAnyPermission } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { scopesForPerson } from "@/platform/email/audience/scopes";
import { Select } from "@/platform/ui/select";
```

At the top of the component:

```ts
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  const unrestricted = await can(actor.personId, "outreach.send_unrestricted");
  const scopes = await scopesForPerson(actor.personId);
```

Inside the form, above the starter radio group:

```tsx
          <Field label="Audience scope">
            <Select name="scopeId" required={!unrestricted} defaultValue="">
              {unrestricted && <option value="">No scope (everyone)</option>}
              {scopes.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </Field>
          {!unrestricted && scopes.length === 0 && (
            <Alert tone="warning">
              You have not been granted an audience scope, so you cannot send yet. Ask an
              administrator to grant you one.
            </Alert>
          )}
```

In `createAction`, pass it through and authorize before creating:

```ts
    const scopeId = ((formData.get("scopeId") as string | null) ?? "").trim() || null;
    await assertMaySendUnderScope(actor.personId, scopeId);
    const c = await createDraft(actor.personId, name, {
      starterId: starterId || undefined,
      scopeId,
    });
```

Import `assertMaySendUnderScope` and `Alert` at the top.

- [ ] **Step 2: Show the bound scope on the campaign editor**

In `src/app/(app)/outreach/campaigns/[id]/page.tsx`, inside the Audience section (just above `<AudienceBuilder ...>` around line 345), render the scope as read-only context so the sender can see what bounds them:

```tsx
            {campaign.scopeId && (
              <Alert tone="info">
                This campaign is bounded by the <strong>{scopeName}</strong> scope. Recipients are
                the people matching BOTH that scope and the conditions below.
              </Alert>
            )}
```

Load `scopeName` near the other loaders at the top of the component:

```ts
  const boundScope = campaign.scopeId ? await getScope(campaign.scopeId) : null;
  const scopeName = boundScope?.name ?? "a deleted scope";
```

Import `getScope` from `@/platform/email/audience/scopes`.

- [ ] **Step 3: Run the checks**

```bash
npx tsc --noEmit
npx eslint src e2e
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_outreach \
  npx vitest run src/platform/email src/platform/modules src/platform/rbac
```

Expected: PASS on all three.

- [ ] **Step 4: Verify the global nav row still fits**

Adding a tenth module adds a chip to the nav row. The row fitting at 1280px is a layout property that only the browser can answer, so a unit test cannot confirm it. Run the real guard:

```bash
npx playwright test e2e/global-nav.spec.ts
```

Expected: PASS, with nothing pushed behind "More".

If it FAILS, do **not** estimate widths. Add a temporary Playwright assertion that dumps `navClientWidth`, each `[data-measure-item]` `offsetWidth`, and the `[data-measure-more]` width, push it, and read the real numbers from CI before deciding whether to shorten a title or accept the overflow menu.

- [ ] **Step 5: Commit and push**

```bash
git add -A
git commit -m "feat(outreach): bind new campaigns to a scope the sender holds"
git push -u origin HEAD
```

- [ ] **Step 6: Watch CI**

```bash
gh run list --branch "$(git branch --show-current)" --limit 3
gh run view <id> --log-failed
```

CI is the authority for the full suite. Fix anything it reports before considering Phase 1 done.

---

## Self-review notes

**Spec coverage.** Every Phase 1 bullet in the spec maps to a task: new module and route move (Task 5), permission split (Task 5), `AudienceScope` plus grants (Tasks 1 and 2), the enforcement seam (Tasks 3 and 4), scope admin UI (Task 6), backfill migration (Task 5). The three named send-all hazards each have a dedicated test: compiled-root intersection and root-`ANY` (Task 3 Step 1), zero-scope resolving to nobody (Task 4 Step 1), and a vanished scope resolving to nobody (Task 4 Step 1). The manual-list bypass hazard belongs to Phase 2, since manual lists do not exist yet.

**Deferred to later phases, deliberately.** Date and number conditions, extra fields, manual include/exclude, send-once, the two-pane builder, and sender identity are all Phase 2 through 4.
