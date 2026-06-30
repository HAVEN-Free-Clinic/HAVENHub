# RBAC kind decouple + manual assignment editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the roles page the single source of truth for membership-kind-derived access, and add a person-centric assignment editor (add department, change role, remove) behind a new delegatable permission.

**Architecture:** Phase 1 removes the hardcoded `MEMBERSHIP_KIND_ROLE` auto-attach in the RBAC engine and replaces it with seeded, roles-page-editable kind-target `RoleAssignment` rows (the column, engine resolution, and roles-page UI already exist on main). Phase 2 introduces `admin.manage_roster`, a `changeMembershipKind` service that blocks director demotion when director shift assignments exist, a person-page membership editor, and re-gates the term roster panel.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma + Postgres, Vitest, TypeScript.

## Global Constraints

- **Database safety (exact setup for this worktree, MANDATORY):** this worktree has NO `.env`. A local Postgres runs via docker on host port 5434 (user `haven`, password `haven_dev`). An isolated per-worktree database `havenhub_test_rbac` already exists (a migrated clone of `havenhub_test`, schema at `20260629140000`). Use it for EVERYTHING and never omit the explicit URLs:
  - Tests: prefix every vitest command with `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac'` (vitest.setup.ts maps it to `DATABASE_URL`).
  - Migrations: apply ONLY with `npx prisma migrate deploy` (NEVER `prisma migrate dev` / `npm run db:migrate`, which are interactive and can reset), prefixing BOTH `DATABASE_URL` and `DATABASE_URL_UNPOOLED` with the same `havenhub_test_rbac` url.
  - Never run a DB command without those explicit local URLs. Never target the shared `havenhub_test` (cross-worktree deadlock) or Neon. Do NOT run `prisma generate` here (node_modules is a shared symlink; the client is already current).
- **No em-dashes** in any code comment, doc, or copy. Use periods, commas, parentheses, or colons.
- **Migrations are hand-authored SQL** in timestamped directories. The schema has raw-SQL guards (expression indexes, CHECK constraints) that Prisma's diff cannot model. Never accept a `prisma migrate` diff that DROPs an object you did not create. This plan changes NO `schema.prisma` (the `RoleAssignment.kind` column already exists); every migration here is data-only.
- **Permission checks live in pages and server actions, never in services.** Services trust their callers (existing `roster.ts` convention).
- **TDD and frequent commits:** write the failing test first where logic is involved; one commit per task.
- Run tests as `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' npx vitest run <path>`.

## Prerequisites (one-time, before Task 1)

- [ ] The isolated DB `havenhub_test_rbac` (localhost:5434) already exists, cloned and migrated to `20260629140000`. Confirm it is reachable: `psql 'postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' -tAc "SELECT 1;"` prints `1`.
- [ ] Confirm the branch base is correct (already verified): the latest migration directory is `20260629140000_teams_message_email_already_queued` and `RoleAssignment.kind` exists in `prisma/schema.prisma`. New migrations in this plan must sort AFTER `20260629140000`.

---

## Phase 1: RBAC decouple

### Task 1: Remove the hardcoded membership-kind auto-attach in the engine

**Files:**
- Modify: `src/platform/rbac/engine.ts`
- Test: `src/platform/rbac/engine.test.ts`

**Interfaces:**
- Consumes: `prisma`, `getActiveTerm()`, `RoleAssignment` rows (incl. `kind`-target rows).
- Produces: `getEffectivePermissions(personId): Promise<Set<string>>`, `can(personId, permission): Promise<boolean>`, `hasPermission(perms, permission): boolean` (signatures unchanged). After this task, membership kind grants access ONLY through kind-target `RoleAssignment` rows, not via code.

- [ ] **Step 1: Update the test fixture to provision baseline access as kind-target assignments, and add a decouple test**

In `src/platform/rbac/engine.test.ts`, the `fixture()` currently creates `directorRole` and `volunteerRole` but no assignments (baseline came from the hardcoded auto-attach). Add two global kind-target assignments at the end of `fixture()`, just before the `return`, so the fixture mirrors the seeded production state:

```ts
  // Baseline access is now provisioned as kind-target assignments (decouple),
  // mirroring prisma/seed.ts and the backfill migration. No code auto-attach.
  await prisma.roleAssignment.create({
    data: { roleId: directorRole.id, kind: "DIRECTOR", termId: null },
  });
  await prisma.roleAssignment.create({
    data: { roleId: volunteerRole.id, kind: "VOLUNTEER", termId: null },
  });

  return { term, oldTerm, itcm, vadm, adminRole, directorRole, volunteerRole, recruiterRole };
```

Then rename the existing `it("auto-attaches Director role from active-term membership kind", ...)` to reflect the new mechanism and add a new test that proves there is no code-level fallback. Place this new test directly after that renamed test:

```ts
  it("grants Director baseline via the kind-target assignment", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Dir" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.vadm.id, kind: "DIRECTOR" },
    });
    expect(await can(person.id, "volunteers.view")).toBe(true);
    expect(await can(person.id, "recruitment.manage_cycle")).toBe(false);
  });

  it("grants nothing from membership kind alone once the kind assignment is removed", async () => {
    const f = await fixture();
    await prisma.roleAssignment.deleteMany({ where: { kind: "DIRECTOR" } });
    const person = await prisma.person.create({ data: { name: "Dir no-assign" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.vadm.id, kind: "DIRECTOR" },
    });
    // Proves the hardcoded auto-attach is gone: kind alone confers no access.
    expect(await can(person.id, "volunteers.view")).toBe(false);
  });
```

