# Schedule Module Part 1: Schema, Engine Port, Viewer

**Date:** 2026-06-07
**Status:** Approved design, pre-implementation
**Builds on:** Plans 1-6 (platform, import/mirror, admin, my-info, volunteers)
**Legacy source:** /Users/jcarney/Documents/Code-Projects/HAVEN-scheduler (Vite SPA + server over the SU 26 Airtable tables)

## 1. Goal

Bring the Schedule module live in HAVEN Hub: the normalized schedule data model, the SU 26 schedule imported from Airtable, the legacy scheduler's pure engine modules ported with their tests, and the volunteer-facing viewer (my assignments, full schedule, structured availability self-update). The director builder, capacity math, RHD panel, and the request/approval workflow follow in Schedule Part 2 (Plan 8).

## 2. Binding decisions (from Jack)

- The Schedule port splits into two plans. Part 1 (this spec): schema + SU 26 import + engine port + read-only viewer + availability self-update. Part 2: builder, capacity, RHD, compliance banners, the whole request workflow, director availability override UI.
- **Cutover is mid-term:** the SU 26 schedule is imported into Postgres and the legacy scheduler retires now. No Airtable schedule mirroring (revisit only if a shift-reminder automation turns out to need it).
- **Requests are entirely Part 2.** No half-shipped request creation without approvals.
- **Availability self-update becomes structured:** volunteers tick the term's clinic Saturdays. The legacy free-text field is kept read-only as a note for directors until FA 26, then dropped.
- **Data model is normalized per-person assignment rows** (option A), not Airtable-shaped array rows.

**Conventions (binding):** no em-dashes; "HAVEN Hub" prose; UTC dates (clinic dates anchored at 12:00 UTC like the seed); audits on mutations; services trust callers; permission checks at page/action layer.

## 3. Data model

One migration. New enum + model:

```prisma
enum ShiftRole { DIRECTOR VOLUNTEER SHADOW }

/// One row per person per clinic shift. Med-team tags apply to VOLUNTEER rows;
/// the legacy invariant holds: a triage/walk-in/CC designee is also on shift
/// (their row IS the on-shift row, tags are attributes of it).
model ShiftAssignment {
  id           String    @id @default(cuid())
  termId       String
  departmentId String
  personId     String
  clinicDate   DateTime
  role         ShiftRole
  triage       Boolean   @default(false)
  walkin       Boolean   @default(false)
  cc           Boolean   @default(false)
  remote       Boolean   @default(false)
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  // relations: term, department (Restrict), person (Cascade)
  @@unique([termId, departmentId, clinicDate, personId])
  @@index([termId, clinicDate])
  @@index([personId, termId])
}
```

TermMembership gains the structured availability tiers (fields land now; the director-override UI is Part 2):

```prisma
  /// Tier 2: structured self-update (replaces free-text selfUpdatedAvailability).
  /// Presence is signaled by availabilityUpdatedAt (existing field).
  selfAvailabilityDates     DateTime[]
  /// Tier 1: director override. Empty-but-set is distinguished from never-set
  /// by directorAvailabilitySetAt.
  directorAvailabilityDates DateTime[]
  directorAvailabilitySetAt DateTime?
```

- Resolution order (pure function): director override when `directorAvailabilitySetAt` is set, else self-update when `availabilityUpdatedAt` is set, else `baselineAvailability`.
- `selfUpdatedAvailability` (free text) is NOT migrated or removed; it renders read-only as a legacy note until FA 26.
- The acknowledge handshake keeps its meaning: a new self-update clears `availabilityAcknowledgedAt`; directors re-acknowledge in Part 2.

## 4. SU 26 import

`scripts/import-schedule.ts` (dry-run default, `--apply`), following the conventions of the existing importers:

- Reads the SU 26 Schedule Airtable table (one row per Saturday per department: Directors on Shift / Volunteers on Shift / Shadow Volunteers on Shift links, plus med-team role fields). Exact field IDs are probed during implementation.
- Resolves linked people via `Person.airtableRecordId`; resolves the department and term from the row; creates ShiftAssignment rows idempotently (upsert on the unique key). Med-team tags set the booleans on the volunteer's row, preserving the on-shift invariant.
- Reports: created/updated/unchanged counts, unresolved person links (recordIds), unknown departments or dates.
- Shift Requests and the Removal Log are NOT imported: requests restart fresh in Part 2; legacy logs stay in Airtable for reference.
- The table's "Remote on Shift" links map to the `remote` boolean tag (discovered during planning; same invariant as the other tags). The per-row "Patients Booked" number is NOT imported (it is clinic-ops data with no Part 1 consumer; revisit if Part 2 needs it).

## 5. Engine port (`src/modules/schedule/engine/`)

Ported from the legacy server with their test suites, term-parameterized:

- `conflicts.ts`: near-verbatim port (it already consumes abstract `ScheduleEntry[]`). A mapper builds entries from ShiftAssignment rows grouped by (date, department). Shadows still count for same-day conflicts.
- `availability.ts` (new, TDD): the three-tier resolution + `isAvailableOn(membership, date)` predicate.
- `dates.ts`: the legacy Saturday-generation logic is replaced by `Term.clinicDates`; surviving date helpers (display formatting, ISO keys) port as pure functions with adapted tests.
- NOT ported in Part 1: `requests.ts` (validate/apply/rollback), capacity, RHD, compliance banner. They port in Part 2 against the same mapping layer.

## 6. Service (`src/modules/schedule/services/schedule.ts`)

Trusts callers (page gates permissions):

- `mySchedule(personId)`: active-term assignments for the person (date, department, role, tags), their resolved availability tiers, and the term's clinic dates.
- `fullSchedule(termId?)`: active term by default. All assignments grouped by clinicDate then department, with person names and same-day cross-department conflict annotations from the ported engine. No N+1 (single fetch + in-memory grouping, per the codebase standard).
- `updateMyAvailability(personId, dates: Date[])`: validates each date is one of the term's clinic dates (typed validation error otherwise); requires an ACTIVE membership in the active term; writes `selfAvailabilityDates` + `availabilityUpdatedAt = now`, clears `availabilityAcknowledgedAt`. Audited `schedule.availability_update` with before/after date arrays. When the person holds multiple ACTIVE memberships, the update applies to all of them (availability is per person per term in practice; the legacy app treated it per person).

## 7. Pages

Registry: schedule module flips to `active`, nav `[{My schedule, /schedule}, {Full schedule, /schedule/full}]`. Layout via `requireModuleAccess("schedule")` (accessPermission `schedule.view`; the seeded Director and Volunteer roles already grant it).

- **`/schedule`**: the signed-in member's view. Assignment cards grouped by date (department, role Badge, med-team tags). Availability panel: checkbox per clinic date, pre-checked from the member's resolved availability (which falls back to baseline when they have never self-updated), the legacy free-text note rendered read-only when present, save button posting to `updateMyAvailability`. Members with no active membership see a friendly empty state.
- **`/schedule/full`**: read-only clinic-wide schedule. Saturday tab strip (`?date=` param, defaulting to the next upcoming clinic date), department sections listing directors, volunteers (with triage/walk-in/CC tags), and shadows. Same-day cross-department conflict badges. UTC dates everywhere.

## 8. Testing

- Ported engine tests (conflicts, surviving date helpers) plus new TDD tests for availability resolution.
- Service integration tests (resetDb): mySchedule shapes, fullSchedule grouping + conflict annotation, updateMyAvailability validation/audit/acknowledge-clearing, multi-membership write.
- Import script logic factored into a testable function with fixture rows (like the existing importer tests).
- e2e (~3): Jack sees /schedule with the availability panel; /schedule/full renders a Saturday with assignments; dev.volunteer updates availability and the page reflects it.

## 9. Deferred to Schedule Part 2 (Plan 8)

- Director builder (assign/shadow/availability/pending-request modes; Saturday-card + term-grid layouts)
- Capacity math (SCTP/JCTP rules) + capacity panel
- RHD clinic-readiness panel
- Compliance banners in the builder
- Request workflow end to end (validate/apply/rollback engine, creation UI, approval tab)
- Director availability override + acknowledge UI; removal logging surface
- Dropping the legacy free-text availability field (after FA 26 bootstrap)
