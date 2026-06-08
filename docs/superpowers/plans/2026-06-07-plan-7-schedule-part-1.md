# Plan 7: Schedule Module Part 1 (Schema, SU 26 Import, Engine Port, Viewer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Schedule module live: normalized ShiftAssignment schema, the SU 26 schedule imported from Airtable, the legacy scheduler's conflict/date engine ported with tests, structured three-tier availability, and the member-facing viewer (/schedule, /schedule/full). The legacy scheduler retires at cutover.

**Architecture:** Spec: `docs/superpowers/specs/2026-06-07-schedule-part-1-design.md` (binding; includes the remote-tag amendment). Engine pure modules live in `src/modules/schedule/engine/`; the service in `src/modules/schedule/services/schedule.ts` trusts callers; pages gate via `requireModuleAccess("schedule")` + the layout. The importer follows the existing `src/platform/airtable/import/` pattern (testable core + thin script). Legacy source for ports: `/Users/jcarney/Documents/Code-Projects/HAVEN-scheduler` (read-only reference; never modify it).

**Tech stack:** Existing stack only. No new dependencies.

**Decisions from Jack (binding):**
- Mid-term cutover: SU 26 schedule imports into Postgres; no Airtable schedule mirroring; legacy app retires.
- Requests/builder/capacity/RHD/compliance banners/director-override UI are ALL Part 2 (Plan 8). Do not port `requests.ts`, capacity, RHD, or `compliance.ts` banner logic.
- Availability self-update is structured clinic-date checkboxes; a new self-update clears `availabilityAcknowledgedAt`; the legacy free-text `selfUpdatedAvailability` renders read-only as a note and is NOT migrated or removed.
- Data model is normalized per-person rows (ShiftAssignment) with role + tag booleans (triage, walkin, cc, remote).
- "Patients Booked" is not imported.

**Known Airtable facts (probed 2026-06-07, base appkxTQ19GmaHgW1O):** SU 26 Schedule table `tblqJlM85Em0AA767`; fields: Department `fldaSd4YRUcgQSQMi` (link), Date `fldRqPKWn6NxzoJXZ` (date), Directors on Shift `fldWECXlelGfP9Sb0`, Volunteers on Shift `fldMoCbSA44uhyjxx`, Shadow Volunteers on Shift `fldqFDr9lu1Ih4YC0`, Remote on Shift `fldvZalLmfRQijopm`, Triage on Shift `fldmQasTpGxocBz9l`, Walk-in on Shift `fldepAQbnkNquxSYd`, CC on Shift `fldxyf4junebaIIYQ` (all links to All People). Department links point at the SU 26 roster table rows, NOT the Department table: the importer must verify this against real data on its first dry run (read one record, inspect the link target) and resolve via the roster row's department code if so; STOP and report if the link shape differs from both assumptions.

**Conventions (binding):** no em-dashes; "HAVEN Hub" prose; UTC dates (clinic dates at 12:00 UTC like the seed); audits on mutations; services trust callers; permission checks at page/action layer; TDD for engine/service/import core.

---

### Task 0: Branch + plan commit
- [ ] `git checkout -b plan-7/schedule-part-1`; commit this doc (the spec is already on main).

### Task 1: Schema
**Files:** `prisma/schema.prisma`, migration `schedule_part1`, `src/platform/test/db.ts`.
- Add `enum ShiftRole { DIRECTOR VOLUNTEER SHADOW }` and model `ShiftAssignment` exactly per spec section 3 (id cuid, termId, departmentId, personId, clinicDate DateTime, role ShiftRole, triage/walkin/cc/remote Boolean @default(false), createdAt/updatedAt, `@@unique([termId, departmentId, clinicDate, personId])`, `@@index([termId, clinicDate])`, `@@index([personId, termId])`). Relations: term Restrict, department Restrict, person Cascade (assignments are meaningless without the person; term/department deletions must not silently destroy schedule history). Doc comment per the spec including the tag invariant.
- TermMembership gains: `selfAvailabilityDates DateTime[]`, `directorAvailabilityDates DateTime[]`, `directorAvailabilitySetAt DateTime?` with the spec's comments (tier semantics; presence markers).
- `npx prisma migrate dev --name schedule_part1`; INSPECT SQL: additive only (CREATE TYPE/TABLE/INDEX + ALTER TABLE "TermMembership" ADD COLUMN x3 + FKs on the new table). STOP on any DROP or any ALTER of other existing objects.
- `resetDb()` TRUNCATE list gains `"ShiftAssignment"`.
- `npm run test:prepare`, `npm test` (all green), `npm run typecheck`.
- Commit: `feat(schedule): shift assignment schema + availability tiers`