- [ ] **Step 2: Run the tests and confirm the new decouple test FAILS**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' npx vitest run src/platform/rbac/engine.test.ts`
Expected: the test `grants nothing from membership kind alone once the kind assignment is removed` FAILS (the current engine still auto-attaches the Director role, so `volunteers.view` is still true). The other tests PASS (the fixture now seeds redundant kind assignments).

- [ ] **Step 3: Remove the auto-attach from the engine**

Replace the entire contents of `src/platform/rbac/engine.ts` with:

```ts
import { cache } from "react";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";

/**
 * Union of:
 *  - roles assigned directly to the person (global, or scoped to the active term)
 *  - roles assigned to departments the person actively belongs to in the active term
 *  - roles assigned to the person's active-term membership kinds (DIRECTOR/VOLUNTEER)
 *
 * Baseline Director/Volunteer access is provisioned as kind-target RoleAssignment
 * rows (see prisma/seed.ts and the backfill migration), NOT auto-attached in code,
 * so the roles page is the single source of truth. Computed from live DB state and
 * memoized per request via React cache(): repeated calls in one render hit the DB
 * once, and role changes apply on the next request.
 */
export const getEffectivePermissions = cache(
  async (personId: string): Promise<Set<string>> => {
    const activeTerm = await getActiveTerm();

    const memberships = activeTerm
      ? await prisma.termMembership.findMany({
          where: { personId, termId: activeTerm.id, status: "ACTIVE" },
        })
      : [];
    const departmentIds = [...new Set(memberships.map((m) => m.departmentId))];
    const membershipKinds = [...new Set(memberships.map((m) => m.kind))];

    const assignments = await prisma.roleAssignment.findMany({
      where: {
        AND: [
          {
            OR: [{ termId: null }, ...(activeTerm ? [{ termId: activeTerm.id }] : [])],
          },
          {
            OR: [
              { personId },
              ...(departmentIds.length ? [{ departmentId: { in: departmentIds } }] : []),
              ...(membershipKinds.length ? [{ kind: { in: membershipKinds } }] : []),
            ],
          },
        ],
      },
      include: { role: { include: { grants: true } } },
    });

    const permissions = new Set<string>();
    for (const a of assignments) for (const g of a.role.grants) permissions.add(g.permission);
    return permissions;
  },
);

/** The one place the "*" wildcard rule lives. Use this on any Set from getEffectivePermissions. */
export function hasPermission(perms: Set<string>, permission: string): boolean {
  return perms.has(permission) || perms.has("*");
}

export async function can(personId: string, permission: string): Promise<boolean> {
  return hasPermission(await getEffectivePermissions(personId), permission);
}
```

This removes the `MEMBERSHIP_KIND_ROLE` constant, the now-unused `import type { MembershipKind }`, the `autoRoleNames` derivation, the second `prisma.role.findMany` query, and the auto-role grant loop.

- [ ] **Step 4: Run the tests and confirm all pass**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' npx vitest run src/platform/rbac/engine.test.ts`
Expected: PASS, including `grants nothing from membership kind alone once the kind assignment is removed`.

- [ ] **Step 5: Commit**

```bash
git add src/platform/rbac/engine.ts src/platform/rbac/engine.test.ts
git commit -m "refactor(rbac): drop hardcoded membership-kind auto-attach; baseline now data-driven"
```

---

### Task 2: Provision baseline kind-target assignments (dev seed + prod backfill)

**Files:**
- Modify: `prisma/seed.ts`
- Create: `prisma/migrations/20260629150000_seed_membership_kind_role_assignments/migration.sql`

**Interfaces:**
- Consumes: the seeded `Director` and `Volunteer` system roles (created earlier in `seed.ts` from `SYSTEM_ROLES`).
- Produces: two global (`termId` null) kind-target `RoleAssignment` rows: `Director` to `DIRECTOR`, `Volunteer` to `VOLUNTEER`. This is what carries baseline access now that the engine no longer auto-attaches.

- [ ] **Step 1: Add the seed block**

In `prisma/seed.ts`, immediately after the `for (const role of SYSTEM_ROLES) { ... }` loop (the block that ends around line 173 with the role/grant upserts), insert:

```ts
  // Baseline access by membership kind. Replaces the engine's old hardcoded
  // auto-attach: a global kind-target assignment grants the Director/Volunteer
  // role to every active member of that kind, in any term. Idempotent.
  for (const [roleName, kind] of [
    ["Director", "DIRECTOR"],
    ["Volunteer", "VOLUNTEER"],
  ] as const) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) continue;
    const existing = await prisma.roleAssignment.findFirst({
      where: { roleId: role.id, kind, termId: null, personId: null, departmentId: null },
    });
    if (!existing) {
      await prisma.roleAssignment.create({ data: { roleId: role.id, kind, termId: null } });
    }
  }
```

- [ ] **Step 2: Create the backfill migration**

Create `prisma/migrations/20260629150000_seed_membership_kind_role_assignments/migration.sql` with:

