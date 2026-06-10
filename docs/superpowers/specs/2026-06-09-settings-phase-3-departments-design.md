# Admin-Configurable Settings — Phase 3: Departments CRUD + Delegation Editor

**Date:** 2026-06-09
**Status:** Design for approval
**Depends on:** the existing `Department`/`DepartmentDelegation` models and admin module conventions. Independent of the Phase 0-2 settings registry.

## Goal

Give admins a UI to manage departments and their delegation relationships, so
adding/renaming/deactivating a department and wiring up "who oversees whom" no
longer requires the seed script or a developer. This is the last hardcoded-ish
surface from the original "everything customizable via the UI" goal.

## Background

`Department` (id, `code` unique, `name`, `isActive`, `idealHeadcount?`,
`patientCapacityPerProvider?`, plus relations) and `DepartmentDelegation`
(`managerDepartmentId` → `managedDepartmentId`, unique pair, cascade delete) already
exist. Today they are only created via `prisma/seed.ts` and import scripts; there is
no admin screen. Delegations drive `manageableDepartmentIds(personId)` (a director of
a manager department also manages the departments it oversees, one hop).

## Decisions (from brainstorming)

- **Code is immutable after creation.** `code` is a stable structural key — some
  logic looks departments up by specific codes (e.g. the RHD schedule readiness in
  `schedule/services/builder.ts` keys off `"SCTS"/"JCTS"/"CCRH"` via `RHD_CODES`).
  The display **name** is freely editable; to change a code, deactivate and create a
  new department.
- **Removal is soft-deactivate only.** Departments are referenced by memberships,
  shift assignments, schedules, role assignments, and delegations. "Remove" sets
  `isActive = false` (reversible); there is no hard delete.

## Scope

- Admin pages: `/admin/departments` (list), `/admin/departments/new` (create),
  `/admin/departments/[id]` (edit name/active/capacity + delegation editor).
- New permission `admin.manage_departments` + a Departments nav item.
- Service `src/modules/admin/services/departments.ts` (mirrors `terms.ts`).
- Audit on every mutation.

### Out of scope

- Hard delete; editing `code` post-creation; reordering (list is sorted by code);
  bulk import (scripts already cover that); capacity-panel rendering (this only edits
  the `idealHeadcount`/`patientCapacityPerProvider` values).

## Design

### 1. Service (`src/modules/admin/services/departments.ts`)

Mirror `terms.ts`: typed errors + actor-scoped mutations that audit.

```ts
export class DepartmentConflictError extends Error {}   // duplicate code
export class DepartmentNotFoundError extends Error {}
export class DepartmentValidationError extends Error {} // bad code/name/numbers/delegation

type DepartmentRow = Department & {
  _count: { memberships: number };
  managesDelegations: { managedDepartmentId: string }[];
};

/** All departments (active first, then by code), with delegation + membership counts. */
export async function listDepartments(): Promise<DepartmentRow[]>;

/** Create. code is normalized to uppercase, validated unique + format. */
export async function createDepartment(
  actorPersonId: string,
  input: { code: string; name: string; isActive?: boolean; idealHeadcount?: number | null; patientCapacityPerProvider?: number | null }
): Promise<Department>;

/** Update name/isActive/capacity. code is NOT accepted (immutable). Audits before/after. */
export async function updateDepartment(
  actorPersonId: string,
  id: string,
  input: { name: string; isActive: boolean; idealHeadcount: number | null; patientCapacityPerProvider: number | null }
): Promise<Department>;

/** Replace the manager's full set of managed departments (delete + recreate edges). */
export async function setDelegations(
  actorPersonId: string,
  managerId: string,
  managedIds: string[]
): Promise<void>;
```

**Validation:**
- `code`: trimmed, uppercased, must match `/^[A-Z0-9]{2,12}$/`; unique (Prisma P2002 →
  `DepartmentConflictError`).
- `name`: non-empty (trimmed).
- `idealHeadcount`, `patientCapacityPerProvider`: `null` or a positive integer.
- `setDelegations`: `managedIds` must be existing department ids, must exclude
  `managerId` (no self-delegation), deduped. Implemented as: validate, then in a
  transaction `deleteMany({ managerDepartmentId: managerId })` + `createMany` the new
  edges. (Replacing the whole set keeps the editor simple and idempotent.)