### Task 2: Engine (TDD)
**Files:** `src/modules/schedule/engine/conflicts.ts` + `conflicts.test.ts`, `src/modules/schedule/engine/availability.ts` + `availability.test.ts`, `src/modules/schedule/engine/display.ts` + `display.test.ts`, `src/modules/schedule/engine/map.ts` + `map.test.ts`.
- **conflicts.ts:** port `/Users/jcarney/Documents/Code-Projects/HAVEN-scheduler/server/conflicts.ts` near-verbatim (types `ScheduleEntry`, `Conflicts`, function `computeConflicts`; keep the shadow-counts-for-conflicts comment). Port its legacy tests from `/Users/jcarney/Documents/Code-Projects/HAVEN-scheduler/server/tests/conflicts.test.ts`, adapted to vitest imports if needed. ISO date strings remain the engine currency (pure module; no Date objects).
- **map.ts (new, TDD):** the bridge from DB rows to engine shapes:
```ts
export type AssignmentRow = { departmentId: string; departmentName: string; personId: string; clinicDate: Date; role: "DIRECTOR" | "VOLUNTEER" | "SHADOW" };
export function isoDateKey(d: Date): string;                       // UTC YYYY-MM-DD
export function toScheduleEntries(rows: AssignmentRow[]): ScheduleEntry[]; // group by (dateKey, departmentId), split ids by role
```
Tests: grouping, role splitting, stable output ordering (sort by date then departmentName), empty input.
- **availability.ts (new, TDD):**
```ts
export type AvailabilityTiers = { baseline: Date[]; selfDates: Date[]; selfUpdatedAt: Date | null; directorDates: Date[]; directorSetAt: Date | null };
export type ResolvedAvailability = { dates: Date[]; tier: "DIRECTOR" | "SELF" | "BASELINE" };
export function resolveAvailability(t: AvailabilityTiers): ResolvedAvailability; // director when directorSetAt set, else self when selfUpdatedAt set, else baseline
export function isAvailableOn(t: AvailabilityTiers, date: Date): boolean;        // UTC day-key comparison
```
Tests: each tier wins correctly; empty-but-set director override yields zero dates with tier DIRECTOR; day-key comparison ignores time-of-day; never-set falls to baseline.
- **display.ts:** port `displayDate(iso)` (+ its ordinal SUFFIX logic) from the legacy `server/dates.ts` with tests ("2026-07-04" -> "July 4th", 11-13 edge "July 11th", "August 1st", "August 22nd", "August 23rd"). Do NOT port CANONICAL_DATES or the flexible date parser (term-parameterized now; the parser served free-text availability, which is retired).
- Full `npm test` + `npm run typecheck`. Commit: `feat(schedule): engine port (conflicts, availability tiers, display dates)`

