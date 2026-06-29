# Schedule RBAC: enforce per-department permissions + mass role assignment by kind

**Issue:** [#82](https://github.com/HAVEN-Free-Clinic/HAVENHub/issues/82) (2026-06-27 full-app audit, `schedule/unused-schedule-permissions`) plus a companion mass-assignment enhancement.
**Date:** 2026-06-28
**Branch:** `fix/schedule-enforce-permissions`

This is one combined effort shipping in a single branch/PR:

- **Part A** — enforce the two dead schedule permissions (`schedule.edit_own_dept`, `schedule.manage_requests`) so granting them confers real, scoped ability (issue #82).
- **Part B** — let admins attach *any* role to all volunteers or all directors for a term in one action (a new membership-kind assignment target). Part A is only useful at scale if a role bearing the newly-live permissions can be granted to a whole cohort; Part B is that delivery mechanism.

---

## Part A — Enforce `schedule.edit_own_dept` and `schedule.manage_requests`

### Problem

The schedule manifest (`src/platform/modules/registry.ts:23-28`) declares `schedule.view`,
`schedule.edit_own_dept`, `schedule.edit_all`, `schedule.manage_requests`. All four are
grantable in the admin Roles UI, and `VALID_PERMISSIONS` in the RBAC service is built from the
same list. But write/approve gating never reads `edit_own_dept` or `manage_requests`:

- `builder.ts:manageableScheduleDepartmentIds` (edit scope) = `manageableDepartmentIds(person)` ∪ (`schedule.edit_all` ? all departments : none).
- `requests.ts:scopeCheck` (decision gating) = the same union, inline.
- `manageableDepartmentIds` (`departments.ts:21-55`) requires an ACTIVE DIRECTOR `TermMembership` in the active term.

So granting `edit_own_dept` (held today only via the auto-attached Director role) or
`manage_requests` (granted by nothing) confers nothing. The model fails closed (no escalation)
but the admin UI advertises capabilities the code ignores, and there is no per-department path
short of `schedule.edit_all` (which grants ALL departments).

### Design

**1. "Own departments" helper.** Add `memberDepartmentIds(personId): Promise<string[]>` to
`src/platform/departments.ts`: departments where the person holds an ACTIVE `TermMembership` of
**any kind** in the active term. `[]` when no active term. This is the "own department" notion
for a non-director.

**2. Two additive, permission-gated scopes.** Both keep the existing director path
(`manageableDepartmentIds` = director membership + one-hop delegation) untouched and ADD a
permission-gated branch; they differ only in which permission extends them.

Edit scope — `manageableScheduleDepartmentIds(person)` in `builder.ts` becomes the dedup'd union of:

1. `manageableDepartmentIds(person)` — unchanged
2. `memberDepartmentIds(person)` when `can(person, "schedule.edit_own_dept")`
3. all department ids when `can(person, "schedule.edit_all")`

This resolver already drives builder mutations (`setAssignment`, `toggleTag`,
`setPatientsBooked`, `setAvailabilityOverride`, `acknowledgeAvailability`, `upsertRhdClinic`),
the builder page gate (`canManageAnyScheduleDept`), the nav tab, and the attendings service —
all inherit the new branch (attendings stays unified; see Non-goals).

Request-decision scope — a new resolver in `requests.ts` (e.g.
`manageableRequestDepartmentIds(person)`) replacing the inline `scopeCheck` union, is the dedup'd
union of:

1. `manageableDepartmentIds(person)` — unchanged
2. `memberDepartmentIds(person)` when `can(person, "schedule.manage_requests")`
3. all department ids when `can(person, "schedule.edit_all")`

`scopeCheck` throws `RequestForbiddenError` when the department is not in this set. It gates
`listDepartmentRequests`, `approveRequest`, `denyRequest`. Self-service `createRequest` /
`cancelRequest` stay requester-only and unchanged.

#### Resulting behavior

| Actor | Edit a dept's schedule | Decide that dept's requests |
| --- | --- | --- |
| Director (membership / delegation) | unchanged (managed depts) | unchanged (managed depts) |
| `schedule.edit_all` holder | unchanged (all depts) | unchanged (all depts) |
| Non-director + `edit_own_dept` | NEW: depts they're a member of | no (needs `manage_requests`) |
| Non-director + `manage_requests` | no (needs `edit_own_dept`) | NEW: depts they're a member of |
| Plain `schedule.view` | no | no |

Directors keep their exact current abilities via `manageableDepartmentIds`, so **no migration is
needed to preserve director behavior**. The two new permissions are independent gates.

**3. Director system-role cleanup.** Remove `schedule.edit_own_dept` from the **Director** role
grants in `src/platform/rbac/system-roles.ts`. It is a no-op today; once enforced as "edit your
member departments," leaving it on Director would silently widen directors' edit reach to their
non-director memberships. Backfill migration deletes the stale grant (inverse of
`20260627210000_grant_director_learning_access`):

```sql
DELETE FROM "RoleGrant"
USING "Role" r
WHERE "RoleGrant"."roleId" = r."id"
  AND r."name" = 'Director' AND r."isSystem" = true
  AND "RoleGrant"."permission" = 'schedule.edit_own_dept';
```

The dev seed provisions the corrected grant list for fresh databases automatically. (Build runs
`migrate deploy` but not the seed, so prod grant changes need a migration too.)

**4. Builder page — conditional requests panel.** `src/app/(app)/schedule/builder/page.tsx`
always calls `listDepartmentRequests` and renders the approve/deny `PendingRequests` panel. Since
edit and `manage_requests` are now independent, an edit-only user must not trip the request scope
check. Expose request-scope membership for one department (e.g.
`canManageRequestsForDept(person, deptId)`); the page calls `listDepartmentRequests` and renders
`PendingRequests` only when the viewer has request scope for the selected department, otherwise
the panel is hidden and the call is skipped. `pendingRequestCount` in `builderView` is a raw
`prisma.count` with no scope check, so it is unaffected.

### Part A files

- `src/platform/departments.ts` — add `memberDepartmentIds`.
- `src/modules/schedule/services/builder.ts` — extend `manageableScheduleDepartmentIds`.
- `src/modules/schedule/services/requests.ts` — new request-scope resolver; rewrite `scopeCheck`.
- `src/platform/rbac/system-roles.ts` — drop `schedule.edit_own_dept` from Director.
- `prisma/migrations/<ts>_drop_director_edit_own_dept_grant/migration.sql` — backfill delete.
- `src/app/(app)/schedule/builder/page.tsx` — conditional requests panel + scope helper.

---

## Part B — Mass role assignment by membership kind

### Problem

`RoleAssignment` targets exactly one of `personId` or `departmentId` (optionally term-scoped).
There is no way to assign a role to "all volunteers" or "all directors." The engine already
auto-attaches the hardcoded **Director**/**Volunteer** system roles by membership kind, but that
is fixed in code — admins cannot attach an arbitrary role to a whole cohort. Doing it by hand is
one assignment per person and does not cover members added later in the term.

### Design — a third assignment target: `kind`

Generalize the existing kind-based auto-attach into a data-driven assignment target. A single
`RoleAssignment` row with `kind = VOLUNTEER` (or `DIRECTOR`) and `termId = <term>` means "every
person with an active membership of that kind in that term receives this role." It auto-applies
to members added later and is revoked by deleting the one row.

**1. Schema (`prisma/schema.prisma`).** Add `kind MembershipKind?` to `RoleAssignment` and an
`@@index([kind])`. Update the model doc comment to "Exactly one of personId / departmentId /
kind is set."

**2. Migration `prisma/migrations/<ts>_role_assignment_kind_target/migration.sql`.**

```sql
ALTER TABLE "RoleAssignment" ADD COLUMN "kind" "MembershipKind";

-- Replace the 2-way person/department XOR with a 3-way exactly-one check.
ALTER TABLE "RoleAssignment" DROP CONSTRAINT "RoleAssignment_target_xor";
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_target_xor"
  CHECK (
    (("personId" IS NOT NULL)::int + ("departmentId" IS NOT NULL)::int + ("kind" IS NOT NULL)::int) = 1
  );

-- Rebuild the duplicate-grant expression index to include kind (COALESCE sentinel,
-- enum cast to text). Equivalent to UNIQUE NULLS NOT DISTINCT over the target tuple.
DROP INDEX "RoleAssignment_unique_grant";
CREATE UNIQUE INDEX "RoleAssignment_unique_grant"
  ON "RoleAssignment" (
    "roleId",
    COALESCE("personId", ''),
    COALESCE("departmentId", ''),
    COALESCE("kind"::text, ''),
    COALESCE("termId", '')
  );

CREATE INDEX "RoleAssignment_kind_idx" ON "RoleAssignment"("kind");
```

The raw-SQL guards are covered by `src/platform/rbac/schema-guards.test.ts`; add a case for the
3-way XOR (e.g. setting two targets is rejected) and keep the existing duplicate/XOR cases green.

**3. Engine resolution (`src/platform/rbac/engine.ts`).** The query already loads the person's
active-term `memberships`. Derive `membershipKinds = [...new Set(memberships.map(m => m.kind))]`
and add a third target arm to the inner OR:

```ts
{ OR: [
  { personId },
  ...(departmentIds.length ? [{ departmentId: { in: departmentIds } }] : []),
  ...(membershipKinds.length ? [{ kind: { in: membershipKinds } }] : []),
] }
```

The outer term filter (`termId null` OR active term) is unchanged, so a kind-target row applies
only when global or scoped to the active term. The hardcoded Director/Volunteer auto-attach is
untouched; kind-target assignments layer on top of it.

**4. Service (`src/modules/admin/services/rbac.ts`).**

- `createAssignment` input gains `kind?: MembershipKind`. Replace the 2-way XOR check with
  "exactly one of personId / departmentId / kind set" (`AssignmentTargetError` otherwise), and
  validate `kind ∈ {DIRECTOR, VOLUNTEER}`. Persist `kind`. The P2002 path still maps to
  `DuplicateAssignmentError` (the rebuilt unique index now spans kind).
- `listAssignments` include is unchanged (kind is a scalar). `deleteAssignment` audit `before`
  snapshot adds `kind`. The last-admin guard counts by `roleId` and is unaffected.

**5. UI (`src/modules/admin/components/assignment-form.tsx` + `roles/page.tsx`).**

- New card "Assign role to all members of a kind": a kind select (Volunteer / Director), role
  select, and term select that **defaults to the active term** (the page already has terms with
  `status`; pass/derive the active term so its option is preselected), plus an Assign button
  wired to a new `assignKindAction` calling `createAssignment({ roleId, kind, termId })`.
- The assignments table renders the new target: a badge "All Volunteers" / "All Directors" with
  the term in the Scope column (or "Global").

### Part B files

- `prisma/schema.prisma` — `kind` on `RoleAssignment` + index + doc comment.
- `prisma/migrations/<ts>_role_assignment_kind_target/migration.sql` — column, 3-way XOR, rebuilt unique index, kind index.
- `src/platform/rbac/engine.ts` — kind arm in assignment resolution.
- `src/modules/admin/services/rbac.ts` — `createAssignment` kind support + 3-way XOR validation; audit snapshot.
- `src/modules/admin/components/assignment-form.tsx` — kind-target form + table rendering.
- `src/app/(app)/admin/roles/page.tsx` — pass active term for the default term selection.
- `src/platform/rbac/schema-guards.test.ts` — 3-way XOR guard case.

---

## Testing

Part A:
- `departments.test.ts`: `memberDepartmentIds` returns active memberships of any kind; `[]` with no active term.
- `builder.test.ts`: `manageableScheduleDepartmentIds` includes member depts with `edit_own_dept`, excludes them without it; director/`edit_all` paths unchanged; dedup across overlaps; mutation scope matrix for a non-director + `edit_own_dept`.
- `requests.test.ts`: non-director + `manage_requests` may list/approve/deny in a member dept and not without it; `edit_own_dept` alone does NOT grant request decisions; director and `edit_all` paths unchanged.
- `engine.test.ts`: swap the sample `schedule.edit_own_dept` grant for another still-declared permission (Director no longer grants it).
- `attendings.test.ts`: a non-director + `edit_own_dept` member of an RHD dept can manage attendings (unified); director/`edit_all` cases unchanged.
- System-role/seed assertions: Director grant list no longer contains `schedule.edit_own_dept`.

Part B:
- `rbac.test.ts`: `createAssignment` with `kind` creates a kind-target row; rejects when zero or multiple targets are set; rejects an invalid kind; duplicate kind-target raises `DuplicateAssignmentError`.
- `engine.test.ts`: a VOLUNTEER picks up a `{ kind: VOLUNTEER, termId: active }` assignment's grants; a DIRECTOR does not; term scoping respected (global applies, non-active term does not); a director-and-volunteer person gets both kinds.
- `schema-guards.test.ts`: 3-way XOR rejects a row with two targets set; duplicate kind-target rejected by the rebuilt unique index.

## Non-goals

- No per-department permission grants in Part A (the `edit_own_dept` / `manage_requests` effect is naturally limited to the holder's member departments).
- No change to director or `schedule.edit_all` behavior.
- No change to self-service `createRequest` / `cancelRequest`.
- Attendings reference-data management stays unified with edit scope (not carved out).
- Part B does not replace or alter the hardcoded Director/Volunteer auto-attach; kind-target assignments are purely additive.
- No department+kind combined target (clinic-wide kind only); can be a later extension.
