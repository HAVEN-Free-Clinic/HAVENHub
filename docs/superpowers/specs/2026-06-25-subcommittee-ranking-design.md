# Subcommittee ranking at application time + post-acceptance assignment

**Date:** 2026-06-25
**Branch:** `feat/recruitment-form-builder-redesign` (worktree off PR #60)
**Status:** Design approved, pending spec review

## Problem

Applicants should be able to rank their top subcommittee choices **when they apply**.
Today subcommittee interest is only captured as a single free-text field during
training/onboarding (`Training.subcommitteeInterest`), which is after acceptance and
unstructured. We want structured ranked preferences captured on the application form,
and a place in the hub where, **after acceptances are processed**, the recruitment team
reviews each accepted applicant's ranked preferences and assigns a final subcommittee.

## Decisions (from brainstorming)

- Subcommittees are a **first-class, admin-managed global entity** (like `Department`),
  reused across cycles.
- Ranking appears as a **new draggable form-builder field type** (`SUBCOMMITTEE_RANK`),
  like `DEPARTMENT_CHOICE`.
- The number to rank is **configurable per field** (default 3); the field can be required
  or optional.
- Assignment is **one subcommittee per accepted person**, recorded at the application
  level.
- The ranking field offers **all active subcommittees** (global, not a per-cycle subset
  and not department-scoped). Per-cycle restriction is explicitly out of scope; can be
  added later.
- Downstream: this **replaces** the free-text training intake field. The
  `Training.subcommitteeInterest` column is **dropped** (accepted data loss). No
  propagation to memberships/roster yet (out of scope, can add later).

## Architecture

### 1. Data model (Prisma)

**New `Subcommittee` model** — mirrors `Department` conventions (soft-delete via
`isActive`, never hard-delete so historical ranking IDs always resolve to a name):

```prisma
model Subcommittee {
  id                   String        @id @default(cuid())
  name                 String
  isActive             Boolean       @default(true)
  order                Int           @default(0)
  createdAt            DateTime      @default(now())
  updatedAt            DateTime      @updatedAt
  assignedApplications Application[] @relation("applicationAssignedSubcommittee")

  @@index([isActive, order])
}
```

**`Application` additions:**

```prisma
  // ordered subcommittee IDs the applicant ranked (1st -> Nth); hoisted from the
  // SUBCOMMITTEE_RANK field answer at submit, like departmentChoices.
  subcommitteeRanking      String[]
  assignedSubcommitteeId   String?
  assignedSubcommitteeById String?      // Person who assigned
  assignedSubcommitteeAt   DateTime?
  assignedSubcommittee     Subcommittee? @relation("applicationAssignedSubcommittee", fields: [assignedSubcommitteeId], references: [id], onDelete: SetNull)
  assignedSubcommitteeBy   Person?       @relation("applicationSubcommitteeAssigner", fields: [assignedSubcommitteeById], references: [id], onDelete: SetNull)
```
(Add the matching back-relation on `Person`.)

**`FieldType` enum:** add `SUBCOMMITTEE_RANK`.

**`Training`:** drop the `subcommitteeInterest` column.

Migration: one migration adds `Subcommittee`, the `Application` columns/relations, the
new enum value, and drops `Training.subcommitteeInterest`. Run `prisma migrate status`
before any Neon deploy (preview deploys share the prod DB — branches behind a migration
crash with P2021; see project memory).

### 2. Engine + field-type metadata

- `src/modules/recruitment/engine/schema-builder.ts`: add `SUBCOMMITTEE_RANK` to the
  `FieldType` union and extend `FieldValidation` with `rankCount?: number`.
  `SUBCOMMITTEE_RANK` is handled specially in submissions (like `FILE` /
  `DEPARTMENT_CHOICE`), so `buildApplicationSchema` skips it from the generic scalar
  schema rather than emitting a zod entry.
- `src/modules/recruitment/engine/field-types.ts`: add a `Subcommittee` group + a
  `FIELD_TYPE_META.SUBCOMMITTEE_RANK` entry (label "Subcommittee ranking", `ListOrdered`
  icon, `hasOptions: false`, `isFile: false`), and append the group to
  `FIELD_GROUP_ORDER`.

### 3. Capture (submissions service)

In `src/modules/recruitment/services/submissions.ts`, mirror the `DEPARTMENT_CHOICE`
hoist:

- Load active subcommittees once (`prisma.subcommittee.findMany({ where: { isActive: true } })`).
- Find the `SUBCOMMITTEE_RANK` field (if any). Read its ranked answer as an ordered
  array (`FormData.getAll(key)` on the action side -> array in `answers[key]`).
- Validate: each entry is a distinct, active subcommittee ID; length ≤ `rankCount`
  (from the field's `validation.rankCount`, default 3). **Required semantics:** when the
  field is `required`, the applicant must rank **at least one** subcommittee (not
  necessarily all `rankCount`); when optional, all dropdowns may be left blank. On
  failure throw `SubmissionValidationError` keyed on the field key.
- Store the validated ordered array in `Application.subcommitteeRanking`. Keep it out of
  the generic `answers` JSON (single source of truth = the column), consistent with how
  `departmentChoices` is hoisted.

The public action (`src/app/apply/[slug]/actions.ts`) must collect the ranking field via
`fd.getAll(key)` so order is preserved.

### 4. Public rendering

- `src/modules/recruitment/components/field-preview.tsx`: add a `subcommittees: { id: string; name: string }[]`
  prop and a `SUBCOMMITTEE_RANK` case that renders `rankCount` ordered `<select>`s
  ("1st choice", "2nd choice", …), each with `name={f.key}` so the submitted values form
  an ordered list. Client-side dedup prevents picking the same subcommittee twice.
  `rankCount` comes from `f.validation?.rankCount ?? 3`.
- `src/app/apply/[slug]/apply-form.tsx` and `page.tsx`: thread active subcommittees into
  the form `def` and pass `subcommittees` to `FieldPreview`.

### 5. Form-builder field settings

- `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx`: when the field type is
  `SUBCOMMITTEE_RANK`, show a "Number to rank" numeric input (writes
  `validation.rankCount`) alongside the existing required toggle. No options editor
  (options are injected from the global subcommittee list). Respect the existing
  published-cycle lock behavior used by other field settings.

### 6. Assignment service + view

- New service `assignSubcommittee({ applicationId, subcommitteeId, byPersonId })` in the
  recruitment services layer:
  - Guard: the application must have ≥1 `Acceptance` (assignment is post-acceptance).
  - Accept any active subcommittee ID (not limited to the applicant's ranked choices);
    `subcommitteeId === null` clears the assignment.
  - Set `assignedSubcommitteeId`, `assignedSubcommitteeById`, `assignedSubcommitteeAt`;
    `recordAudit({ action: "recruitment.subcommittee_assign", ... })`.
  - Permission: gated to recruitment leads (the `seeAll` scope), since it is a
    cross-department decision.
- New page **`/recruitment/cycles/[id]/subcommittees`** ("Assign subcommittees"):
  - Lists accepted applicants (applications with ≥1 `Acceptance`) for the cycle.
  - Each row shows: name, accepted department(s), the ranked preferences resolved to
    subcommittee **names in order**, and a dropdown of all active subcommittees to set or
    clear the assignment (current assignment preselected).
  - Linked from the cycle nav near the existing applicants/decisions views.
- Existing accepted-applicant detail page
  (`/recruitment/cycles/[id]/applicants/[applicationId]`): show ranked preferences +
  current assignment read-only (assignment happens in the dedicated view).

### 7. Admin CRUD

- New `/admin/subcommittees` (list / new / `[id]` edit + deactivate), mirroring
  `/admin/departments` (`page.tsx`, `new/page.tsx`, `[id]/page.tsx`) and its server
  actions. Soft-delete only.

### 8. Cleanup — remove training intake free-text

- `src/app/(app)/training/training-quiz.tsx`: remove the `subcommitteeInterest` input and
  its `fd.get` collection.
- `src/modules/recruitment/services/training.ts`: remove `subcommitteeInterest` from the
  intake type, the read mapping, and the write.
- Drop the `Training.subcommitteeInterest` column (in the migration above). Update any
  tests referencing it.

## Testing

- **Engine:** `field-types` includes the new group/type; `schema-builder` skips
  `SUBCOMMITTEE_RANK` from the scalar schema.
- **Submissions:** ranking hoisted into `subcommitteeRanking` in order; rejects
  duplicates, unknown/inactive IDs, over-count, and (when required) empty; happy path
  stores the ordered array.
- **Assignment service:** assigns to an accepted application; clears with null; rejects
  assignment when the application has no acceptance; rejects a non-`seeAll` caller;
  records audit.
- **Admin subcommittees:** create / rename / deactivate; deactivated subcommittee no
  longer offered on the form but still resolves by name in existing rankings.
- **Cleanup:** training intake no longer reads/writes `subcommitteeInterest`; existing
  training tests updated.

## Out of scope (future)

- Per-cycle / per-field subset of offered subcommittees.
- Propagating the assigned subcommittee onto `TermMembership` / roster / scheduler.
- Bulk auto-assignment by preference / capacity balancing.

## Risks / notes

- **Destructive migration:** dropping `Training.subcommitteeInterest` discards any
  free-text interest already collected. Accepted.
- **Shared DB on previews:** coordinate the migration with deploy (P2021 risk).
- Ranked IDs reference soft-deleted subcommittees safely because we never hard-delete.