**Audit:** `department.create`, `department.update` (before/after name/isActive/
capacity), `department.set_delegations` (before/after managed id sets). Deactivation
is part of `department.update` (isActive change is visible in before/after).

### 2. Permission + nav

In `src/platform/modules/registry.ts`, add `"admin.manage_departments"` to the admin
manifest `permissions[]` and `{ label: "Departments", href: "/admin/departments" }` to
its `nav`. Platform Admin's `*` grant covers it (no seed change).

### 3. Pages (mirror `/admin/terms`)

- **List** `/admin/departments/page.tsx`: gate `admin.manage_departments`; table of all
  departments (Code, Name, Active badge, Manages count, Members count, capacity); a
  "Create department" button. Inactive rows are visually de-emphasized.
- **Create** `/admin/departments/new/page.tsx`: a `DepartmentForm` (code, name, isActive
  default true, idealHeadcount, patientCapacityPerProvider) with an inline `createAction`
  that redirects to the edit page on success and back with `?error=` on
  `DepartmentConflictError`/`DepartmentValidationError`.
- **Edit** `/admin/departments/[id]/page.tsx`: loads the department + all active
  departments. Renders:
  - `DepartmentForm` in edit mode — **code shown read-only** (disabled input), name/
    isActive/capacity editable — with an inline `updateAction`. The "Active" toggle is
    how you deactivate/reactivate (soft remove).
  - A **DelegationEditor**: a checklist of the other active departments; checked = this
    department manages it. Submits the selected ids to an inline `setDelegationsAction`.

### 4. Components

- `src/modules/admin/components/department-form.tsx` — fields; `mode: "create" | "edit"`
  controls whether `code` is an editable input (create) or a disabled/read-only display
  (edit). Mirrors `term-form.tsx`.
- `src/modules/admin/components/delegation-editor.tsx` — renders the manager department's
  name + a checkbox list of candidate departments (all active except itself), pre-checked
  from the current delegations, and a Save button. A server action prop does the write.

### 5. Coercion / inputs

Capacity inputs are number fields; empty → `null`, otherwise parsed to a positive int
(reject non-positive in the service). `isActive` is a checkbox. `code` (create only) is
uppercased server-side before validation.

## Testing

Mirror `terms.test.ts` (DB-backed, `resetDb`):
- `createDepartment`: creates with normalized uppercase code; rejects duplicate code
  (`DepartmentConflictError`); rejects empty name / bad code format / negative capacity
  (`DepartmentValidationError`); writes a `department.create` audit row.
- `updateDepartment`: updates name/isActive/capacity; does not change `code` (the input
  type has no code field); deactivation flips `isActive` and audits before/after;
  `DepartmentNotFoundError` for a missing id.
- `setDelegations`: replaces the manager's edges; excludes self; dedupes; rejects unknown
  managed ids; second call fully replaces (not appends); audits.
- `listDepartments`: returns active-first ordering with `_count.memberships` and the
  managed-id list.
- **Regression:** existing `manageableDepartmentIds` tests still pass (delegations created
  via `setDelegations` produce the same one-hop behavior).

(No unit tests for the pages/components — the repo does not unit-test server components;
the service is the tested surface, plus build + manual smoke.)

## Files (anticipated)

- `src/modules/admin/services/departments.ts` (+ test) — service.
- `src/platform/modules/registry.ts` — permission + nav.
- `src/app/admin/departments/page.tsx`, `new/page.tsx`, `[id]/page.tsx` — pages.
- `src/modules/admin/components/department-form.tsx`, `delegation-editor.tsx` — components.

## Risks & mitigations

- **Code/RHD coupling** — mitigated by making `code` immutable (the readiness logic's
  `"SCTS"` etc. lookups stay valid). Deactivating an RHD department is allowed and simply
  drops it from active scheduling — acceptable, reversible.
- **Delegation cycles** — `manageableDepartmentIds` is one-hop and non-recursive, so a
  cycle (A manages B, B manages A) cannot infinite-loop. No cycle check needed; only
  self-delegation is rejected (it is meaningless).
- **Deactivating a department mid-term** — soft, reversible; historical rows
  (memberships/assignments) keep their FK. Active lists exclude it.