### Task 3: Schedule service (TDD)
**Files:** `src/modules/schedule/services/schedule.ts` + `schedule.test.ts`.
- Typed error `AvailabilityValidationError`. Module top comment: service trusts callers for permissions; `updateMyAvailability` enforces only data validity.
```ts
export type MyShift = { clinicDate: Date; department: Department; role: ShiftRole; tags: { triage: boolean; walkin: boolean; cc: boolean; remote: boolean } };
export async function mySchedule(personId: string): Promise<{ term: Term | null; shifts: MyShift[]; availability: ResolvedAvailability | null; legacyNote: string | null; clinicDates: Date[] }>;
export async function fullSchedule(dateKey?: string, now?: Date): Promise<{ term: Term | null; clinicDates: Date[]; selectedDate: Date | null; departments: FullScheduleDepartment[] }>; // now defaults to new Date(); injectable for tests
export async function updateMyAvailability(actorPersonId: string, dates: Date[]): Promise<void>;
```
- `mySchedule`: active term (null-safe: all fields empty/null when no active term); the person's ShiftAssignments in it (include department, order by clinicDate), tags from the booleans; availability resolved via the engine from their ACTIVE membership(s) in the term (when multiple, tiers come from the first membership ordered by department code, with a comment: availability is per person in practice; Part 2 may consolidate); `legacyNote` = the membership's `selfUpdatedAvailability` (first non-null).
- `fullSchedule(dateKey?)`: active term; `selectedDate` = the clinic date matching dateKey (UTC YYYY-MM-DD), else the next upcoming clinic date (>= today UTC), else the last one. Loads ALL assignments for the selected date plus the person-id set of assignments across the whole term for conflict computation: build `ScheduleEntry[]` for the FULL term via `toScheduleEntries`, run `computeConflicts` per person appearing on the selected date (sameDay only is displayed in Part 1; keep the full Conflicts return available). Returns departments sorted by code, each `{ department, directors: PersonLite[], volunteers: Array<PersonLite & { tags }>, shadows: PersonLite[], conflicts: Map<personId, string[]> }` where the string[] is other-department names on the same day. PersonLite = { id, name }. Single findMany + in-memory grouping; no N+1.
- `updateMyAvailability(actor, dates)`: active term required, actor must hold >= 1 ACTIVE membership in it (else `AvailabilityValidationError("You are not on the active term roster.")`); every date must be one of `term.clinicDates` (UTC day-key comparison; reject otherwise listing the bad dates); dedupe + sort dates; update ALL the actor's ACTIVE memberships in the term: `selfAvailabilityDates = dates`, `availabilityUpdatedAt = now`, `availabilityAcknowledgedAt = null`. Audit `schedule.availability_update` with before/after arrays (ISO day keys) per membership or one entry with membership ids (one entry; keep it compact).
- Tests (resetDb; fixtures in the style of the volunteers services): mySchedule shapes incl. tags + legacyNote + no-active-term; fullSchedule date selection (param hit, default next-upcoming with a frozen `now` injected: accept an optional `now: Date` parameter defaulting to `new Date()` for testability), grouping, conflict annotation (person assigned in two departments same Saturday shows the other dept name on both sides), shadow counts in conflicts; updateMyAvailability happy path (both memberships updated, acknowledge cleared, audit row), non-clinic-date rejection, no-membership rejection, dedupe.
- Commit: `feat(schedule): schedule service (my schedule, full schedule, availability)`

### Task 4: SU 26 schedule import
**Files:** `src/platform/airtable/import/schedule.ts` + `schedule.test.ts`, `scripts/import-schedule.ts`, `src/platform/config.ts` (+ config.test.ts), `package.json` scripts.
- Config: `SU26_SCHEDULE_TABLE_ID: z.string().default("tblqJlM85Em0AA767")`. Test: default applies.
- `schedule.ts` core, following `importer.ts` conventions (AirtableReader-style injection, dry-run report):
```ts
export type ScheduleImportOptions = { baseId: string; scheduleTableId: string; termCode: string; dryRun: boolean };
export type ScheduleImportReport = { rows: number; created: number; updated: number; unchanged: number; unresolvedPeople: Array<{ rowId: string; recordId: string }>; unknownDepartments: string[]; skippedDates: string[] };
export async function runScheduleImport(reader: AirtableReader, options: ScheduleImportOptions): Promise<ScheduleImportReport>;
```
  - Reads all rows; per row: Date field -> clinic date (must be one of the term's clinicDates by UTC day key, else counted in skippedDates and skipped); Department link resolved as follows: read the linked record id; FIRST dry run must verify what table it points to (the plan's Airtable facts say it may link to the SU 26 roster table rather than Department): resolve the department by looking up the roster row's department code via the existing roster import helpers OR, if it links elsewhere, STOP and report BLOCKED with a sample record JSON. Person links resolve via `Person.airtableRecordId`; unresolved ids land in unresolvedPeople and are skipped individually (the row still imports the resolvable people).
  - Builds the desired ShiftAssignment set per row: directors (role DIRECTOR), volunteers (VOLUNTEER), shadows (SHADOW), and tag links (Triage/Walk-in/CC/Remote) set booleans on the matching VOLUNTEER row, CREATING the volunteer row when the person appears only in a tag list (legacy invariant: tag implies on-shift).
  - Apply mode upserts on the unique key and updates tag booleans/role when changed; counts created/updated/unchanged. NEVER deletes rows (re-running after manual platform edits must not destroy them; report-only drift is fine for a one-time cutover import).
  - Audit one summary entry `schedule.import` (apply mode only) with the report counts.