```sql
-- Decouple baseline access from the engine's hardcoded membership-kind auto-attach
-- (removed in this PR). Provision the equivalent as data: one global kind-target
-- RoleAssignment per system role. The engine resolves these via the kind column.
--
-- Idempotent: WHERE NOT EXISTS skips when the row is already present, and the
-- SELECT yields no rows (safe no-op) when the role has not been seeded yet.
-- ON CONFLICT cannot be used here: RoleAssignment_unique_grant is an expression
-- index, not a plain column constraint.

INSERT INTO "RoleAssignment" ("id", "roleId", "kind", "termId")
SELECT gen_random_uuid()::text, r."id", 'DIRECTOR'::"MembershipKind", NULL
FROM "Role" r
WHERE r."name" = 'Director' AND r."isSystem" = true
  AND NOT EXISTS (
    SELECT 1 FROM "RoleAssignment" ra
    WHERE ra."roleId" = r."id"
      AND ra."kind" = 'DIRECTOR'
      AND ra."termId" IS NULL
      AND ra."personId" IS NULL
      AND ra."departmentId" IS NULL
  );

INSERT INTO "RoleAssignment" ("id", "roleId", "kind", "termId")
SELECT gen_random_uuid()::text, r."id", 'VOLUNTEER'::"MembershipKind", NULL
FROM "Role" r
WHERE r."name" = 'Volunteer' AND r."isSystem" = true
  AND NOT EXISTS (
    SELECT 1 FROM "RoleAssignment" ra
    WHERE ra."roleId" = r."id"
      AND ra."kind" = 'VOLUNTEER'
      AND ra."termId" IS NULL
      AND ra."personId" IS NULL
      AND ra."departmentId" IS NULL
  );
```

- [ ] **Step 3: Apply and verify against the isolated local DB**

Apply the new migration non-interactively (both URLs point at the isolated DB):

```bash
DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' \
DATABASE_URL_UNPOOLED='postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' \
npx prisma migrate deploy
```

Verify exactly the two global kind assignments now exist:

```bash
psql 'postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' -tAc "SELECT r.name || ':' || ra.kind FROM \"RoleAssignment\" ra JOIN \"Role\" r ON r.id = ra.\"roleId\" WHERE ra.kind IS NOT NULL AND ra.\"termId\" IS NULL ORDER BY 1;"
```

Expected output:

```
Director:DIRECTOR
Volunteer:VOLUNTEER
```

Re-run both commands; the output is unchanged (idempotent). The `seed.ts` change is dev-only (verified by `tsc` and review); running a full `prisma db seed` is unnecessary here and would pollute the test DB with fixtures.

- [ ] **Step 4: Confirm the full engine suite still passes**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' npx vitest run src/platform/rbac/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma/seed.ts prisma/migrations/20260629150000_seed_membership_kind_role_assignments
git commit -m "feat(rbac): provision baseline Director/Volunteer access as kind-target assignments"
```

> Note: the roles page (`/admin/roles`) already renders and edits kind-target assignments (the "Assign role to all members of a kind" card in `src/modules/admin/components/assignment-form.tsx`, shipped with the `RoleAssignment.kind` migration). No roles-page UI work is needed; an admin can now see and edit these two rows there.

---

## Phase 2: Manual assignment editor

### Task 3: Introduce the `admin.manage_roster` permission

**Files:**
- Modify: `src/platform/modules/registry.ts`
- Modify: `src/platform/rbac/system-roles.ts`
- Create: `prisma/migrations/20260629160000_grant_manage_roster_permission/migration.sql`
- Test: `src/platform/rbac/system-roles.test.ts`

**Interfaces:**
- Produces: the permission string `admin.manage_roster`, registered in the admin module and granted by default to `Platform Admin` (via `*`) and `Volunteer Operations Manager`. The prod backfill also grants it to any role that currently holds `admin.manage_terms`, so no existing term-admin loses roster ability.

- [ ] **Step 1: Write the failing unit test**

Create `src/platform/rbac/system-roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SYSTEM_ROLES } from "./system-roles";

describe("SYSTEM_ROLES", () => {
  it("grants admin.manage_roster to Volunteer Operations Manager", () => {
    const volOps = SYSTEM_ROLES.find((r) => r.name === "Volunteer Operations Manager");
    expect(volOps).toBeDefined();
    expect(volOps!.grants).toContain("admin.manage_roster");
  });
});
```

- [ ] **Step 2: Run the test and confirm it FAILS**

Run: `npx vitest run src/platform/rbac/system-roles.test.ts`
Expected: FAIL (the grant is not present yet).

- [ ] **Step 3: Add the grant to the system role**

In `src/platform/rbac/system-roles.ts`, change the `Volunteer Operations Manager` grants line from:

```ts
    grants: ["volunteers.view", "volunteers.manage_offboarding", "volunteers.manage_epic", "volunteers.issue_disciplinary"],
```

to:

```ts
    grants: ["volunteers.view", "volunteers.manage_offboarding", "volunteers.manage_epic", "volunteers.issue_disciplinary", "admin.manage_roster"],
```

- [ ] **Step 4: Register the permission in the admin module**

In `src/platform/modules/registry.ts`, in the admin module `permissions` array (currently ending with `"admin.manage_subcommittees",` around line 101), add the new permission:

```ts
      "admin.manage_subcommittees",
      "admin.manage_roster",
