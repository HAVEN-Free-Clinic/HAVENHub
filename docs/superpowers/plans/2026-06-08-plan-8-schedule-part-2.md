# Plan 8: Schedule Module Part 2 (Builder, Requests, Capacity, RHD Readiness) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the scheduler port: director builder (Saturday + full-term grid views, assign/shadow/availability modes, med-team tags, removal logging), the swap/drop request workflow end to end, the capacity panel, the HIPAA compliance banner, the RHD clinic-readiness panel, and the director availability override + acknowledge handshake.

**Architecture:** Spec: `docs/superpowers/specs/2026-06-08-schedule-part-2-design.md` (binding). Branch `plan-8/schedule-part-2` stacks on `plan-7/schedule-part-1` (PR #6); if #6 has merged by execution time, branch off main instead. Engine ports come from the LEGACY repo at `/Users/jcarney/Documents/Code-Projects/HAVEN-scheduler` ON BRANCH main (synced to github.com/jcarney2024/HAVEN-scheduler; read-only). Builder is server-first with small "use client" islands posting server actions. Services follow the offboarding.ts pattern: directorship scoping enforced internally, permissions at page/action layer, everything audited, isoDateKey for all date comparisons.

**Tech stack:** Existing stack only. No new dependencies.

**Decisions from Jack (binding):**
- Compliance banner is HIPAA-only (plan-5 engine). GridView ships in this plan. RHD included, Postgres masters with one-time import. Capacity fully ported; patients booked director-entered, never imported. Builder = server-first + client islands. Excel-import halves of legacy rhd.ts are NOT ported.

**Known Airtable facts (probed 2026-06-08, base appkxTQ19GmaHgW1O; reader returns field-id-keyed fields):**
- All People (tblnHgBpknuqWvx9c): Spanish Speaking checkbox `fldU9oI3O8CaB17j1`, Licensed RN checkbox `fld16LPmc7y1gQZ7K`. The Spanish checkbox is live-synced from application proficiency upstream, so the import reads ONLY the checkboxes.
- SU 26 roster (tbl2VrP1uqwFt7QNQ): one row per department; Department Name `fldBIGmgM2dU0vFUQ` (the department CODE), Ideal Headcount `fldKxrbiiBNty8aHq` (number), Patient Capacity Per Provider `fldYkBnHvszTKUHT0` (number).
- RHD Attendings (tblxDJehirZSLFJna): Schedule Name `fld0QTIYF1HHuIqZl`, Full Name `fldkejU9lGynjcHwD`, IUD In `fldgAtvQsr32XYzHc`, IUD Out `fld5CiOguHzJBh44H`, Nexplanon `fldJNpizKrDJXlkBq`, GAC `fldXmBJdo8mgBUgHT`, EMB `fldFLKPjXwZ4FQhVe`, Sees Male `fld9rxsLC5VZuyaSx`, Notes `fldh1FJjByriGBdb0`. Selects return objects or names; normalize to lowercase "yes"/"no", anything else -> "unknown".
- RHD Clinics (tbl0HrOcMHUQL0a6C): Date `fldfnW6GCdgXwVztA` (singleLineText: display strings like "June 6th" OR ISO; parse both), Attending link `fldUVqzqrSU4NTlHx`, Director on point `fldXCoZq8LKl3a3d2`, Procedures Booked `fldYIWobbtPV90FM5` (number).

**Conventions (binding):** no em-dashes; "HAVEN Hub" prose; UTC day keys via `@/platform/dates` isoDateKey; audits on mutations; TDD for engine/services/import cores; dry-run-default importers that never delete.

---

### Task 0: Branch + plan commit
- [ ] `git checkout plan-7/schedule-part-1 && git checkout -b plan-8/schedule-part-2` (or off main if PR #6 merged; cherry-pick the spec+plan docs commits from main: simplest is `git merge main` after branching when main has the docs). Commit this doc.

### Task 1: Schema
**Files:** `prisma/schema.prisma`, migration `schedule_part2`, `src/platform/test/db.ts`, `src/platform/config.ts` (+ test).
- Models/enum exactly per spec section 3: `ShiftRequestStatus`, `ShiftRequest` (relations: term Restrict, requester/target/decidedBy Person named relations: requester Cascade, target SetNull, decidedBy Restrict; department Restrict), `ScheduleDay` (term/department Restrict), `RhdAttending`, `RhdClinic` (term Restrict, attending SetNull). Person += `spanishSpeaking Boolean @default(false)`, `licensedRN Boolean @default(false)`. Department += `idealHeadcount Int?`, `patientCapacityPerProvider Int?`. Doc comments per spec; clinicDate fields carry the noon-UTC comment convention.
- Config: `RHD_MAX_PROCEDURES: z.string().default("3").transform(Number)` with positive-number refine (copy MAX_UPLOAD_MB's shape) + test.
- Migration additive-only inspection (STOP on DROPs); resetDb TRUNCATE gains `"ShiftRequest", "ScheduleDay", "RhdClinic", "RhdAttending"` (order: clinics before attendings is unnecessary with CASCADE, keep alphabetical-ish with FK sanity).
- `npm run test:prepare`, full `npm test`, `npm run typecheck`.
- Commit: `feat(schedule): part 2 schema (requests, schedule day, rhd, person flags, dept config)`

### Task 2: Engine ports (TDD)
**Files (all in `src/modules/schedule/engine/`):** `requests.ts` + `requests.test.ts`, `capacity.ts` + `capacity.test.ts`, `rhd.ts` + `rhd.test.ts`, `banner.ts` + `banner.test.ts`.
- **requests.ts:** port from legacy `server/requests.ts` (main branch): `validateRequest` VERBATIM semantics (types ScheduleRowForValidation/ValidateInput/ValidationResult; shadows drop-only; same-role named swaps; partner-eligibility messages exact). Port `planApply` RE-TARGETED: same role-resolution logic but emit assignment mutations instead of Airtable PatchOps:
```ts
export type AssignmentMutation =
  | { op: "remove"; personId: string; dateKey: string; role: Role }
  | { op: "add"; personId: string; dateKey: string; role: Role };
export function planApply(input: ApplyInput): AssignmentMutation[];
// drop -> [{remove requester}], swap -> [{remove requester@reqDate},{add target@reqDate},{remove target@targetDate},{add requester@targetDate}]
```
  Do NOT port executeApply/rollback (transaction in the service replaces it). Port the legacy validate/apply test suites (`server/tests/requests.validate.test.ts`, `requests.apply.test.ts`) adapting apply expectations to the mutation shape.
- **capacity.ts:** port `src/app/components/schedule/capacity.ts` from legacy main verbatim (computeDayMetrics, DayCounts/DayConfig/DayMetrics/Quota, quotaOf) + `rolesForDept(deptCode: string)` keyed on department CODE ("SCTP" -> triage+walkin, "JCTP" -> cc, else []). Port `src/tests/capacity.test.ts`.
- **rhd.ts:** port from legacy `server/rhd.ts` ONLY: ProcedureStatus/ProcedureKey/PROCEDURE_KEYS/Attending/PersonLite (rename RhdPersonLite to avoid clashing with the service PersonLite)/ClinicInput/ClinicReadiness/computeClinicReadiness/dedupeById. Do NOT port parseRhdCell/buildRhdImportPlan/RhdSheet types. Port the computeClinicReadiness cases from `server/tests/rhd.test.ts` (skip import-plan cases).
- **banner.ts (new, TDD):** HIPAA-only analog of legacy buildNonCompliantByDept:
```ts
export type BannerVolunteer = { id: string; name: string };
export type DeptBanner = { departmentId: string; departmentName: string; nonCompliant: BannerVolunteer[] };
export function summarizeNonCompliant(depts: Array<{ departmentId: string; departmentName: string; volunteers: Array<{ id: string; name: string; status: ComplianceStatus }> }>): DeptBanner[];
// nonCompliant = volunteers whose status !== "COMPLIANT"; departments with none are omitted.
```
  (ComplianceStatus from `@/platform/compliance/rules`; this file may import platform code: it is module code.)
- Engine purity: no prisma imports. Provenance doc comments (ported from legacy main, 2026-06-08). Full `npm test` + typecheck.
- Commit: `feat(schedule): engine ports (requests, capacity, rhd readiness, hipaa banner)`

### Task 3: Imports (cores TDD + scripts; live run is a controller checkpoint)
**Files:** `src/platform/airtable/import/schedule-config.ts` + `.test.ts`, `src/platform/airtable/import/rhd.ts` + `.test.ts`, `scripts/import-schedule-config.ts`, `scripts/import-rhd.ts`, `package.json` scripts, `src/platform/config.ts` (+test: `RHD_ATTENDINGS_TABLE_ID` default "tblxDJehirZSLFJna", `RHD_CLINICS_TABLE_ID` default "tbl0HrOcMHUQL0a6C").
- **schedule-config core:** `runScheduleConfigImport(reader, { baseId, peopleTableId, rosterTableId, dryRun })` -> `{ peopleScanned, spanishSet, rnSet, peopleUnresolved, departmentsScanned, deptConfigSet, unknownDepartments }`. People: read All People rows, for each with airtableRecordId match set spanishSpeaking/licensedRN from the two checkboxes (absent -> false; only UPDATE when changed; count sets). Roster: per row match Department Name (code, case-insensitive) -> set idealHeadcount/patientCapacityPerProvider (null when absent). Never unsets a true flag to false? NO: mirror the source exactly (checkbox false -> false) since Airtable is authoritative at cutover; count changes. Audit one `schedule.config_import` entry in apply mode.
- **rhd core:** `runRhdImport(reader, { baseId, attendingsTableId, clinicsTableId, termCode, dryRun })` -> `{ attendings: { created, updated, unchanged }, clinics: { created, updated, unchanged }, skippedClinicDates: string[], unresolvedAttendings: string[] }`. Attendings upsert by scheduleName; selects normalized ("Yes"/"yes" -> "yes", "No" -> "no", else "unknown"; select values may arrive as objects with .name or plain strings: handle both). Clinics: parse Date (ISO prefix OR "June 6th" display format: write a small `parseLegacyDate(raw: string, year: number): string | null` helper inside the core with tests: month-name + day with optional ordinal -> ISO; validate against term clinicDates by day key, else skippedClinicDates); resolve attending link -> RhdAttending by the source record id (track an `airtableRecordId String? @unique` column on RhdAttending? NO new column: resolve by reading the Attendings table first and mapping record id -> scheduleName -> our row). Upsert RhdClinic on (termId, clinicDate). Audit `schedule.rhd_import` in apply mode.
- Tests: fixture readers per core covering happy paths, change detection, unresolved/unknown/skipped reporting, idempotent second run, dry-run no-writes, both select shapes, both date formats.
- Scripts mirror import-schedule.ts (dry default, --apply). package.json: `import:config:dry/apply`, `import:rhd:dry/apply`.
- **Controller checkpoint:** dry-run both against live Airtable, review (expect ~600 people scanned, ~20 dept configs, ~handful attendings, 18 or fewer clinics), then apply; verify with psql (spanish/RN counts, dept config rows, attending + clinic counts) and spot-check one clinic row.
- Commit: `feat(schedule): person flags, dept config, and rhd imports`

### Task 4: Requests service (TDD)
**Files:** `src/modules/schedule/services/requests.ts` + `requests.test.ts`.
- Typed errors: `RequestForbiddenError`, `RequestNotFoundError`, `RequestValidationError` (carries the engine's message).
```ts
export async function createRequest(actorPersonId: string, input: { requesterDateKey: string; departmentId: string; targetId?: string; targetDateKey?: string; note?: string }): Promise<ShiftRequest>;
export async function cancelRequest(actorPersonId: string, requestId: string): Promise<void>;
export async function listDepartmentRequests(viewerPersonId: string, departmentId: string): Promise<RequestRow[]>; // PENDING first then decided desc; includes requester/target names
export async function approveRequest(actorPersonId: string, requestId: string): Promise<void>;
export async function denyRequest(actorPersonId: string, requestId: string, note?: string): Promise<void>;
export async function eligibleSwapPartners(actorPersonId: string, requesterDateKey: string, departmentId: string): Promise<Array<{ personId: string; name: string; dateKey: string }>>;
```
- `createRequest`: actor must hold the assignment (requesterDate+department, any role) in the ACTIVE term; build ScheduleRowForValidation[] from the department's term assignments via the engine map; run validateRequest; reject duplicates: an existing PENDING request by the actor for the same requesterDate+department -> RequestValidationError("You already have a pending request for this shift.") (the upstream race-safe duplicate guard, enforced inside the create transaction with a re-check). Audit `schedule.request`.
- `cancelRequest`: requester-only, PENDING-only. Audit `schedule.request_cancel`.
- `listDepartmentRequests` + `approveRequest`/`denyRequest` scope: viewer/actor directs the department (manageableDepartmentIds incl. delegation) OR can(actor, "schedule.edit_all").
- `approveRequest`: PENDING-only; RE-VALIDATE against CURRENT assignments (stale -> RequestValidationError, request stays PENDING); apply planApply mutations in ONE prisma.$transaction (remove = deleteMany on the unique tuple with role guard; add = create; NOTE: engine roles are lowercase "director"/"volunteer"/"shadow", map to the ShiftRole enum at the service boundary); set APPROVED + decidedBy/At in the same transaction. Audit `schedule.request_approve` with the mutation list.
- `denyRequest`: PENDING-only; DENIED + decidedBy/At + note appended. Audit `schedule.request_deny`.
- `eligibleSwapPartners`: same-role assignees in the same department on a DIFFERENT date (the actor's role on requesterDate determines the role), excluding the actor; sorted by date then name.
- Tests (resetDb): create happy drop + swap; not-assigned rejected; shadow swap rejected (engine message surfaced); duplicate PENDING rejected; cancel scope + status guards; approve drop removes the assignment; approve swap exchanges dates (assert all four mutations landed); approve re-validation failure when the target dropped out (no mutation, still PENDING); deny; scoping matrix (director own dept, delegated dept, edit_all, outsider Forbidden); eligibleSwapPartners role/date filtering.
- Commit: `feat(schedule): shift request service`

### Task 5: Viewer request UI
**Files:** `src/app/schedule/page.tsx` (modify), maybe `src/modules/schedule/components/request-form.tsx` (client island only if a plain form cannot express the partner select: PREFER plain server-rendered forms: drop needs none; swap partner select is a plain <Select>; no island needed).
- Each "My shifts" card gains: when an own PENDING request exists for that shift, show its state line + Cancel ConfirmButton; else a details/summary disclosure "Request a change" containing two forms: Drop (optional note Input, ConfirmButton "Request drop") and Swap (partner Select populated from eligibleSwapPartners showing "name (date)", submit "Request swap"). Server actions call the service, map typed errors -> `?error=` (encode the message; render via the validation-message pattern from disciplinary/page.tsx), success -> `?requested=1` line.
- mySchedule service return gains the person's PENDING requests per shift (extend the service + tests minimally: `pendingRequestByDateKey: Map<string, ShiftRequest>`).
- Full suite + typecheck + build.
- Commit: `feat(schedule): member swap and drop requests`

### Task 6: Builder service (TDD)
**Files:** `src/modules/schedule/services/builder.ts` + `builder.test.ts`.
- Typed errors `BuilderForbiddenError`, `BuilderValidationError`. Internal scoping helper: `manageableScheduleDepartmentIds(personId): Promise<string[]>` = manageableDepartmentIds(personId) (reuse) plus, when `can(personId, "schedule.edit_all")`, ALL department ids (return the full id list; no sentinel).
```ts
export async function builderView(viewerPersonId: string, opts: { departmentId?: string; dateKey?: string; now?: Date }): Promise<BuilderView>;
export async function setAssignment(actorPersonId: string, input: { departmentId: string; dateKey: string; personId: string; role: "VOLUNTEER" | "SHADOW" | "DIRECTOR" | null; reason?: string }): Promise<void>; // null role = unassign
export async function toggleTag(actorPersonId: string, input: { departmentId: string; dateKey: string; personId: string; tag: "triage" | "walkin" | "cc" | "remote" }): Promise<void>;
export async function setPatientsBooked(actorPersonId: string, input: { departmentId: string; dateKey: string; patientsBooked: number | null }): Promise<void>;
export async function setAvailabilityOverride(actorPersonId: string, input: { membershipId: string; dateKeys: string[] | null }): Promise<void>; // null clears the override tier
export async function acknowledgeAvailability(actorPersonId: string, membershipId: string): Promise<void>;
export async function upsertRhdClinic(actorPersonId: string, input: { dateKey: string; attendingId?: string | null; directorName?: string | null; proceduresBooked?: number | null }): Promise<void>;
```
- `builderView` returns: the viewer's selectable departments; selected department + date (default like fullSchedule); members (ACTIVE memberships) each with { person(id,name,spanishSpeaking,licensedRN), kind, availabilityTiers resolved + raw (for the availability mode), acknowledgePending: availabilityUpdatedAt set and acknowledgedAt null, legacyNote }; assignments for the WHOLE term for this department (grid view needs all dates) as `Map<dateKey, Map<personId, { role, tags }>>`; per-selected-date: capacity DayMetrics (counts from assignments + spanish flags; DayConfig from the department columns; patientsBooked from ScheduleDay), HIPAA banner data (members assigned on the date with newest cert -> complianceStatus, fed through summarizeNonCompliant), conflicts for assigned people (reuse engine), pending request count; RHD: when department code in {SCTS, JCTS, CCRH}: clinic readiness via computeClinicReadiness (attending from RhdClinic+RhdAttending, sctsOnShift/jctsOnShift/ccrhOnShift = VOLUNTEER+DIRECTOR assignees of those three departments on the date with their flags, proceduresBooked from RhdClinic, maxProceduresPerClinic from config) + the attending options list + current clinic row.
- All mutations: scope check (department in the actor's manageable set), active-term guard, audited (`schedule.assign`, `schedule.unassign` with reason + before, `schedule.tag`, `schedule.patients_booked`, `schedule.availability_override`, `schedule.availability_acknowledge`, `schedule.rhd_clinic`). setAssignment validates dateKey is a clinic date and the person has an ACTIVE membership in the department (DIRECTOR role assignment allowed for members with kind DIRECTOR only); unassign deletes the row (tags die with it). toggleTag requires an existing VOLUNTEER/DIRECTOR/SHADOW row (flip the boolean). setAvailabilityOverride writes canonical clinic dates (validate keys) + directorAvailabilitySetAt = now, or clears both when dateKeys null.
- Tests: scoping matrix; assign/unassign round trip + audits + reason captured; assign non-member rejected; DIRECTOR role for VOLUNTEER-kind member rejected; tag toggle on missing row rejected; capacity metrics math (spanish count, quotas, patient math with ScheduleDay); banner only non-compliant; availability override set/clear + acknowledge; RHD readiness composition (attending matrix passthrough, RN/spanish coverage from flags, cap warning, closed clinic) + clinic upsert; grid data covers all term dates.
- Commit: `feat(schedule): builder service`

### Task 7: Builder page: shell + Saturday view + modes
**Files:** `src/app/schedule/builder/page.tsx`, `src/modules/schedule/components/builder-cell.tsx` ("use client"), `src/platform/modules/registry.ts` (nav gains `{ label: "Builder", href: "/schedule/builder" }`).
- Page (server component): gate = `requireModuleAccess("schedule")` then builderView; viewers with zero selectable departments see "You do not direct any departments." Controls row: department Select (GET form), date tab strip (links preserving department+view+mode params), ViewToggle links (saturday|grid via ?view=), mode toggle links (assign|shadow|availability via ?mode=).
- Saturday view (default): two lists: Assigned (grouped by role: directors, volunteers with tag toggle buttons per rolesForDept + remote, shadows) and Available members (resolved-available on the date first, with availability badge; one-click Assign button per member: role from mode: assign->VOLUNTEER (or DIRECTOR for director-kind members via a small secondary button), shadow->SHADOW). Unassign: ConfirmButton with optional reason Input (RemoveVolunteerModal equivalent as an inline form).
- `builder-cell.tsx` client island: used in BOTH views for the clickable assignment control posting the server action via a form (useFormStatus pending state for feedback); keep it tiny (button + hidden inputs).
- Availability mode (Saturday view): per-member row: resolved tier badge + per-date checkboxes pre-filled from the OVERRIDE tier when set else resolved dates, Save override + Clear override buttons, Acknowledge button when acknowledgePending, legacy note shown.
- Server actions for every mutation re-check `requireModuleAccess("schedule")` and map typed errors -> `?error=` codes; revalidatePath("/schedule/builder").
- Full suite + typecheck + build.
- Commit: `feat(schedule): builder page with saturday view and modes`

### Task 8: Grid view
**Files:** `src/app/schedule/builder/page.tsx` (extend), reuse `builder-cell.tsx`.
- `?view=grid`: table rows = members (name + kind badge), columns = ALL term Saturdays (compact headers via displayDate), cells = current state glyph (D/V/S + tag dots + remote marker) with availability shading (muted background when the member is resolved-unavailable that date); in assign/shadow modes cells are builder-cell buttons cycling assign/unassign for the mode's role; availability mode renders read-only shading. Horizontal scroll wrapper for 18 columns; sticky first column.
- Commit: `feat(schedule): builder grid view`

### Task 9: Builder panels (capacity, banner, RHD, pending requests)
**Files:** `src/app/schedule/builder/page.tsx` (extend; split sections into server components under `src/modules/schedule/components/` if the page exceeds ~700 lines: `capacity-panel.tsx`, `readiness-panel.tsx`, `pending-requests.tsx`, all server components).
- Capacity panel (selected Saturday): metric rows from DayMetrics (headcount "n / ideal" with under/at/over tone, triage/walk-in/CC quota badges shown per rolesForDept, shadows, Spanish speakers, max patient capacity, patients booked inline edit form -> setPatientsBooked, patients to reschedule warning when > 0).
- Compliance banner: when banner data non-empty render an amber alert listing "Name (not HIPAA compliant)" per department section (the builder shows one department: a single list).
- RHD readiness panel (SCTS/JCTS/CCRH): attending select + director name Input + procedures booked Input form -> upsertRhdClinic; readiness readout: procedure matrix chips (yes/no/unknown tones), coverage counts (SCTM/JCTM/RN/Spanish), depo badge (ok/critical), cap warning, closed state, contact email list (copyable text).
- Pending requests tab/section: listDepartmentRequests rows (requester, type drop/swap with target+dates, note, created); Approve ConfirmButton / Deny with note Input; decided requests collapsed below (last 10). Errors from stale approvals surface via the ?error= banner.
- Full suite + typecheck + build.
- Commit: `feat(schedule): builder panels (capacity, banner, rhd readiness, pending requests)`

### Task 10: e2e + gauntlet + PR
**Files:** `e2e/schedule.spec.ts` (extend).
- e2e (~4, devLogin pattern, restore state, do not assert on specific imported people):
  1. Builder assign round trip: Jack opens /schedule/builder (ITCM director), sees the department control; assigns the first available member on the selected Saturday, sees them in Assigned, unassigns (with reason), sees them back in Available.
  2. Request round trip: dev.volunteer needs an assignment: Jack assigns dev.volunteer via the builder first; dev.volunteer files a drop request from /schedule; Jack approves it in the builder pending section; dev.volunteer's shift is gone. (Self-cleaning: the approval removes the assignment created in step one.)
  3. Capacity panel renders (metric labels visible) for the selected Saturday.
  4. RHD readiness panel renders for an SRHD-family department (switch the builder to SCTS as Platform Admin via edit_all; assert the readiness panel headings; skip gracefully if SCTS has no members: assert the panel frame regardless).
- Full gauntlet: lint, typecheck, npm test, build, e2e (29 + ~4 = ~33).
- Screenshots: /schedule/builder (saturday view + grid view + an RHD dept) -> /tmp/havenhub-shots/.
- Push; PR onto the plan-7 branch if PR #6 is still open (stacked PR base plan-7/schedule-part-1), else onto main. Summary covers builder, requests, capacity, RHD, imports (with live counts), and notes the legacy scheduler can be decommissioned. Watch CI green.

## Deferred deliberately (spec section 10)
- Login-log analytics; Airtable schedule mirroring; FA 26 bootstrap (term lifecycle plan)
- Contract/training compliance integration; recruitment-fed person flags
- Legacy scheduler decommission (manual, after this ships)
