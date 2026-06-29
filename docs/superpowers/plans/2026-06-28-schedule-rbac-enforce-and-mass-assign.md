# Schedule RBAC: enforce per-department permissions + mass role assignment by kind — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two declared-but-dead schedule permissions (`schedule.edit_own_dept`, `schedule.manage_requests`) confer real, department-scoped ability, and give admins a one-action way to assign any role to all volunteers or all directors for a term.

**Architecture:** Part A adds a `memberDepartmentIds` helper and extends the two schedule scope resolvers with permission-gated branches (`edit_own_dept` → edit scope, `manage_requests` → request-decision scope), leaving director-membership and `edit_all` behavior untouched; it also drops the now-meaningful `edit_own_dept` grant from the Director system role. Part B adds a third `kind` target to `RoleAssignment` (one row = "all VOLUNTEER/DIRECTOR members of a term get this role"), resolved in the RBAC engine and surfaced in the admin Roles UI.

**Tech Stack:** Next.js (App Router, server components + server actions), Prisma 6 / PostgreSQL 16, Vitest (integration tests against a real local test DB), TypeScript.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-28-enforce-schedule-permissions-design.md`. This plan implements it in full.
- **NEVER run `prisma migrate dev` / `npm run db:migrate` / `prisma db push`.** The repo `.env` points all DB URLs at the shared **Neon production** database; these commands would migrate or wipe it. Author every `migration.sql` **by hand** and apply it only to the local test DB with `npm run test:prepare` (which targets `${TEST_DATABASE_URL:-postgresql://haven:haven_dev@localhost:5434/havenhub_test}`).
- After editing `prisma/schema.prisma`, run `npx prisma generate` (reads the schema only, no DB write) so the Prisma client types pick up new fields.
- **Tests:** `npm test` runs the full suite; `npx vitest run <file>` runs one file; `npx vitest run <file> -t "<name>"` runs one test. `vitest.setup.ts` forces `DATABASE_URL` to the local test DB. Run `npm run test:prepare` once after adding/altering a migration so the test DB has it.
- **Typecheck:** `npm run typecheck`. **Lint:** `npm run lint`.
- **Prose/UI copy:** no em-dashes (project convention). Product name "HAVEN Hub" is two words in UI text; identifiers stay `havenhub`.
- **Migration timestamps must sort after the latest existing migration** `20260628130000_add_epic_deactivate_kind`. Use exactly the names given in each task.
- Commit after every task with the message shown.

---

## Part A — Enforce `schedule.edit_own_dept` and `schedule.manage_requests`

### Task A1: `memberDepartmentIds` helper

**Files:**
- Modify: `src/platform/departments.ts`
- Test: `src/platform/departments.test.ts` (exists; append)

**Interfaces:**
- Produces: `memberDepartmentIds(personId: string): Promise<string[]>` — department ids where the person holds an ACTIVE `TermMembership` of ANY kind in the ACTIVE term; `[]` when no active term.

- [ ] **Step 1: Write the failing test**

Append to `src/platform/departments.test.ts` (add `memberDepartmentIds` to the existing import from `./departments`):

```ts
describe("memberDepartmentIds", () => {
  it("returns active member departments of any kind in the active term", async () => {
    const term = await prisma.term.create({
      data: { code: `T-${Date.now()}`, name: "T", startDate: new Date("2026-01-01T12:00:00Z"), endDate: new Date("2026-04-30T12:00:00Z"), status: "ACTIVE" },
    });
    const person = await prisma.person.create({ data: { name: "M" } });
    const a = await prisma.department.create({ data: { code: `A-${Date.now()}`, name: "A" } });
    const b = await prisma.department.create({ data: { code: `B-${Date.now()}`, name: "B" } });
    const c = await prisma.department.create({ data: { code: `C-${Date.now()}`, name: "C" } });
    await prisma.termMembership.create({ data: { personId: person.id, termId: term.id, departmentId: a.id, kind: "VOLUNTEER" } });
    await prisma.termMembership.create({ data: { personId: person.id, termId: term.id, departmentId: b.id, kind: "DIRECTOR" } });
    await prisma.termMembership.create({ data: { personId: person.id, termId: term.id, departmentId: c.id, kind: "VOLUNTEER", status: "REMOVED" } });

    const ids = await memberDepartmentIds(person.id);
    expect(ids.sort()).toEqual([a.id, b.id].sort());
  });

  it("returns [] when there is no active term", async () => {
    const person = await prisma.person.create({ data: { name: "N" } });
    expect(await memberDepartmentIds(person.id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/departments.test.ts -t "memberDepartmentIds"`
Expected: FAIL with `memberDepartmentIds is not a function` (or import error).

- [ ] **Step 3: Write minimal implementation**

Append to `src/platform/departments.ts`:

```ts
/**
 * Returns the department ids where the person holds an ACTIVE TermMembership of
 * ANY kind (VOLUNTEER or DIRECTOR) in the ACTIVE term. This is the "own
 * departments" notion used to scope schedule.edit_own_dept and
 * schedule.manage_requests. Returns [] when there is no active term or the
 * person has no active membership.
 */
export async function memberDepartmentIds(personId: string): Promise<string[]> {
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  if (!activeTerm) return [];

  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId: activeTerm.id, status: "ACTIVE" },
    select: { departmentId: true },
  });

  return [...new Set(memberships.map((m) => m.departmentId))];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/departments.test.ts`
Expected: PASS (new + existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/departments.ts src/platform/departments.test.ts
git commit -m "feat(rbac): add memberDepartmentIds helper for schedule own-dept scoping (#82)"
```

---

### Task A2: Extend the schedule **edit** scope with the `edit_own_dept` branch

**Files:**
- Modify: `src/modules/schedule/services/builder.ts:89-102` (`manageableScheduleDepartmentIds`)
- Test: `src/modules/schedule/services/builder.test.ts` (exists; append)

**Interfaces:**
- Consumes: `memberDepartmentIds` (Task A1), `can` (existing), `manageableDepartmentIds` (existing).
- Produces: `manageableScheduleDepartmentIds(personId)` unchanged signature; now also includes member departments when the person holds `schedule.edit_own_dept`. This propagates to all builder mutations, the builder page gate, the nav tab, and attendings (unified, intended).

- [ ] **Step 1: Write the failing test**

Append to `src/modules/schedule/services/builder.test.ts` (the file already has `createTerm`, `createDepartment`, `createPerson`, `createMembership`, and `grantPermission` helpers and imports `manageableScheduleDepartmentIds`; reuse them — check the top of the file for exact helper names and mirror them):

```ts
describe("manageableScheduleDepartmentIds — edit_own_dept", () => {
  it("includes member departments when the person holds schedule.edit_own_dept", async () => {
    const term = await createTerm("ACTIVE", []);
    const dept = await createDepartment("OWND");
    const person = await createPerson("Coordinator");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(person.id, "schedule.edit_own_dept");

    const ids = await manageableScheduleDepartmentIds(person.id);
    expect(ids).toContain(dept.id);
  });

  it("does NOT include member departments without schedule.edit_own_dept", async () => {
    const term = await createTerm("ACTIVE", []);
    const dept = await createDepartment("NOPE");
    const person = await createPerson("PlainVol");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER");

    const ids = await manageableScheduleDepartmentIds(person.id);
    expect(ids).not.toContain(dept.id);
  });
});
```

> Note: if the helper names at the top of `builder.test.ts` differ (e.g. `createTerm` takes different args), adapt these three calls to match the existing helpers in that file. Do not introduce new helpers.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/schedule/services/builder.test.ts -t "edit_own_dept"`
Expected: FAIL — first test asserts `toContain(dept.id)` but the current resolver omits member depts.

- [ ] **Step 3: Write minimal implementation**

In `src/modules/schedule/services/builder.ts`, add `memberDepartmentIds` to the departments import:

```ts
import { manageableDepartmentIds, memberDepartmentIds } from "@/platform/departments";
```

Replace the body of `manageableScheduleDepartmentIds` (lines 89-102) with:

```ts
export async function manageableScheduleDepartmentIds(personId: string): Promise<string[]> {
  const [base, editOwnDept, editAll] = await Promise.all([
    manageableDepartmentIds(personId),
    can(personId, "schedule.edit_own_dept"),
    can(personId, "schedule.edit_all"),
  ]);

  const ids = new Set<string>(base);

  // edit_own_dept: extend to departments the person is an active member of.
  if (editOwnDept) {
    for (const id of await memberDepartmentIds(personId)) ids.add(id);
  }

  // edit_all: union with every department in the DB.
  if (editAll) {
    const all = await prisma.department.findMany({ select: { id: true } });
    for (const d of all) ids.add(d.id);
  }

  return [...ids];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/schedule/services/builder.test.ts`
Expected: PASS (new + existing builder tests, including the existing `edit_all` and dedup cases).

- [ ] **Step 5: Commit**

```bash
git add src/modules/schedule/services/builder.ts src/modules/schedule/services/builder.test.ts
git commit -m "feat(schedule): enforce schedule.edit_own_dept in builder edit scope (#82)"
```

---

### Task A3: Add the **request-decision** scope resolver gated on `manage_requests`

**Files:**
- Modify: `src/modules/schedule/services/requests.ts` (imports, new `manageableRequestDepartmentIds` + `canManageRequestsForDept`, rewrite `scopeCheck` at 116-125)
- Test: `src/modules/schedule/services/requests.test.ts` (exists; append)

**Interfaces:**
- Consumes: `memberDepartmentIds` (A1), `can`, `manageableDepartmentIds`, `prisma` (all already imported in this file).
- Produces:
  - `manageableRequestDepartmentIds(personId: string): Promise<string[]>`
  - `canManageRequestsForDept(personId: string, departmentId: string): Promise<boolean>` (consumed by Task A5)
  - `scopeCheck` now consults request scope (manageable ∪ `manage_requests`-member ∪ `edit_all`).

- [ ] **Step 1: Write the failing test**

Append to `src/modules/schedule/services/requests.test.ts` (reuse its existing `createTerm`, `createDepartment`, `createPerson`, `createMembership`, `createShift`, `grantPermission` helpers; `listDepartmentRequests` and `RequestForbiddenError` are already imported):

```ts
describe("manage_requests scope", () => {
  it("lets a non-director with schedule.manage_requests list a member department's requests", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("MRQ1");
    const actor = await createPerson("ReqMgr");
    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(actor.id, "schedule.manage_requests");

    // Should not throw (returns [] when there are no requests).
    await expect(listDepartmentRequests(actor.id, dept.id)).resolves.toEqual([]);
  });

  it("forbids a member without schedule.manage_requests", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("MRQ2");
    const actor = await createPerson("PlainMember");
    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");

    await expect(listDepartmentRequests(actor.id, dept.id)).rejects.toBeInstanceOf(RequestForbiddenError);
  });

  it("schedule.edit_own_dept alone does NOT grant request decisions", async () => {
    const dates = sixSaturdays();
    const term = await createTerm("ACTIVE", dates);
    const dept = await createDepartment("MRQ3");
    const actor = await createPerson("EditOnly");
    await createMembership(actor.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(actor.id, "schedule.edit_own_dept");

    await expect(listDepartmentRequests(actor.id, dept.id)).rejects.toBeInstanceOf(RequestForbiddenError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/schedule/services/requests.test.ts -t "manage_requests scope"`
Expected: FAIL — the first test throws `RequestForbiddenError` because today only director membership / `edit_all` is consulted.

- [ ] **Step 3: Write minimal implementation**

In `src/modules/schedule/services/requests.ts`, extend the departments import:

```ts
import { manageableDepartmentIds, memberDepartmentIds } from "@/platform/departments";
```

Replace the `scopeCheck` function (lines 116-125) with the resolver, the page helper, and a rewritten `scopeCheck`:

```ts
/**
 * Departments the actor may decide requests for: director membership +
 * one-hop delegation, UNION member departments when the actor holds
 * schedule.manage_requests, UNION all departments when schedule.edit_all.
 */
export async function manageableRequestDepartmentIds(personId: string): Promise<string[]> {
  const [base, manageRequests, editAll] = await Promise.all([
    manageableDepartmentIds(personId),
    can(personId, "schedule.manage_requests"),
    can(personId, "schedule.edit_all"),
  ]);

  const ids = new Set<string>(base);

  if (manageRequests) {
    for (const id of await memberDepartmentIds(personId)) ids.add(id);
  }

  if (editAll) {
    const all = await prisma.department.findMany({ select: { id: true } });
    for (const d of all) ids.add(d.id);
  }

  return [...ids];
}

/** True when the actor may decide requests for the given department. */
export async function canManageRequestsForDept(
  personId: string,
  departmentId: string,
): Promise<boolean> {
  return (await manageableRequestDepartmentIds(personId)).includes(departmentId);
}

/**
 * Checks that actor may decide requests for the given department.
 * Throws RequestForbiddenError if not.
 */
async function scopeCheck(actorPersonId: string, departmentId: string): Promise<void> {
  if (!(await canManageRequestsForDept(actorPersonId, departmentId))) {
    throw new RequestForbiddenError();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/schedule/services/requests.test.ts`
Expected: PASS (new + existing request tests, including the existing director and `edit_all` cases).

- [ ] **Step 5: Commit**

```bash
git add src/modules/schedule/services/requests.ts src/modules/schedule/services/requests.test.ts
git commit -m "feat(schedule): enforce schedule.manage_requests for request decisions (#82)"
```

---

### Task A4: Drop `schedule.edit_own_dept` from the Director system role + backfill migration

**Files:**
- Modify: `src/platform/rbac/system-roles.ts:24`
- Create: `prisma/migrations/20260628140000_drop_director_edit_own_dept_grant/migration.sql`
- Modify: `src/platform/rbac/system-roles.test.ts` (add a negative assertion)
- Modify: `src/platform/rbac/engine.test.ts` (swap the `schedule.edit_own_dept` canary)

**Interfaces:**
- Produces: Director system-role grant list no longer contains `schedule.edit_own_dept`. No code reads the Director grant for `edit_own_dept` anymore; directors keep their abilities via `manageableDepartmentIds`.

- [ ] **Step 1: Write the failing test**

Add to `src/platform/rbac/system-roles.test.ts` inside the `describe("system roles", ...)` block:

```ts
  // Issue #82: edit_own_dept is now enforced as a member-department grant. It was
  // a no-op on the auto-attached Director role; leaving it would silently widen
  // directors' edit reach to their non-director memberships. Directors keep their
  // scope via director membership, so the grant is removed.
  it("does not grant the Director role schedule.edit_own_dept", () => {
    expect(grantsFor("Director")).not.toContain("schedule.edit_own_dept");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/rbac/system-roles.test.ts`
Expected: FAIL — Director currently grants `schedule.edit_own_dept`.

- [ ] **Step 3: Write minimal implementation**

In `src/platform/rbac/system-roles.ts`, change the Director grants (line 24) from:

```ts
    grants: ["schedule.view", "schedule.edit_own_dept", "volunteers.view", "my-info.access", "learning.access"],
```

to:

```ts
    grants: ["schedule.view", "volunteers.view", "my-info.access", "learning.access"],
```

Create `prisma/migrations/20260628140000_drop_director_edit_own_dept_grant/migration.sql`:

```sql
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
```

Now update the `engine.test.ts` canary so it does not imply `edit_own_dept` is a Director grant. In `src/platform/rbac/engine.test.ts`:

- Line 35, change the Director fixture grants to:

```ts
      grants: { create: [{ permission: "schedule.view" }, { permission: "volunteers.view" }] },
```

- Line 69, change to:

```ts
    expect(await can(person.id, "volunteers.view")).toBe(true);
```

- Line 106, change to:

```ts
    expect(await can(person.id, "volunteers.view")).toBe(false);
```

- Line 118, change to:

```ts
    expect(perms.has("volunteers.view")).toBe(false);
```

- [ ] **Step 4: Apply the migration to the test DB and run tests**

Run: `npm run test:prepare`
Then: `npx vitest run src/platform/rbac/system-roles.test.ts src/platform/rbac/engine.test.ts`
Expected: PASS for both files.

- [ ] **Step 5: Commit**

```bash
git add src/platform/rbac/system-roles.ts src/platform/rbac/system-roles.test.ts src/platform/rbac/engine.test.ts prisma/migrations/20260628140000_drop_director_edit_own_dept_grant
git commit -m "fix(rbac): drop no-op schedule.edit_own_dept grant from Director role (#82)"
```

---

### Task A5: Builder page — render the requests panel only with request scope

**Files:**
- Modify: `src/app/(app)/schedule/builder/page.tsx` (import, line 146 request load, lines 818-822 panel render)

**Interfaces:**
- Consumes: `canManageRequestsForDept` (Task A3), `listDepartmentRequests` (existing).

This is server-component wiring (no unit test harness for pages in this repo); verification is via typecheck + the Task A3 service tests + manual check.

- [ ] **Step 1: Add the import**

In `src/app/(app)/schedule/builder/page.tsx`, the requests imports currently include `listDepartmentRequests, approveRequest, denyRequest` from `@/modules/schedule/services/requests`. Add `canManageRequestsForDept` to that import list:

```ts
import {
  listDepartmentRequests,
  approveRequest,
  denyRequest,
  canManageRequestsForDept,
} from "@/modules/schedule/services/requests";
```

(Keep any other members already in that import statement; only add `canManageRequestsForDept`.)

- [ ] **Step 2: Gate the request load (line 146)**

Replace:

```ts
  const requestRows = await listDepartmentRequests(session.personId, dept.id);
```

with:

```ts
  const canManageRequests = await canManageRequestsForDept(session.personId, dept.id);
  const requestRows = canManageRequests
    ? await listDepartmentRequests(session.personId, dept.id)
    : [];
```

- [ ] **Step 3: Gate the panel render (lines ~818-822)**

Replace:

```tsx
              <PendingRequests
                rows={requestRows}
                approveAction={approveRequestAction}
                denyAction={denyRequestAction}
              />
```

with:

```tsx
              {canManageRequests && (
                <PendingRequests
                  rows={requestRows}
                  approveAction={approveRequestAction}
                  denyAction={denyRequestAction}
                />
              )}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/schedule/builder/page.tsx"
git commit -m "fix(schedule): show builder requests panel only with manage_requests scope (#82)"
```

---

## Part B — Mass role assignment by membership kind

### Task B1: Schema + migration for the `kind` assignment target

**Files:**
- Modify: `prisma/schema.prisma` (`RoleAssignment` model)
- Create: `prisma/migrations/20260628150000_role_assignment_kind_target/migration.sql`
- Test: `src/platform/rbac/schema-guards.test.ts` (exists; append)

**Interfaces:**
- Produces: `RoleAssignment.kind: MembershipKind | null`; DB enforces "exactly one of personId / departmentId / kind"; the duplicate-grant unique index spans kind.

- [ ] **Step 1: Write the failing test**

Append two cases to `src/platform/rbac/schema-guards.test.ts` (it already has a `fixture()` returning `{ role, person }`):

```ts
  it("rejects assignments with two targets set (3-way XOR)", async () => {
    const { role, person } = await fixture();
    const dept = await prisma.department.create({ data: { code: "XOR", name: "X" } });
    await expect(
      prisma.roleAssignment.create({
        data: { roleId: role.id, personId: person.id, departmentId: dept.id },
      })
    ).rejects.toThrow();
  });

  it("rejects duplicate kind-target assignments (unique_grant spans kind)", async () => {
    const { role } = await fixture();
    await prisma.roleAssignment.create({ data: { roleId: role.id, kind: "VOLUNTEER", termId: null } });
    await expect(
      prisma.roleAssignment.create({ data: { roleId: role.id, kind: "VOLUNTEER", termId: null } })
    ).rejects.toThrow();
  });
```

- [ ] **Step 2: Update the schema**

In `prisma/schema.prisma`, in the `RoleAssignment` model add the `kind` field (after `departmentId`) and an index, and update the doc comment above the model:

```prisma
/// Exactly one of personId / departmentId / kind is set. termId null = global scope.
/// DB-LEVEL GUARDS LIVE IN RAW SQL (see migrations): a COALESCE unique index
/// (duplicate grants) and a CHECK constraint (target = exactly one). Guarded by
/// src/platform/rbac/schema-guards.test.ts. Never resolve a prisma migrate
/// diff by accepting a DROP of objects you do not recognize.
model RoleAssignment {
  id           String          @id @default(cuid())
  roleId       String
  personId     String?
  departmentId String?
  kind         MembershipKind?
  termId       String?
  role         Role        @relation(fields: [roleId], references: [id], onDelete: Cascade)
  person       Person?     @relation(fields: [personId], references: [id], onDelete: Cascade)
  department   Department? @relation(fields: [departmentId], references: [id], onDelete: Restrict)
  term         Term?       @relation(fields: [termId], references: [id], onDelete: Restrict)

  @@index([personId])
  @@index([departmentId])
  @@index([kind])
  @@index([termId])
}
```

Then run: `npx prisma generate`
Expected: client regenerates; `RoleAssignment` now has a `kind` field.

- [ ] **Step 3: Author the migration**

Create `prisma/migrations/20260628150000_role_assignment_kind_target/migration.sql`:

```sql
-- Part B (spec 2026-06-28): add a third assignment target "kind" so a single
-- RoleAssignment row can target all VOLUNTEER or all DIRECTOR members of a term.

-- 1. The kind column (nullable enum).
ALTER TABLE "RoleAssignment" ADD COLUMN "kind" "MembershipKind";

-- 2. Replace the 2-way person/department XOR with a 3-way exactly-one check.
ALTER TABLE "RoleAssignment" DROP CONSTRAINT "RoleAssignment_target_xor";
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_target_xor"
  CHECK (
    (("personId" IS NOT NULL)::int + ("departmentId" IS NOT NULL)::int + ("kind" IS NOT NULL)::int) = 1
  );

-- 3. Rebuild the duplicate-grant expression index to include kind (enum cast to
--    text; COALESCE sentinels for NULLs). Equivalent to UNIQUE NULLS NOT DISTINCT
--    over (roleId, personId, departmentId, kind, termId).
DROP INDEX "RoleAssignment_unique_grant";
CREATE UNIQUE INDEX "RoleAssignment_unique_grant"
  ON "RoleAssignment" (
    "roleId",
    COALESCE("personId", ''),
    COALESCE("departmentId", ''),
    COALESCE("kind"::text, ''),
    COALESCE("termId", '')
  );

-- 4. Index for kind-target resolution.
CREATE INDEX "RoleAssignment_kind_idx" ON "RoleAssignment"("kind");
```

- [ ] **Step 4: Apply to the test DB and run the guard tests**

Run: `npm run test:prepare`
Then: `npx vitest run src/platform/rbac/schema-guards.test.ts`
Expected: PASS (existing XOR + duplicate cases and the two new cases). The existing "neither target set" test still throws because the 3-way sum is 0.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260628150000_role_assignment_kind_target src/platform/rbac/schema-guards.test.ts
git commit -m "feat(rbac): add kind assignment target to RoleAssignment (schema + guards)"
```

---

### Task B2: Engine resolves the `kind` assignment arm

**Files:**
- Modify: `src/platform/rbac/engine.ts:18-63` (`getEffectivePermissions`)
- Test: `src/platform/rbac/engine.test.ts` (exists; append)

**Interfaces:**
- Consumes: `RoleAssignment.kind` (Task B1).
- Produces: a person picks up grants from `RoleAssignment` rows whose `kind` matches any of their active-term membership kinds (subject to the existing term filter).

- [ ] **Step 1: Write the failing test**

Append to `src/platform/rbac/engine.test.ts` inside `describe("rbac engine", ...)` (the `fixture()` already creates `term`, `oldTerm`, `vadm`, `recruiterRole`):

```ts
  it("grants kind-target assignments to active members of that kind", async () => {
    const f = await fixture();
    const vol = await prisma.person.create({ data: { name: "Vol" } });
    const dir = await prisma.person.create({ data: { name: "Dir" } });
    await prisma.termMembership.create({ data: { personId: vol.id, termId: f.term.id, departmentId: f.vadm.id, kind: "VOLUNTEER" } });
    await prisma.termMembership.create({ data: { personId: dir.id, termId: f.term.id, departmentId: f.vadm.id, kind: "DIRECTOR" } });
    await prisma.roleAssignment.create({ data: { roleId: f.recruiterRole.id, kind: "VOLUNTEER", termId: f.term.id } });

    expect(await can(vol.id, "recruitment.manage_cycle")).toBe(true);
    expect(await can(dir.id, "recruitment.manage_cycle")).toBe(false);
  });

  it("ignores a kind-target assignment scoped to a non-active term", async () => {
    const f = await fixture();
    const vol = await prisma.person.create({ data: { name: "Vol2" } });
    await prisma.termMembership.create({ data: { personId: vol.id, termId: f.term.id, departmentId: f.vadm.id, kind: "VOLUNTEER" } });
    await prisma.roleAssignment.create({ data: { roleId: f.recruiterRole.id, kind: "VOLUNTEER", termId: f.oldTerm.id } });

    expect(await can(vol.id, "recruitment.manage_cycle")).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/rbac/engine.test.ts -t "kind-target"`
Expected: FAIL — the engine does not yet resolve the `kind` arm, so the volunteer lacks the grant.

- [ ] **Step 3: Write minimal implementation**

In `src/platform/rbac/engine.ts`, after the `departmentIds` / `autoRoleNames` lines (around line 27-28) add:

```ts
    const membershipKinds = [...new Set(memberships.map((m) => m.kind))];
```

Then in the `prisma.roleAssignment.findMany` call, extend the inner target `OR` (currently `personId` + `departmentId`) to include the kind arm:

```ts
            {
              OR: [
                { personId },
                ...(departmentIds.length ? [{ departmentId: { in: departmentIds } }] : []),
                ...(membershipKinds.length ? [{ kind: { in: membershipKinds } }] : []),
              ],
            },
```

(The outer `termId` filter is unchanged, so a kind-target row applies only when global or scoped to the active term.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/rbac/engine.test.ts`
Expected: PASS (new + existing engine tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/rbac/engine.ts src/platform/rbac/engine.test.ts
git commit -m "feat(rbac): resolve kind-target role assignments in the engine"
```

---

### Task B3: `createAssignment` accepts `kind` (3-way XOR + validation + audit)

**Files:**
- Modify: `src/modules/admin/services/rbac.ts` (imports, `createAssignment` 340-405, `deleteAssignment` audit snapshot)
- Test: `src/modules/admin/services/rbac.test.ts` (exists; append)

**Interfaces:**
- Consumes: `RoleAssignment.kind` (B1).
- Produces: `createAssignment(actor, { roleId, personId?, departmentId?, kind?, termId? })` — exactly one of personId/departmentId/kind required; invalid kind rejected with `AssignmentTargetError`; duplicate kind-target raises `DuplicateAssignmentError`.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/admin/services/rbac.test.ts` inside `describe("createAssignment", ...)` (uses `ACTOR`, `seedRole`, `seedTerm`):

```ts
  it("creates a kind-target assignment", async () => {
    const role = await seedRole("R");
    const term = await seedTerm("T");
    await createAssignment(ACTOR, { roleId: role.id, kind: "VOLUNTEER", termId: term.id });

    const assignments = await prisma.roleAssignment.findMany();
    expect(assignments).toHaveLength(1);
    expect(assignments[0].kind).toBe("VOLUNTEER");
    expect(assignments[0].personId).toBeNull();
    expect(assignments[0].departmentId).toBeNull();
  });

  it("throws AssignmentTargetError when a person and a kind are both set", async () => {
    const role = await seedRole("R");
    const person = await seedPerson("P");
    await expect(
      createAssignment(ACTOR, { roleId: role.id, personId: person.id, kind: "VOLUNTEER" })
    ).rejects.toBeInstanceOf(AssignmentTargetError);
  });

  it("throws AssignmentTargetError for an invalid kind", async () => {
    const role = await seedRole("R");
    await expect(
      // @ts-expect-error invalid kind on purpose
      createAssignment(ACTOR, { roleId: role.id, kind: "BOGUS" })
    ).rejects.toBeInstanceOf(AssignmentTargetError);
  });

  it("throws DuplicateAssignmentError for a duplicate kind-target", async () => {
    const role = await seedRole("R");
    await createAssignment(ACTOR, { roleId: role.id, kind: "DIRECTOR" });
    await expect(
      createAssignment(ACTOR, { roleId: role.id, kind: "DIRECTOR" })
    ).rejects.toBeInstanceOf(DuplicateAssignmentError);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/admin/services/rbac.test.ts -t "kind"`
Expected: FAIL — `createAssignment` does not accept `kind` yet (the kind-target row is never created; XOR rejects it as "neither set").

- [ ] **Step 3: Write minimal implementation**

In `src/modules/admin/services/rbac.ts`, add `MembershipKind` to the type import (line 15):

```ts
import type { Role, RoleGrant, RoleAssignment, Person, Department, Term, MembershipKind } from "@prisma/client";
```

Replace the `createAssignment` signature + XOR block (lines ~340-363) with:

```ts
export async function createAssignment(
  actorPersonId: string,
  input: {
    roleId: string;
    personId?: string;
    departmentId?: string;
    kind?: MembershipKind;
    termId?: string;
  }
): Promise<RoleAssignment> {
  const targetCount =
    (input.personId != null ? 1 : 0) +
    (input.departmentId != null ? 1 : 0) +
    (input.kind != null ? 1 : 0);

  if (targetCount === 0) {
    throw new AssignmentTargetError(
      "exactly one of personId, departmentId, or kind must be set; none was provided"
    );
  }
  if (targetCount > 1) {
    throw new AssignmentTargetError(
      "exactly one of personId, departmentId, or kind must be set; multiple were provided"
    );
  }
  if (input.kind != null && input.kind !== "DIRECTOR" && input.kind !== "VOLUNTEER") {
    throw new AssignmentTargetError(`invalid membership kind: ${input.kind}`);
  }
```

In the same function's `prisma.roleAssignment.create` data block, add `kind`:

```ts
      data: {
        roleId: input.roleId,
        personId: input.personId ?? null,
        departmentId: input.departmentId ?? null,
        kind: input.kind ?? null,
        termId: input.termId ?? null,
      },
```

In the audit `after` payload for create, add `kind: assignment.kind`:

```ts
    after: {
      personId: assignment.personId,
      departmentId: assignment.departmentId,
      kind: assignment.kind,
      termId: assignment.termId,
    },
```

In `deleteAssignment`, add `kind` to the audit `before` snapshot:

```ts
    before: {
      roleId: assignment.roleId,
      personId: assignment.personId,
      departmentId: assignment.departmentId,
      kind: assignment.kind,
      termId: assignment.termId,
    },
```

> The existing "both personId and departmentId set" test (two targets) still throws because `targetCount > 1`. The existing P2002 → `DuplicateAssignmentError` and P2003 → `AssignmentTargetError` handling is unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/admin/services/rbac.test.ts`
Expected: PASS (new + existing assignment tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/services/rbac.ts src/modules/admin/services/rbac.test.ts
git commit -m "feat(rbac): support kind-target in createAssignment with 3-way XOR validation"
```

---

### Task B4: Admin UI — "Assign role to all Volunteers/Directors" + table rendering

**Files:**
- Modify: `src/modules/admin/components/assignment-form.tsx` (imports, new `assignKindAction`, kind card, table target rendering)

**Interfaces:**
- Consumes: `createAssignment` with `kind` (B3), `MembershipKind` type, the `terms` prop already passed (includes `status`).

This is server-component + server-action wiring; verify via typecheck and manual check. No page-level unit harness exists.

- [ ] **Step 1: Add the type import**

In `src/modules/admin/components/assignment-form.tsx`, extend the prisma type import (line 16) to include `MembershipKind`:

```ts
import type { Role, RoleAssignment, Person, Department, Term, MembershipKind } from "@prisma/client";
```

- [ ] **Step 2: Add the `assignKindAction` server action**

After the existing `assignDepartmentAction` function (ends ~line 179), add:

```tsx
  async function assignKindAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_roles");
    const kind = formData.get("kind") as string | null;
    const roleId = formData.get("roleId") as string | null;
    const termIdRaw = formData.get("termId") as string | null;
    const termId = termIdRaw && termIdRaw !== "" ? termIdRaw : undefined;

    if (!kind || !roleId) {
      redirect(`${pageHref}?rbacError=${encodeURIComponent("Members and role are required.")}`);
    }
    if (kind !== "VOLUNTEER" && kind !== "DIRECTOR") {
      redirect(`${pageHref}?rbacError=${encodeURIComponent("Invalid member kind.")}`);
    }

    try {
      await createAssignment(actor.personId, { roleId: roleId!, kind: kind as MembershipKind, termId });
    } catch (err) {
      if (err instanceof AssignmentTargetError || err instanceof DuplicateAssignmentError) {
        redirect(`${pageHref}?rbacError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`${pageHref}?saved=1`);
  }
```

- [ ] **Step 3: Render the kind target in the assignments table**

In the table body, the target cell currently branches `a.person ? ... : a.department ? ... : Unknown`. Insert a `kind` branch before the `Unknown` fallback (after the `a.department` branch, around lines 212-219):

```tsx
                  ) : a.kind ? (
                    <span className="flex items-center gap-2">
                      <Badge tone="brand">
                        {a.kind === "DIRECTOR" ? "All Directors" : "All Volunteers"}
                      </Badge>
                    </span>
                  ) : (
```

(Keep the existing `<span className="text-subtle-foreground">Unknown</span>` as the final fallback.)

- [ ] **Step 4: Add the kind-assignment card**

Compute the active term id near the top of the render (just before the `return (`):

```tsx
  const activeTermId = terms.find((t) => t.status === "ACTIVE")?.id ?? "";
```

After the "Assign role to department" `Card` (ends ~line 360), add a third card:

```tsx
      {/* Create kind (cohort) assignment */}
      <Card className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground-soft">Assign role to all members of a kind</h3>
        <p className="text-sm text-subtle-foreground">
          Applies to every active member of the chosen kind in the selected term, including members added later.
        </p>
        <form action={assignKindAction} className="flex flex-wrap items-end gap-3">
          <Field label="Members">
            <Select name="kind" className="w-44">
              <option value="VOLUNTEER">All Volunteers</option>
              <option value="DIRECTOR">All Directors</option>
            </Select>
          </Field>
          <Field label="Role">
            <Select name="roleId" className="w-44">
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Term">
            <Select name="termId" defaultValue={activeTermId} className="w-36">
              <option value="">Global</option>
              {terms.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary" size="sm">
            Assign cohort
          </Button>
        </form>
      </Card>
```

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add "src/modules/admin/components/assignment-form.tsx"
git commit -m "feat(admin): assign a role to all volunteers or directors for a term"
```

---

## Final verification

- [ ] **Step 1: Apply migrations to the test DB (idempotent)**

Run: `npm run test:prepare`
Expected: both new migrations report applied (or already applied).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no new errors in the touched files.

- [ ] **Step 5: Manual smoke (optional but recommended)**

On `/admin/roles`: create a role granting `schedule.edit_own_dept` + `schedule.manage_requests`, assign it to "All Volunteers" for the current term, then confirm a non-director volunteer sees the Builder with their member department editable and (because the role also has `manage_requests`) the requests panel visible. Confirm a volunteer with only `edit_own_dept` sees the Builder but NOT the requests panel.

---

## Self-Review

**Spec coverage:**
- Part A.1 `memberDepartmentIds` → Task A1. ✓
- Part A.2 edit scope branch → Task A2. ✓
- Part A.2 request scope branch + `scopeCheck` rewrite → Task A3. ✓
- Part A.3 Director grant removal + migration + seed-via-SYSTEM_ROLES → Task A4. ✓
- Part A.4 builder conditional panel → Task A5. ✓
- Part B.1 schema → Task B1. ✓
- Part B.2 migration (column, 3-way XOR, rebuilt unique index, kind index) → Task B1. ✓
- Part B.3 engine kind arm → Task B2. ✓
- Part B.4 service createAssignment kind + validation + audit → Task B3. ✓
- Part B.5 UI form + table + active-term default → Task B4 (active term computed in-form from the existing `terms` prop, so `roles/page.tsx` needs no change). ✓
- Testing section items map to the test steps in A1-A4, B1-B3 and the manual smoke for the two UI tasks. ✓

**Placeholder scan:** No TBD/TODO; every code step shows the actual code. Migration names and timestamps are exact.

**Type consistency:** `memberDepartmentIds` (A1) consumed by A2/A3; `canManageRequestsForDept` / `manageableRequestDepartmentIds` (A3) consumed by A5; `RoleAssignment.kind: MembershipKind?` (B1) consumed by B2/B3/B4; `createAssignment({..., kind})` (B3) consumed by B4. Names match across tasks.

**Note for the executor:** Several test steps say "reuse the existing helpers at the top of the file." Always open the target test file first and match its actual helper names/signatures (they were verified present during planning: `createTerm`/`createDepartment`/`createPerson`/`createMembership`/`createShift`/`grantPermission` in the schedule test files; `seedRole`/`seedPerson`/`seedDepartment`/`seedTerm`/`ACTOR` in `rbac.test.ts`; `sixSaturdays` in `requests.test.ts`). Do not invent new helpers.
