# Enforce `schedule.edit_own_dept` and `schedule.manage_requests`

**Issue:** [#82](https://github.com/HAVEN-Free-Clinic/HAVENHub/issues/82) (2026-06-27 full-app audit, `schedule/unused-schedule-permissions`)
**Date:** 2026-06-28
**Branch:** `fix/schedule-enforce-permissions`

## Problem

The schedule module manifest (`src/platform/modules/registry.ts:23-28`) declares four
grantable permissions: `schedule.view`, `schedule.edit_own_dept`, `schedule.edit_all`,
`schedule.manage_requests`. All four surface in the admin Roles UI as grantable, and the
RBAC service's `VALID_PERMISSIONS` set is built from the same registry list.

But write/approve gating never consults `edit_own_dept` or `manage_requests`:

- `builder.ts:manageableScheduleDepartmentIds` (the edit-scope resolver) = `manageableDepartmentIds(person)` ∪ (`schedule.edit_all` ? all departments : none).
- `requests.ts:scopeCheck` (decision gating) = the same union, inline.
- `manageableDepartmentIds` (`departments.ts:21-55`) requires an ACTIVE DIRECTOR `TermMembership` in the active term.

So today:

- Granting a role `schedule.edit_own_dept` or `schedule.manage_requests` confers nothing.
  `edit_own_dept` is granted by the auto-attached **Director** system role, but nothing reads
  it; `manage_requests` is granted by nothing and read by nothing.
- The model fails closed (no privilege escalation), but the admin UI advertises two
  capabilities the code ignores. An admin who wants to give a non-director schedule-edit or
  request-management ability for their own department has no working path short of
  `schedule.edit_all`, which grants ALL departments.

The audit verifier confirms director-membership scoping is the intended design; the genuine
defect is the two unimplemented grantable permissions.

## Decision

**Enforce** the two permissions (chosen over removing them) so the admin UI's grantable
permissions match real, enforced capability and admins gain a per-department path that does
not require `edit_all`.

## Design

### 1. "Own departments" helper

Add `memberDepartmentIds(personId): Promise<string[]>` to `src/platform/departments.ts`:
departments where the person holds an ACTIVE `TermMembership` of **any kind**
(VOLUNTEER or DIRECTOR) in the active term. Returns `[]` when there is no active term.
This is the "own department" notion for a non-director.

### 2. Two additive, permission-gated scopes

Both scopes keep the existing director path (`manageableDepartmentIds` = director membership +
one-hop delegation) untouched and ADD a permission-gated branch. They differ only in which
permission extends them.

**Edit scope** — `manageableScheduleDepartmentIds(person)` in `builder.ts` becomes the dedup'd
union of:

1. `manageableDepartmentIds(person)` (director membership + one-hop delegation) — unchanged
2. `memberDepartmentIds(person)` when `can(person, "schedule.edit_own_dept")`
3. all department ids when `can(person, "schedule.edit_all")`

This resolver already drives builder mutations (`setAssignment`, `toggleTag`,
`setPatientsBooked`, `setAvailabilityOverride`, `acknowledgeAvailability`, `upsertRhdClinic`),
the builder page gate (`canManageAnyScheduleDept`), the nav tab, and the attendings service.
All inherit the new branch (attendings stays unified — see Non-goals).

**Request-decision scope** — a new resolver in `requests.ts` (e.g.
`manageableRequestDepartmentIds(person)`), replacing the inline `scopeCheck` union, is the
dedup'd union of:

1. `manageableDepartmentIds(person)` — unchanged
2. `memberDepartmentIds(person)` when `can(person, "schedule.manage_requests")`
3. all department ids when `can(person, "schedule.edit_all")`

`scopeCheck(actor, departmentId)` then throws `RequestForbiddenError` when `departmentId` is not
in this set. It gates `listDepartmentRequests`, `approveRequest`, `denyRequest`. Self-service
`createRequest` / `cancelRequest` are requester-only and unchanged.

### Resulting behavior

| Actor | Edit a dept's schedule | Decide that dept's requests |
| --- | --- | --- |
| Director (membership / delegation) | unchanged (their managed depts) | unchanged (their managed depts) |
| `schedule.edit_all` holder | unchanged (all depts) | unchanged (all depts) |
| Non-director + `edit_own_dept` | NEW: depts they're a member of | no (needs `manage_requests`) |
| Non-director + `manage_requests` | no (needs `edit_own_dept`) | NEW: depts they're a member of |
| Plain `schedule.view` | no | no |

Directors keep their exact current abilities through `manageableDepartmentIds`, so **no
migration is needed to preserve director behavior**. The two new permissions are independent
gates (matching the two distinct registry entries).

### 3. Director system-role cleanup

Remove `schedule.edit_own_dept` from the **Director** role grants in
`src/platform/rbac/system-roles.ts`. It is a no-op today; once `edit_own_dept` is enforced as
"edit your member departments," leaving it on Director would silently widen directors' edit
reach to their non-director (volunteer) memberships. Dropping it keeps directors exactly as
they are (membership + delegation only).

Backfill migration `prisma/migrations/<ts>_drop_director_edit_own_dept_grant/migration.sql`
deletes the stale grant from existing databases (inverse of
`20260627210000_grant_director_learning_access`):

```sql
DELETE FROM "RoleGrant"
USING "Role" r
WHERE "RoleGrant"."roleId" = r."id"
  AND r."name" = 'Director' AND r."isSystem" = true
  AND "RoleGrant"."permission" = 'schedule.edit_own_dept';
```

The dev seed (`prisma/seed.ts` via `SYSTEM_ROLES`) provisions the corrected grant list for
fresh databases automatically. (Per the system-role-grants convention: the build runs
`migrate deploy` but not the seed, so prod grant changes need a migration too.)

### 4. Builder page — conditional requests panel

`src/app/(app)/schedule/builder/page.tsx` currently always calls `listDepartmentRequests` and
renders the approve/deny `PendingRequests` panel. Since edit and `manage_requests` are now
independent, an edit-only user (e.g. `edit_own_dept` without `manage_requests`) must not trip
the request scope check.

Expose request-scope membership for a single department (e.g.
`canManageRequestsForDept(person, deptId)` derived from `manageableRequestDepartmentIds`). The
page calls `listDepartmentRequests` and renders `PendingRequests` only when the viewer has
request scope for the selected department; otherwise the panel is hidden and the call is
skipped. `pendingRequestCount` in `builderView` is a raw `prisma.count` with no scope check, so
it is unaffected.

## Files touched

- `src/platform/departments.ts` — add `memberDepartmentIds`.
- `src/modules/schedule/services/builder.ts` — extend `manageableScheduleDepartmentIds` with the `edit_own_dept` branch.
- `src/modules/schedule/services/requests.ts` — new request-scope resolver; rewrite `scopeCheck`.
- `src/platform/rbac/system-roles.ts` — drop `schedule.edit_own_dept` from Director.
- `prisma/migrations/<ts>_drop_director_edit_own_dept_grant/migration.sql` — backfill delete.
- `src/app/(app)/schedule/builder/page.tsx` — conditional requests panel + scope helper usage.

## Testing

- `departments.test.ts` (or new): `memberDepartmentIds` returns active memberships of any kind; `[]` with no active term.
- `builder.test.ts`: `manageableScheduleDepartmentIds` includes member depts when `edit_own_dept` is granted; excludes them without it; director/edit_all paths unchanged; dedup across overlaps. Mutation scope matrix: non-director + `edit_own_dept` may edit a member dept, may not edit a non-member dept.
- `requests.test.ts`: non-director + `manage_requests` may list/approve/deny in a member dept; may not without it; `edit_own_dept` alone does NOT grant request decisions; director and `edit_all` paths unchanged.
- `engine.test.ts`: swap the sample `schedule.edit_own_dept` grant used purely to exercise permission resolution for another still-declared permission (Director role no longer grants it).
- `attendings.test.ts`: confirm a non-director + `edit_own_dept` member of an RHD dept can manage attendings (unified behavior); existing director/edit_all cases unchanged.
- `seed` / system-role tests: Director grant list no longer contains `schedule.edit_own_dept`.

## Non-goals

- No per-department permission grants (the `edit_own_dept` / `manage_requests` effect is naturally limited to the holder's member departments; `RoleAssignment` dept-scoping is a separate mechanism left untouched).
- No change to director or `schedule.edit_all` behavior.
- No change to self-service `createRequest` / `cancelRequest` (requester-only).
- Attendings reference-data management stays unified with edit scope (an RHD-dept member with `edit_own_dept` can manage attendings); not carved out.
