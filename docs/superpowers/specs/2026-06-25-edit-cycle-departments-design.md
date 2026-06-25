# Edit recruitment cycle departments after creation

**Date:** 2026-06-25
**Branch:** `feat/recruitment-cycle-edit-departments` (off `feat/recruitment-form-builder-redesign` / PR #60)
**Status:** Design approved, pending spec review

## Problem

A recruitment cycle's `departments` (a `String[]` of department codes) is set once at
creation via a comma-separated free-text input and can never be changed afterward.
The recruitment team needs to edit a cycle's departments after it exists, including
**adding a department to a CLOSED cycle** to late-onboard someone into a department that
was not originally part of the cycle.

## Current behavior (context)

- `createCycle` stores `departments` from a comma-separated text field; codes are not
  validated against the global `Department` list.
- `cycle.departments` drives: `DEPARTMENT_CHOICE` field options on the public form,
  `acceptApplicant` (which requires the `departmentCode` to be in `cycle.departments`),
  and review/decision scoping.
- The cycle overview page (`src/app/(app)/recruitment/cycles/[id]/page.tsx`) exposes
  publish/close/renewals toggles but no department editing. The pattern for a guarded
  cycle mutation is `setAcceptsRenewals(id, value, actorId)` in
  `src/modules/recruitment/services/cycles.ts`.

## Decisions (from brainstorming)

- **Editable states:** any non-`ARCHIVED` cycle (DRAFT, OPEN, CLOSED). Editing a CLOSED
  cycle is a supported case (late-onboarding into a new department).
- **Removal of a department that still has applicants/acceptances:** allowed, but the UI
  surfaces a clear warning naming the affected departments and their applicant counts.
  Adding is always allowed.
- **Edit UX:** a multi-select of active departments from the global `Department` list
  (checkboxes), pre-checked for the cycle's current departments. Validates against real
  codes. The create page's free-text input is left unchanged (out of scope).

## Architecture

### 1. Service: `setCycleDepartments`

In `src/modules/recruitment/services/cycles.ts`:

```ts
export type RemovedDepartmentImpact = { code: string; applicantCount: number };

export async function setCycleDepartments(
  id: string,
  departmentCodes: string[],
  actorId: string
): Promise<{ cycle: RecruitmentCycle; removedWithApplicants: RemovedDepartmentImpact[] }>;
```

Behavior:
- Load the cycle; throw `CyclePublishError("Cycle not found.")` if missing.
- Reject if `cycle.status === "ARCHIVED"` with `CyclePublishError("Departments cannot be changed on an archived cycle.")`.
- Normalize input: `map(trim) -> filter(Boolean) -> dedupe` (preserve order).
- Compute `removed = cycle.departments.filter(c => !next.includes(c))`.
- For each removed code, count applications in this cycle whose `departmentChoices`
  contains the code (Prisma: `application.count({ where: { cycleId, departmentChoices: { has: code } } })`).
  Collect those with `applicantCount > 0` into `removedWithApplicants`.
- Update `cycle.departments = next` (save regardless of impact — allow-with-warning).
- `recordAudit({ actorPersonId, action: "recruitment.cycle_set_departments", entityType: "RecruitmentCycle", entityId: id, before: { departments: cycle.departments }, after: { departments: next } })`.
- Return `{ cycle: updated, removedWithApplicants }`.

Permission (`recruitment.manage_cycles`) is enforced by the caller (the action), matching
the existing service convention.

### 2. Action: `setCycleDepartmentsAction`

In `src/app/(app)/recruitment/actions.ts`:

```ts
export async function setCycleDepartmentsAction(cycleId: string, formData: FormData) {
  const person = await requirePermission("recruitment.manage_cycles");
  const departments = formData.getAll("departments").map(String).map((d) => d.trim()).filter(Boolean);
  try {
    const { removedWithApplicants } = await setCycleDepartments(cycleId, departments, person.personId);
    if (removedWithApplicants.length > 0) {
      const warn = removedWithApplicants.map((r) => `${r.code} (${r.applicantCount})`).join(", ");
      redirect(`/recruitment/cycles/${cycleId}?deptwarn=${encodeURIComponent(warn)}`);
    }
  } catch (err) {
    if (err instanceof CyclePublishError) {
      redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  redirect(`/recruitment/cycles/${cycleId}?deptsaved=1`);
}
```

(The success `redirect` stays outside the try so Next's `NEXT_REDIRECT` is not caught.)

### 3. UI: Departments card on the cycle overview page

In `src/app/(app)/recruitment/cycles/[id]/page.tsx`:
- Read the new search params `deptsaved` / `deptwarn` and `error` (already read) for alerts.
- Load active departments and per-department applicant counts for this cycle:
  - `prisma.department.findMany({ where: { isActive: true }, select: { code: true, name: true }, orderBy: { code: "asc" } })`
  - applicant counts: group the cycle's applications by department choice. Compute a
    `Map<code, count>` by loading `application.findMany({ where: { cycleId }, select: { departmentChoices: true } })` and tallying, or per-code counts. A single findMany + in-memory tally is simplest.
- Build the option set = active departments UNION any code in `cycle.departments` not in the
  active list (so deactivated/free-text codes are still shown and not silently dropped). Mark
  such extra codes (e.g. a small "not in department list" hint).
- Render a `<form action={setCycleDepartmentsAction.bind(null, id)}>` containing a checkbox
  per option (`name="departments"` value=code), checked when in `cycle.departments`, each row
  showing the code, name (if known), and its applicant count (e.g. "3 applicants"). A
  `SubmitButton` saves.
- Show a success `Alert` when `deptsaved`, a warning `Alert` when `deptwarn` (listing the
  removed-with-applicants string), reusing the existing `error` alert path.
- Place the card near the existing publish/renewals controls. Gate it to the same audience
  as the rest of the page (the page is already reachable only by the recruitment audience;
  the action re-checks `recruitment.manage_cycles`).

## Testing

Service tests in `src/modules/recruitment/services/cycles.test.ts` (or a focused new test
file if cycles.test.ts does not exist):
- adds a department to an existing cycle (departments updated, no warning).
- removes a department with no applicants -> saved, `removedWithApplicants` empty.
- removes a department that HAS an application referencing it -> saved, and the code is
  returned in `removedWithApplicants` with the correct count.
- trims and dedupes input (e.g. `[" SRHD ", "SRHD", "MDIC"] -> ["SRHD", "MDIC"]`).
- rejects a missing cycle and an ARCHIVED cycle with `CyclePublishError`.
- records an audit entry with before/after departments.

No UI unit tests (server component + action); verify via typecheck + build.

## Out of scope

- Upgrading the create-cycle page's free-text department input to a multi-select.
- Validating/repairing existing applications when a department is removed (their stored
  `departmentChoices` are left intact; only future form rendering and new acceptances are
  affected).
- Any change to `acceptApplicant` (it already requires the department to be in
  `cycle.departments`; adding a department now makes that path work for late onboarding).

## Risks / notes

- Removing a department a `DEPARTMENT_CHOICE` field offered does not rewrite submitted
  applications; their `departmentChoices` keep the old code. Review listing intersects a
  reviewer's scope with `departmentChoices`, so those applicants remain visible to in-scope
  reviewers. Only new submissions (form options) and `acceptApplicant` (which gates on
  `cycle.departments`) are affected. The warning makes this explicit.
- No DB migration: `departments` is an existing `String[]` column.
