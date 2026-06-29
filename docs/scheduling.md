# Scheduling

The scheduling module manages clinic shift assignments for a term: who works
which Saturday clinic, in which department, in which role. It covers the
volunteer-facing view, the director-facing builder, swap and drop requests,
capacity planning, and the Reproductive Health Department (RHD) attending
roster.

This is the technical reference. For task-oriented guides, see the
[Volunteer Guide](./scheduling-volunteers.md) and the
[Director Guide](./scheduling-directors.md).

All clinic dates across the module are anchored at 12:00 UTC and compared by
UTC day key, never by raw timestamp. This keeps a "Saturday" the same calendar
day regardless of the viewer's local timezone.

## Contents

- [Concepts](#concepts)
- [Pages and navigation](#pages-and-navigation)
- [Availability](#availability)
- [Shift assignments and roles](#shift-assignments-and-roles)
- [Swap and drop requests](#swap-and-drop-requests)
- [The schedule builder](#the-schedule-builder)
- [Capacity planning](#capacity-planning)
- [RHD clinic readiness and attendings](#rhd-clinic-readiness-and-attendings)
- [Compliance banner](#compliance-banner)
- [Permissions and scoping](#permissions-and-scoping)
- [Data model](#data-model)
- [Code map](#code-map)

## Concepts

| Term | Meaning |
| --- | --- |
| Clinic date | A single Saturday clinic, stored noon-UTC anchored. |
| Term | The active academic period. Only one term is `ACTIVE` at a time; all scheduling is scoped to it. |
| Department | An operational unit (for example ITCM, or an RHD-family department). A person can hold a shift in more than one department. |
| Membership | A person's `TermMembership` in a department for the term. Availability lives here. |
| Shift assignment | One person scheduled into one department on one clinic date in one role. |
| Role | `DIRECTOR`, `VOLUNTEER`, or `SHADOW`. |
| Med-team tag | Optional volunteer tags on an assignment: triage, walk-in, CC (continuity care), remote. |

## Pages and navigation

The module nav exposes four pages. Every page gates on module access
(`requireModuleAccess("schedule")`); finer-grained edit rights are enforced
inside the services.

| Page | Route | Purpose |
| --- | --- | --- |
| My schedule | `/schedule` | A volunteer's own shifts, availability self-update, and swap or drop requests. |
| Full schedule | `/schedule/full` | The clinic-wide view for a selected date: every department's directors, volunteers, and shadows, with same-day conflict flags. |
| Builder | `/schedule/builder` | The director tool for assigning people to shifts, with capacity math and clinic readiness. |
| Attendings | `/schedule/attendings` | The RHD attending physician roster and procedure qualification matrix. |

## Availability

Availability answers "which clinic dates can this member work?" and resolves
through three tiers. The highest set tier wins.

1. **Director override** (highest). Active when `directorAvailabilitySetAt` is
   non-null. An empty-but-set override is distinct from never-set, so a director
   can deliberately mark a member as available on no dates.
2. **Self update** (middle). Active when `availabilityUpdatedAt` is non-null.
   Holds the structured clinic dates a member selected for themselves
   (`selfAvailabilityDates`).
3. **Baseline** (lowest). The availability captured from the member's
   application at import or roster build (`baselineAvailability`). The fallback
   when neither higher tier is set.

`resolveAvailability` returns both the active date list and which tier produced
it (`DIRECTOR`, `SELF`, or `BASELINE`).

### Self-update

On `/schedule`, a volunteer submits the structured clinic dates they can attend.
This sets `selfAvailabilityDates` and stamps `availabilityUpdatedAt`, activating
the self tier. Input is validated server-side (`AvailabilityValidationError` on
invalid data).

A legacy free-text field (`selfUpdatedAvailability`) is preserved read-only as a
note. Structured dates supersede it.

### Acknowledgment

`availabilityAcknowledgedAt` records when a member has reviewed the availability
that applies to them, so directors can see who has confirmed.

## Shift assignments and roles

A `ShiftAssignment` ties one person to one department on one clinic date in one
role. The unique key is `(termId, departmentId, clinicDate, personId)`, so a
person holds at most one assignment per department per date, but the three roles
are distinct: a person could be a director in one department and a shadow in
another on the same day.

- **DIRECTOR** runs the department's clinic.
- **VOLUNTEER** is a standard shift. Volunteers may carry med-team tags (triage,
  walk-in, CC, remote).
- **SHADOW** is an observer slot.

## Swap and drop requests

Volunteers can request to leave a shift through `ShiftRequest`. A request is a
**drop** when it has no target, and a **named swap** when it names a partner and
their date.

### Validation rules

Requests are validated by the engine (`validateRequest`) before anything is
written, and re-validated again at approval time inside a transaction:

- The requester must actually be assigned to the shift they name.
- **Shadow shifts can only be dropped, never swapped.** Shadows are observers,
  not a tradeable slot.
- For a swap, the partner must exist on the named date, must not be a shadow,
  and must hold the **same role** as the requester. You cannot swap a volunteer
  shift for a director shift.
- A request must be a clean drop (no target) or a clean swap (both partner and
  partner date). Half-specified swaps are rejected.

### Apply semantics

When an approved swap is applied, the engine emits a precise set of mutations: a
drop is a single remove; a swap removes each person from their own date and adds
them to the other's date, preserving the shared role. Removes are guarded by
role so a concurrent edit cannot delete the wrong assignment, and adds are
idempotent (upsert on the assignment unique key).

### Lifecycle and guards

A request moves `PENDING` to `APPROVED`, `DENIED`, or `CANCELLED`. The requester
can cancel their own pending request; approval and denial are restricted (see
[Permissions](#permissions-and-scoping)). A database-level partial unique index
(`ShiftRequest_pending_unique`) prevents duplicate pending rows for the same
`(requesterId, requesterDate, departmentId)` triple. This guard is covered by
`schedule-schema-guards.test.ts`; do not let a Prisma migrate diff drop it.

## The schedule builder

`/schedule/builder` is the director workspace. It is scoped to the viewer's
manageable departments and a selected clinic date, and brings together:

- **Assignment grid.** Add or remove people in each role for the selected
  department and date. Every write re-checks that the actor manages the target
  department before touching data.
- **Resolved availability.** Each candidate is shown through the three-tier
  availability resolution, so directors schedule against the right date set.
- **Conflict detection.** Same-day conflicts (the person is already scheduled in
  another department that date) are surfaced per person.
- **Capacity metrics.** Live headcount, triage and walk-in coverage, Spanish
  speakers, shadows, and patient-capacity math for the day.
- **Compliance banner.** Departments with any scheduled volunteer whose HIPAA
  status is not compliant.
- **Clinic readiness** for RHD-family departments (see below).

## Capacity planning

Per-day capacity is computed by the engine (`computeDayMetrics`) from the people
on shift plus per-day configuration:

- **Headcount status**: `under`, `at`, `over`, or `unknown` against an ideal
  headcount.
- **Triage and walk-in coverage**: each reported as `missing` (0), `ok` (1), or
  `excess` (2+).
- **Shadow and Spanish-speaker counts** for the day.
- **Patient capacity**: from patients booked (`ScheduleDay.patientsBooked`,
  maintained by directors) against patient-capacity-per-provider, yielding a
  max capacity and any patients to reschedule.

Ideal headcount and patient-capacity-per-provider come from settings/department
configuration rather than being hardcoded.

## RHD clinic readiness and attendings

Reproductive Health Department clinics (department codes `SCTS`, `JCTS`, `CCRH`)
need a qualified attending physician on duty. The module tracks this separately.

### Attending roster

`/schedule/attendings` maintains `RhdAttending` records. Each attending carries a
qualification matrix across six procedures, each valued `yes`, `no`, or
`unknown`:

| Key | Label |
| --- | --- |
| `iudIn` | IUD In |
| `iudOut` | IUD Out |
| `nexplanon` | Nexplanon |
| `gac` | GAC |
| `emb` | EMB |
| `seesMale` | Sees Male |

Editing the roster requires the actor to manage an RHD-family department
(`AttendingForbiddenError` otherwise).

### Per-clinic record and readiness

`RhdClinic` is one row per clinic date per term: the attending on duty, the
director on point, and procedures booked. The readiness engine
(`computeClinicReadiness`) combines the assigned attending's capabilities with
the people on shift to tell directors whether the clinic can cover its booked
procedures.

## Compliance banner

The builder and views surface HIPAA compliance inline. `summarizeNonCompliant`
returns only the departments that have at least one scheduled volunteer whose
compliance status is not `COMPLIANT`, so directors see exactly who needs to
renew before clinic. Fully compliant departments are omitted.

## Permissions and scoping

The module declares four permissions:

| Permission | Grants |
| --- | --- |
| `schedule.view` | Access to the module and all of its pages. This is the module access permission. |
| `schedule.edit_own_dept` | Build and edit the schedule for departments the actor manages. |
| `schedule.edit_all` | Build and edit across all departments, and approve or deny requests anywhere. |
| `schedule.manage_requests` | Approve and deny swap and drop requests. |

Pages gate only on `schedule.view`. The services enforce the finer rules:

- **Builder writes** check that the target department is in the actor's
  manageable set on every mutation (`BuilderForbiddenError` otherwise).
- **Request approval and denial** are restricted to active directors of the
  department, a one-hop delegated manager department, or a holder of
  `schedule.edit_all`. Request creation and cancellation are requester-only.
- The manageable department set honors department **delegation**: a manager
  department can oversee its managed departments one hop out.

All mutating request operations run inside a single Prisma transaction, and
approval re-validates through the engine before applying any change.

## Data model

| Model | Role |
| --- | --- |
| `ShiftAssignment` | One person in one role, in one department, on one clinic date. Unique on `(termId, departmentId, clinicDate, personId)`. |
| `ShiftRequest` | Swap or drop request. Drop when target is null; swap otherwise. Status `PENDING`, `APPROVED`, `DENIED`, `CANCELLED`. |
| `ScheduleDay` | Per-department per-date operational data (currently patients booked). Unique on `(termId, departmentId, clinicDate)`. |
| `RhdAttending` | An RHD attending physician and their six-procedure qualification matrix. |
| `RhdClinic` | Per-Saturday RHD clinic row: attending on duty, director on point, procedures booked. Unique on `(termId, clinicDate)`. |
| `TermMembership` | Holds the three availability tiers and acknowledgment for a member in a department. |

Foreign keys to `Term` and `Department` use `onDelete: Restrict`, so a term or
department cannot be deleted while scheduling history references it. Assignments
cascade with the person.

## Code map

```
src/app/schedule/
  page.tsx                 My schedule
  full/page.tsx            Full clinic-wide schedule
  builder/page.tsx         Director builder
  attendings/              RHD attending roster pages
  layout.tsx               Module shell + nav

src/modules/schedule/
  services/
    schedule.ts            mySchedule, fullSchedule, updateMyAvailability
    requests.ts            create/cancel/list/approve/deny requests
    builder.ts             builderView + scoped assignment mutations
    attendings.ts          RHD attending roster CRUD
  engine/                  Pure logic (no Prisma), each with tests:
    availability.ts        Three-tier availability resolution
    requests.ts            Request validation + apply planning
    conflicts.ts           Same-day / cross-term conflict detection
    capacity.ts            Per-day capacity metrics
    rhd.ts                 RHD clinic readiness
    banner.ts              Non-compliant volunteer summary
    map.ts                 Date keys + schedule entry mapping
    display.ts             Date formatting for the UI
  components/              Builder grid, capacity panel, readiness panel, etc.
```

The `engine/` modules are pure (no database or platform imports) and each ships
with a colocated `.test.ts`. Services own persistence, permission scoping, and
audit logging; pages own gating and form handling.