```

- [ ] **Step 5: Create the prod backfill migration**

Create `prisma/migrations/20260629160000_grant_manage_roster_permission/migration.sql`:

```sql
-- Introduce admin.manage_roster (manual term-assignment editing, delegatable).
-- Platform Admin holds it via the "*" wildcard, so no grant needed there.
--
-- 1. Grant to Volunteer Operations Manager (matches src/platform/rbac/system-roles.ts
--    so dev seed and prod agree).
-- 2. Preserve current behavior: any role that can manage_terms could already manage
--    rosters, so grant manage_roster to every such role. Prevents a custom
--    term-admin role from silently losing roster ability when the roster panel
--    re-gates onto manage_roster.
--
-- Idempotent: RoleGrant has a real unique index (RoleGrant_roleId_permission_key),
-- so ON CONFLICT DO NOTHING is safe.

INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", 'admin.manage_roster'
FROM "Role" r
WHERE r."name" = 'Volunteer Operations Manager' AND r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;

INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, rg."roleId", 'admin.manage_roster'
FROM "RoleGrant" rg
WHERE rg."permission" = 'admin.manage_terms'
ON CONFLICT ("roleId", "permission") DO NOTHING;
```

- [ ] **Step 6: Run the test and apply the migration**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' npx vitest run src/platform/rbac/system-roles.test.ts`
Expected: PASS.

Apply and verify the grant migration:

```bash
DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' \
DATABASE_URL_UNPOOLED='postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' \
npx prisma migrate deploy
psql 'postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' -tAc "SELECT DISTINCT r.name FROM \"RoleGrant\" g JOIN \"Role\" r ON r.id = g.\"roleId\" WHERE g.permission = 'admin.manage_roster' ORDER BY 1;"
```

Expected: the result includes `Volunteer Operations Manager` (plus any role that already held `admin.manage_terms`).

- [ ] **Step 7: Commit**

```bash
git add src/platform/modules/registry.ts src/platform/rbac/system-roles.ts src/platform/rbac/system-roles.test.ts prisma/migrations/20260629160000_grant_manage_roster_permission
git commit -m "feat(rbac): add delegatable admin.manage_roster permission"
```

---

### Task 4: `changeMembershipKind` service + director-shift block

**Files:**
- Modify: `src/modules/admin/services/roster.ts`
- Test: `src/modules/admin/services/roster.test.ts`

**Interfaces:**
- Consumes: `prisma`, `recordAudit`, existing `MembershipNotFoundError`.
- Produces:
  - `class DirectorHasShiftAssignmentsError extends Error` with `membershipId: string`.
  - `changeMembershipKind(actorPersonId: string, input: { membershipId: string; toKind: "DIRECTOR" | "VOLUNTEER" }): Promise<void>`. Flips a membership's kind by reviving/creating the target-kind row ACTIVE and soft-removing the old row, in one transaction; writes one `roster.change_kind` audit; no-op when already that kind; throws `MembershipNotFoundError` for an unknown id; throws `DirectorHasShiftAssignmentsError` when demoting DIRECTOR to VOLUNTEER while the person holds DIRECTOR shift assignments in that department/term.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/admin/services/roster.test.ts` (the file already imports `prisma`, `resetDb`, the roster functions, and `ACTOR`; extend the import from `./roster` to add `changeMembershipKind` and `DirectorHasShiftAssignmentsError`):

Update the import block at the top of the file to:

```ts
import {
  termRoster,
  addMembership,
  removeMembership,
  copyRosterFromTerm,
  changeMembershipKind,
  MembershipNotFoundError,
  MembershipForeignKeyError,
  DirectorHasShiftAssignmentsError,
  RosterCopyError,
} from "./roster";
```

Then add this describe block at the end of the file:

```ts
describe("changeMembershipKind", () => {
  beforeEach(resetDb);

  it("flips VOLUNTEER to DIRECTOR: target row ACTIVE, old row REMOVED, one audit", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const dept = await seedDepartment("DEPT");
    const person = await seedPerson("Alice");
    const m = await seedMembership({ personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" });

    await changeMembershipKind(ACTOR, { membershipId: m.id, toKind: "DIRECTOR" });

    const director = await prisma.termMembership.findFirst({
      where: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR" },
    });
    const volunteer = await prisma.termMembership.findUnique({ where: { id: m.id } });
    expect(director!.status).toBe("ACTIVE");
    expect(volunteer!.status).toBe("REMOVED");

    const logs = await prisma.auditLog.findMany({ where: { action: "roster.change_kind" } });
    expect(logs).toHaveLength(1);
    expect((logs[0].before as Record<string, unknown>).kind).toBe("VOLUNTEER");
    expect((logs[0].after as Record<string, unknown>).kind).toBe("DIRECTOR");
  });

  it("is a no-op when the membership is already the target kind (no audit)", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const dept = await seedDepartment("DEPT");
    const person = await seedPerson("Alice");
    const m = await seedMembership({ personId: person.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR" });

    const before = await prisma.auditLog.count();
    await changeMembershipKind(ACTOR, { membershipId: m.id, toKind: "DIRECTOR" });
    expect(await prisma.auditLog.count()).toBe(before);
  });

  it("revives a previously REMOVED target-kind row instead of colliding", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const dept = await seedDepartment("DEPT");
    const person = await seedPerson("Alice");
    const vol = await seedMembership({ personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER" });
    await seedMembership({ personId: person.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR", status: "REMOVED" });

    await changeMembershipKind(ACTOR, { membershipId: vol.id, toKind: "DIRECTOR" });

    const director = await prisma.termMembership.findFirst({
      where: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR" },
    });
    expect(director!.status).toBe("ACTIVE");
  });

  it("throws MembershipNotFoundError for an unknown id", async () => {
    await expect(
      changeMembershipKind(ACTOR, { membershipId: "nope", toKind: "DIRECTOR" })
    ).rejects.toBeInstanceOf(MembershipNotFoundError);
  });

  it("blocks DIRECTOR to VOLUNTEER when director shift assignments exist that term/dept", async () => {
    const term = await seedTerm("SU26", "ACTIVE");
    const dept = await seedDepartment("DEPT");
    const person = await seedPerson("Alice");
    const m = await seedMembership({ personId: person.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR" });
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: dept.id,
        personId: person.id,
        clinicDate: new Date("2026-06-06T12:00:00Z"),
        role: "DIRECTOR",
      },
    });

    await expect(
      changeMembershipKind(ACTOR, { membershipId: m.id, toKind: "VOLUNTEER" })
    ).rejects.toBeInstanceOf(DirectorHasShiftAssignmentsError);

    // Unchanged: still a DIRECTOR, no audit.
    const reloaded = await prisma.termMembership.findUnique({ where: { id: m.id } });
    expect(reloaded!.kind).toBe("DIRECTOR");
    expect(reloaded!.status).toBe("ACTIVE");
    expect(await prisma.auditLog.count()).toBe(0);
  });
});

describe("DirectorHasShiftAssignmentsError", () => {
  it("is an instance of Error and carries the membership id", () => {
    const err = new DirectorHasShiftAssignmentsError("abc-123");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DirectorHasShiftAssignmentsError);
    expect(err.membershipId).toBe("abc-123");
    expect(err.name).toBe("DirectorHasShiftAssignmentsError");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they FAIL**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' npx vitest run src/modules/admin/services/roster.test.ts`
Expected: FAIL with "changeMembershipKind is not a function" / "DirectorHasShiftAssignmentsError is not exported".

- [ ] **Step 3: Implement the error and the service**

In `src/modules/admin/services/roster.ts`, add the error class alongside the other typed errors (after `MembershipForeignKeyError`):

```ts
export class DirectorHasShiftAssignmentsError extends Error {
  constructor(public membershipId: string) {
    super(`Membership ${membershipId} has director shift assignments; resolve them before changing role`);
    this.name = "DirectorHasShiftAssignmentsError";
  }
}
```

Then add the service function in the Mutations section (after `removeMembership`):

```ts
/**
 * Changes a membership's kind (DIRECTOR <-> VOLUNTEER) for its term+department.
 * Because kind is part of the unique key, this revives/creates the target-kind
 * row ACTIVE and soft-removes the old row, transactionally. No-op when already
 * that kind. Refuses to demote a DIRECTOR who still holds DIRECTOR shift
 * assignments in that department/term (builder.ts forbids director shift roles
 * for non-directors), so the caller resolves those first.
 */
export async function changeMembershipKind(
  actorPersonId: string,
  input: { membershipId: string; toKind: "DIRECTOR" | "VOLUNTEER" }
): Promise<void> {
  const membership = await prisma.termMembership.findUnique({
    where: { id: input.membershipId },
  });
  if (!membership) throw new MembershipNotFoundError(input.membershipId);
  if (membership.kind === input.toKind) return;

  if (membership.kind === "DIRECTOR" && input.toKind === "VOLUNTEER") {
    const directorShifts = await prisma.shiftAssignment.count({
      where: {
        personId: membership.personId,
        termId: membership.termId,
        departmentId: membership.departmentId,
        role: "DIRECTOR",
      },
    });
    if (directorShifts > 0) throw new DirectorHasShiftAssignmentsError(input.membershipId);
  }

  await prisma.$transaction(async (tx) => {
    await tx.termMembership.upsert({
      where: {
        personId_termId_departmentId_kind: {
          personId: membership.personId,
          termId: membership.termId,
          departmentId: membership.departmentId,
          kind: input.toKind,
        },
      },
      update: { status: "ACTIVE" },
      create: {
        personId: membership.personId,
        termId: membership.termId,
        departmentId: membership.departmentId,
        kind: input.toKind,
        status: "ACTIVE",
      },
    });
    await tx.termMembership.update({
      where: { id: membership.id },
      data: { status: "REMOVED" },
    });
  });

  await recordAudit({
    actorPersonId,
    action: "roster.change_kind",
    entityType: "TermMembership",
    entityId: membership.id,
    before: { kind: membership.kind },
    after: { kind: input.toKind },
  });
}
```