- Tests: fixture reader rows covering role splitting, tag-implies-on-shift creation, unresolved person, non-clinic date skip, idempotent re-run (second run all unchanged), update path (tag flips).
- `scripts/import-schedule.ts`: thin wrapper like import-airtable.ts (dry default, `--apply`, term code "SU26"). package.json: `import:schedule:dry` / `import:schedule:apply`.
- **Controller step:** run dry against live Airtable, review the report (especially the department-link probe + unresolvedPeople), then apply. Verify in psql: assignment counts per date look like the real schedule; spot-check one Saturday against the legacy app/Airtable.
- Commit: `feat(schedule): su26 schedule import`

### Task 5: Pages + registry
**Files:** `src/app/schedule/layout.tsx`, `src/app/schedule/page.tsx`, `src/app/schedule/full/page.tsx`, `src/platform/modules/registry.ts`.
- Registry: schedule module `status: "active"`, nav `[{ label: "My schedule", href: "/schedule" }, { label: "Full schedule", href: "/schedule/full" }]`. Permissions list stays as declared in plan 1.
- `layout.tsx`: copy the volunteers layout shape (`requireModuleAccess("schedule")`, ModuleNav).
- `/schedule` (server component): `mySchedule(session.personId)`. Sections: (1) "My shifts": cards grouped by date (fmtDate UTC; department name, role Badge: Director default / Volunteer default / Shadow warning; tag Badges for triage/walk-in/CC/remote), empty state "No shifts assigned yet."; (2) "My availability": form with one checkbox per `clinicDates` entry labeled with `displayDate(isoDateKey(date))`, pre-checked from `availability.dates`; legacy note rendered read-only in a muted box when `legacyNote` is present ("Note you submitted in the old scheduler:"); save button -> server action calling `updateMyAvailability` (catch AvailabilityValidationError -> `?error=` + banner; success -> `?saved=1` + confirmation line). When `term` is null: single empty state. No-membership users see the shifts section + an explanatory line instead of the form (the action error covers direct posts).
- `/schedule/full`: `fullSchedule(sp.date)`. Saturday tab strip across `clinicDates` (links with `?date=YYYY-MM-DD`, selected highlighted, same visual pattern as the volunteers filter bars; tab labels via displayDate). Department sections: directors line, volunteers table/list with tag Badges, shadows line, conflict Badge (tone warning, title listing other departments) next to conflicted names. Empty states per section and for no-active-term.
- `npm test`, `npm run typecheck`, `npm run build` green (pkill dev servers first).
- Commit: `feat(schedule): viewer pages (my schedule, full schedule)`

### Task 6: e2e + final verification + PR
**Files:** `e2e/schedule.spec.ts` (new).
- e2e (devLogin pattern from e2e/volunteers.spec.ts): (1) Jack opens /schedule, sees the "My availability" heading and at least one clinic-date checkbox; (2) Jack opens /schedule/full, sees the date tab strip and at least one department section (seeded/imported data dependent: assert on structure, not specific names); (3) dev.volunteer updates availability: uncheck one date, save, reload, the box stays unchecked; restore it after (round trip, no residue).
- Full gauntlet: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run e2e` (29 = 26 + 3).
- Screenshots: /schedule and /schedule/full -> /tmp/havenhub-shots/.
- Push, PR (summary: schema, import results incl. row counts from Task 4's apply, engine port, viewer; note the legacy scheduler can now retire and Part 2 scope), watch CI green.

## Deferred deliberately (Plan 8: Schedule Part 2)
- Director builder, capacity (SCTP/JCTP), RHD panel, compliance banners
- Request workflow end to end (port of legacy requests.ts validate/apply/rollback + UI)
- Director availability override + acknowledge UI; removal logging surface
- Dropping the legacy free-text availability field (post FA 26)