- [ ] **Step 4: Run the tests and confirm all pass**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' npx vitest run src/modules/admin/services/roster.test.ts`
Expected: PASS (all existing roster tests plus the new ones).

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/services/roster.ts src/modules/admin/services/roster.test.ts
git commit -m "feat(roster): add changeMembershipKind with director-shift guard"
```

---

### Task 5: Person-page membership editor

**Files:**
- Create: `src/modules/admin/components/person-memberships-panel.tsx`
- Modify: `src/app/(app)/admin/people/[id]/page.tsx`

**Interfaces:**
- Consumes: `addMembership`, `removeMembership`, `changeMembershipKind`, the roster typed errors, `requirePermission`, `getActiveTerm`, `can`, `prisma`.
- Produces: `PersonMembershipsPanel({ personId, canManage, baseHref, rosterError })` server component. Renders an editable active-term section (add / change role / remove, only when `canManage`) and a read-only full history table. Its server actions re-check `admin.manage_roster`.

- [ ] **Step 1: Create the panel component**

Create `src/modules/admin/components/person-memberships-panel.tsx`:

```tsx
/**
 * PersonMembershipsPanel: manage a person's department assignments for the
 * ACTIVE term (add, change role, remove) plus a read-only history of all terms.
 *
 * Editing controls render only when canManage (admin.manage_roster); the server
 * actions re-check the permission. Mirrors the term RosterPanel pattern: server
 * component, GET-free forms, ConfirmButton for destructive actions.
 */

import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import {
  addMembership,
  removeMembership,
  changeMembershipKind,
  MembershipForeignKeyError,
  MembershipNotFoundError,
  DirectorHasShiftAssignmentsError,
} from "@/modules/admin/services/roster";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";

type Props = {
  personId: string;
  canManage: boolean;
  baseHref: string;
  rosterError?: string;
};

export async function PersonMembershipsPanel({
  personId,
  canManage,
  baseHref,
  rosterError,
}: Props): Promise<ReactNode> {
  const [activeTerm, memberships, departments] = await Promise.all([
    getActiveTerm(),
    prisma.termMembership.findMany({
      where: { personId },
      include: { term: true, department: true },
      orderBy: [{ term: { startDate: "desc" } }, { department: { code: "asc" } }],
    }),
    prisma.department.findMany({ where: { isActive: true }, orderBy: { code: "asc" } }),
  ]);

  const activeMembers = activeTerm
    ? memberships.filter((m) => m.termId === activeTerm.id && m.status === "ACTIVE")
    : [];

  async function addAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_roster");
    const term = await getActiveTerm();
    if (!term) redirect(`${baseHref}?rosterError=${encodeURIComponent("No active term.")}`);
    const departmentId = formData.get("departmentId") as string | null;
    const kindRaw = formData.get("kind");
    const kind = kindRaw === "DIRECTOR" || kindRaw === "VOLUNTEER" ? kindRaw : null;
    if (!departmentId || !kind) {
      redirect(`${baseHref}?rosterError=${encodeURIComponent("Department and role are required.")}`);
    }
    try {
      await addMembership(actor.personId, { personId, termId: term!.id, departmentId: departmentId!, kind });
    } catch (err) {
      if (err instanceof MembershipForeignKeyError) {
        redirect(`${baseHref}?rosterError=${encodeURIComponent(`Invalid reference: ${err.field}`)}`);
      }
      redirect(`${baseHref}?rosterError=${encodeURIComponent("Failed to add assignment.")}`);
    }
    redirect(`${baseHref}?saved=1`);
  }

  async function changeKindAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_roster");
    const membershipId = formData.get("membershipId") as string | null;
    const toKindRaw = formData.get("toKind");
    const toKind = toKindRaw === "DIRECTOR" || toKindRaw === "VOLUNTEER" ? toKindRaw : null;
    if (!membershipId || !toKind) {
      redirect(`${baseHref}?rosterError=${encodeURIComponent("Missing role change input.")}`);
    }
    try {
      await changeMembershipKind(actor.personId, { membershipId: membershipId!, toKind });
    } catch (err) {
      if (err instanceof DirectorHasShiftAssignmentsError) {
        redirect(
          `${baseHref}?rosterError=${encodeURIComponent("This member has director shift assignments this term. Remove or reassign those shifts before changing their role.")}`
        );
      }
      if (err instanceof MembershipNotFoundError) {
        redirect(`${baseHref}?rosterError=${encodeURIComponent("Membership no longer exists; the page may be stale.")}`);
      }
      redirect(`${baseHref}?rosterError=${encodeURIComponent("Failed to change role.")}`);
    }
    redirect(`${baseHref}?saved=1`);
  }

  async function removeAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_roster");
    const membershipId = formData.get("membershipId") as string | null;
    if (!membershipId) redirect(`${baseHref}?rosterError=${encodeURIComponent("Missing membership ID.")}`);
    try {
      await removeMembership(actor.personId, membershipId!);
    } catch (err) {
      if (err instanceof MembershipNotFoundError) {
        redirect(`${baseHref}?rosterError=${encodeURIComponent("Membership no longer exists; the page may be stale.")}`);
      }
      redirect(`${baseHref}?rosterError=${encodeURIComponent("Failed to remove assignment.")}`);
    }
    redirect(`${baseHref}?saved=1`);
  }

  return (
    <section className="space-y-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Memberships</h2>
      {rosterError && <Alert tone="error">{rosterError}</Alert>}

      {activeTerm ? (
        <Card className="space-y-4">
          <h3 className="text-sm font-semibold text-foreground-soft">Active term ({activeTerm.code})</h3>
          {activeMembers.length === 0 ? (
            <p className="text-sm text-subtle-foreground">No active-term assignments.</p>
          ) : (
            <div className="space-y-2">
              {activeMembers.map((m) => (
                <div
                  key={m.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2"
                >
                  <span className="text-sm font-medium text-foreground">{m.department.code}</span>
                  {m.kind === "DIRECTOR" ? <Badge tone="brand">Director</Badge> : <Badge tone="default">Volunteer</Badge>}
                  {canManage && (
                    <div className="ml-auto flex items-center gap-2">
                      <form action={changeKindAction} className="flex items-center gap-1">
                        <input type="hidden" name="membershipId" value={m.id} />
                        <input type="hidden" name="toKind" value={m.kind === "DIRECTOR" ? "VOLUNTEER" : "DIRECTOR"} />
                        <ConfirmButton
                          label={m.kind === "DIRECTOR" ? "Make volunteer" : "Make director"}
                          confirmLabel="Change this member's role? Confirm?"
                        />
                      </form>
                      <form action={removeAction}>
                        <input type="hidden" name="membershipId" value={m.id} />
                        <ConfirmButton label="Remove" confirmLabel="Remove assignment?" />
                      </form>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {canManage && (
            <form action={addAction} className="flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4">
              <Field label="Department">
                <Select name="departmentId" className="w-56">
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code} -- {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Role">
                <Select name="kind" className="w-36">
                  <option value="VOLUNTEER">Volunteer</option>
                  <option value="DIRECTOR">Director</option>
                </Select>
              </Field>
              <Button type="submit" variant="primary" size="sm">
                Add assignment
              </Button>
            </form>
          )}
        </Card>
      ) : (
        <p className="text-sm text-subtle-foreground">No active term.</p>
      )}

      {memberships.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-foreground-soft">History</h3>
          <Table>
            <THead>
              <TR>
                <TH>Term</TH>
                <TH>Department</TH>
                <TH>Kind</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <tbody>
              {memberships.map((m) => (
                <TR key={m.id}>
                  <TD>{m.term.code}</TD>
                  <TD>{m.department.code}</TD>
                  <TD>{m.kind === "DIRECTOR" ? <Badge tone="brand">Director</Badge> : <Badge tone="default">Volunteer</Badge>}</TD>
                  <TD>{m.status === "ACTIVE" ? <Badge tone="success">Active</Badge> : <Badge tone="default">Removed</Badge>}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Wire the panel into the person page**

In `src/app/(app)/admin/people/[id]/page.tsx`:

Replace the import on line 13 (`import { Table, THead, TR, TH, TD } from "@/platform/ui/table";`) with the two new imports:

```ts
import { can } from "@/platform/rbac/engine";
import { PersonMembershipsPanel } from "@/modules/admin/components/person-memberships-panel";
```

Change the `searchParams` type (line 18) to include `rosterError`:

```ts
  searchParams: Promise<{ error?: string; saved?: string; rosterError?: string }>;
```

Change line 22 from `await requirePermission("admin.manage_people");` to capture the session, and compute the flag right after the `person` is loaded (after line 27 `if (!person) notFound();`):

```ts
  const session = await requirePermission("admin.manage_people");
```

and (after the `if (!person) notFound();`):

```ts
  const canManageRoster = await can(session.personId, "admin.manage_roster");
```

Update the `searchParams` destructure (line 24) to include `rosterError`:

```ts
  const { error, saved, rosterError } = await searchParams;
```

Replace the entire memberships `<section>` block (the `{person.memberships.length > 0 && ( ... )}` section, lines 116-155) with:

```tsx
      <PersonMembershipsPanel
        personId={id}
        canManage={canManageRoster}
        baseHref={`/admin/people/${id}`}
        rosterError={rosterError}
      />
```

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no errors (in particular, no "Table is declared but never used" in the person page; the import was removed).
Run: `npx eslint src/app/\(app\)/admin/people/\[id\]/page.tsx src/modules/admin/components/person-memberships-panel.tsx`
Expected: clean.

- [ ] **Step 4: Manual smoke check against the local dev DB**

Run the dev server (`npm run dev`), sign in as the seeded Platform Admin, open `/admin/people/<a-member-id>`, and confirm: the active-term section shows the member's department(s) with role badges, an "Add assignment" form, "Make director/volunteer" and "Remove" buttons, and the read-only History table. Add a department, change a role, and remove one; confirm each persists and writes an audit row (`/admin/audit`).

- [ ] **Step 5: Commit**

```bash
git add "src/modules/admin/components/person-memberships-panel.tsx" "src/app/(app)/admin/people/[id]/page.tsx"
git commit -m "feat(admin): editable membership panel on the person page (admin.manage_roster)"
```

---

### Task 6: Re-gate the term roster panel onto `admin.manage_roster`

**Files:**
- Modify: `src/platform/auth/session.ts`
- Modify: `src/app/(app)/admin/terms/[id]/page.tsx`
- Modify: `src/modules/admin/components/roster-panel.tsx`

**Interfaces:**
- Produces: `requireAnyPermission(permissions: string[]): Promise<PersonSession>` (passes when the person holds any listed permission, else redirects to `/no-access`). The term page becomes viewable with `admin.manage_terms` OR `admin.manage_roster`; lifecycle and clinic-date controls render only with `manage_terms`; the roster panel mutations require `manage_roster`.

- [ ] **Step 1: Add the `requireAnyPermission` helper**

In `src/platform/auth/session.ts`, add after `requirePermission` (after line 87):

```ts
/**
 * Like requirePermission, but passes when the person holds ANY of the listed
 * permissions. Denied users land on /no-access. Used where one page serves two
 * audiences (e.g. the term page: term admins and roster managers).
 */
export async function requireAnyPermission(permissions: string[]): Promise<PersonSession> {
  const person = await requirePersonSession();
  for (const permission of permissions) {
    if (await can(person.personId, permission)) return person;
  }
  redirect("/no-access");
}
```

- [ ] **Step 2: Re-gate roster mutations to `admin.manage_roster`**

In `src/modules/admin/components/roster-panel.tsx`, change the three server-action permission checks from `admin.manage_terms` to `admin.manage_roster`:
- line 154 (`removeAction`): `const actorSession = await requirePermission("admin.manage_roster");`
- line 174 (`addAction`): `const actorSession = await requirePermission("admin.manage_roster");`
- line 209 (`copyRosterAction`): `const actorSession = await requirePermission("admin.manage_roster");`

- [ ] **Step 3: Open the term page to either permission and gate the term-only controls**

In `src/app/(app)/admin/terms/[id]/page.tsx`:

Update the imports (lines 1-2 area) to add the helper and `can`:

```ts
import { requirePermission, requireAnyPermission } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
```

Change the page guard (line 32) from:

```ts
  await requirePermission("admin.manage_terms");
```

to:

```ts
  const session = await requireAnyPermission(["admin.manage_terms", "admin.manage_roster"]);
  const canManageTerms = await can(session.personId, "admin.manage_terms");
```

Gate the Lifecycle section (the `<section>` containing `activateAction`/`archiveAction`, lines 176-195) and the Clinic dates section (lines 197-211) so they only render when `canManageTerms`. Wrap each with `{canManageTerms && ( ... )}`. For example, the Lifecycle section becomes:

```tsx
      {canManageTerms && (
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Lifecycle
          </h2>
          {term.status === "ACTIVE" ? (
            <form action={archiveAction}>
              <p className="mb-3 text-sm text-muted-foreground">
                Archiving this term will leave no active term. The engine handles the
                no-active-term state gracefully.
              </p>
              <ConfirmButton label="Archive" confirmLabel="Archive this term? Confirm?" />
            </form>
          ) : (
            <form action={activateAction}>
              <p className="mb-3 text-sm text-muted-foreground">{activateLabel}</p>
              <ConfirmButton label="Activate" confirmLabel={activateConfirmLabel} />
            </form>
          )}
        </section>
      )}
```

Apply the same `{canManageTerms && ( ... )}` wrapper around the Clinic dates `<section>`. Leave the `activateAction`, `archiveAction`, and `clinicDatesAction` definitions unchanged (they already re-check `admin.manage_terms`, which is correct defense in depth). The `<RosterPanel ... />` render stays unconditional.

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npx eslint "src/platform/auth/session.ts" "src/app/(app)/admin/terms/[id]/page.tsx" "src/modules/admin/components/roster-panel.tsx"`
Expected: clean.

- [ ] **Step 5: Run the full roster and rbac suites**

Run: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' npx vitest run src/modules/admin/services/roster.test.ts src/platform/rbac/engine.test.ts src/platform/rbac/system-roles.test.ts`
Expected: PASS.

- [ ] **Step 6: Manual smoke check**

With the dev server running: as Platform Admin, open `/admin/terms/<active-term-id>` and confirm Lifecycle, Clinic dates, and Roster all render and the roster add/remove/copy still work. To verify delegation, on `/admin/roles` create a custom role granting only `admin.manage_roster`, assign it to a test person, sign in as them, and confirm `/admin/terms/<id>` shows only the Roster panel (no Lifecycle or Clinic dates) and that roster edits work while `/admin/terms` term lifecycle is not actionable.

- [ ] **Step 7: Commit**

```bash
git add "src/platform/auth/session.ts" "src/app/(app)/admin/terms/[id]/page.tsx" "src/modules/admin/components/roster-panel.tsx"
git commit -m "feat(admin): term roster manageable via admin.manage_roster; term CRUD stays manage_terms"
```

---

## Final verification

- [ ] Run the whole affected test surface: `TEST_DATABASE_URL='postgresql://haven:haven_dev@localhost:5434/havenhub_test_rbac' npx vitest run src/platform/rbac src/modules/admin/services/roster.test.ts`
- [ ] `npx tsc --noEmit` is clean.
- [ ] `npm run build` succeeds (catches server/client boundary and route issues).
- [ ] Push the branch and open ONE PR (`feat/rbac-kind-decouple-assignment-editor`) covering both phases.

## Self-review against the spec (filled in)

- **Phase 1 decouple (engine + seed + backfill):** Tasks 1-2. The roles-page kind UI requirement is already satisfied on main (noted under Task 2).
- **`admin.manage_roster`, default holders, backfill incl. manage_terms holders:** Task 3.
- **`changeMembershipKind` + block-on-director-shifts + single audit:** Task 4.
- **Person-page editor, active-term scope, controls gated on manage_roster, read-only history:** Task 5.
- **Term page viewable by either permission, CRUD stays manage_terms, roster re-gated:** Task 6.
- **Onboarding gate preserved:** baseline access provisioned by the kind assignments (Task 2); the engine test suite (Task 1) and a fresh-member dev smoke (Task 5/6) exercise it. The seeded `Director`/`Volunteer` roles still grant `learning.access` / `my-info.access`.
- **No `schema.prisma` change** anywhere (the `RoleAssignment.kind` column already exists); all migrations are data-only and idempotent.
