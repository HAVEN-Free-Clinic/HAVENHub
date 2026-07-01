# EHS Training Tracking — Design

- Date: 2026-07-01
- Status: Approved (design), pending spec review
- Branch: `feat/ehs-training-tracking`

## Context and problem

HAVEN tracks Environmental Health and Safety (EHS) trainings for all of its staff (volunteers and directors). Today this lives in an Airtable base ("Compliance" table, `appkxTQ19GmaHgW1O` / `tblxmEYGZ1ZKqSeK4`, 387 people), maintained by hand as per-person checkboxes.

HAVEN Hub is already the system of record for the other compliance items on that Airtable table:

- HIPAA certification (`HipaaCertificate`, with completion date, verification, expiry, reminders).
- Volunteer contract and volunteer training (onboarding gate, recruitment `Training`).

The outbound Airtable mirror was removed; the Airtable import is now read-only (one way into the app). So the goal is to bring **EHS training tracking** into HAVEN Hub as an internal compliance tool, replacing the EHS columns on the Airtable "Compliance" table.

The EHS items currently tracked (the non-HIPAA, non-contract, non-training checkboxes) are:

1. Added to EHS? (enrolled in Yale's EHS system)
2. BBP Clinical (Bloodborne Pathogens, clinical)
3. BBP Student (Bloodborne Pathogens, student)
4. Chemical - Hazard Communication
5. Biological - TB Awareness
6. TB Baseline Screening
7. Physical Safety - Respiration

The Airtable also has an "Overall Compliance" formula rolling HIPAA plus contract plus training plus EHS together. In HAVEN Hub, contract and training are enforced by the onboarding gate; HIPAA drives the compliance reminder engine. This feature folds EHS into that same compliance-reminder notion.

## Decisions (from brainstorming)

1. **Model: admin checklist plus dashboard.** A compliance manager marks each EHS item complete per person; a dashboard rolls up who is missing what. Booleans (with an optional completion date), no auto-expiry, admin-marked (no self-service uploads).
2. **Trainings: editable catalog with role scoping.** An admin-editable catalog of EHS training types, each of which can be required for everyone or for a scoped subset. The dashboard distinguishes "not required" from "incomplete".
3. **Applicability axis: department.** Each training is required for everyone or for specific clinic departments, reusing the Learning module's course-to-department assignment pattern. A person's departments come from their ACTIVE memberships in the active term.
4. **Visibility: My Info plus compliance reminders.** Each person sees their own EHS checklist read-only on My Info, and EHS incompleteness folds into the existing weekly compliance reminder plus director-escalation emails (no new cron, no new state machine).

### Assumptions to confirm

- **Population** on the dashboard equals the active-term roster (volunteers plus directors with an ACTIVE `TermMembership` in the active term). This is effectively forced by department-scoped applicability, since departments come from active memberships.
- **Permission** reuses the existing `volunteers.manage_compliance` (no new permission, so no RBAC grant backfill migration). Alternative: a dedicated `volunteers.manage_ehs` if EHS should be managed by a different group than HIPAA.
- **Seed defaults**: the "everyone" items (Added to EHS?, Hazard Communication, TB Awareness) seed as `requiredForAll = true`; the level-specific items (BBP Clinical, BBP Student, TB Baseline, Respiration) seed as `requiredForAll = false` with no departments, so they are required for nobody until an admin assigns departments (safe: no false non-compliance on day one).

## Non-goals (explicitly deferred)

- Per-item annual auto-expiry / renewal windows. Admins re-open an item by unchecking it. (EHS trainings do expire annually in reality, but v1 treats them as booleans per the chosen model.)
- Two-way Airtable sync. The outbound mirror is gone; the Airtable touchpoint is a one-time read-only seed import.
- Volunteer self-service completion. EHS items are marked by a compliance manager only.

## Architecture

The feature mirrors existing, production-tested patterns:

- Catalog and department scoping mirror `Course` / `CourseDepartment` and the pure `coursesForMember` assignment function in the Learning module.
- Per-person completion mirrors `CourseProgress`, but is admin-marked with audit fields rather than SCORM-driven.
- Reminder integration extends the existing `runComplianceReminders` engine and its `ComplianceReminder` state machine; it does not add a new engine or cron.
- The seed import mirrors the read-only HIPAA certificate backfill (`airtableRecordId` matching, dry-run by default).

### 1. Data model (Prisma)

Add three models. Exact field names/types to be finalized against the current schema at implementation, following existing conventions (cuid ids, `createdAt`/`updatedAt`, cascade rules).

**`EhsTraining`** (catalog; mirrors `Course`)

- `id`
- `name` (unique, e.g. "BBP Clinical")
- `description` (optional)
- `isActive` (boolean, default true)
- `requiredForAll` (boolean, default false) — when true, applies to every person regardless of department
- `position` (int, for ordering the catalog and dashboard columns)
- `createdAt`, `updatedAt`

**`EhsTrainingDepartment`** (join; mirrors `CourseDepartment`)

- `trainingId` -> `EhsTraining` (cascade delete)
- `departmentId` -> `Department` (cascade delete)
- Unique on `(trainingId, departmentId)`
- Only consulted when `requiredForAll = false`.

**`EhsCompletion`** (per-person completion; mirrors `CourseProgress`, admin-marked)

- `id`
- `personId` -> `Person` (cascade delete)
- `trainingId` -> `EhsTraining` (cascade delete)
- `completedAt` (date, optional; the real completion date, defaults to the marking date for manual entries, null for imports where the date is unknown)
- `source` (enum `MANUAL | IMPORT`, default `MANUAL`; mirrors `HipaaCertificate.source` provenance)
- `markedById` -> `Person` (optional; who toggled it complete, for audit; null for import rows which have no person actor)
- `markedAt` (datetime)
- `createdAt`, `updatedAt`
- Unique on `(personId, trainingId)`

Semantics: a present `EhsCompletion` row means "complete". Unchecking deletes the row and writes an `AuditLog` entry (`recordAudit`) capturing person, training, actor, and before/after. Completion is persistent per person (not per term), so a one-time item like TB Baseline stays complete across terms even though the person's *required* set can change term to term.

A seed migration inserts the 7 items with the seed defaults above.

### 2. Applicability engine (pure function)

Add a pure function analogous to Learning's `coursesForMember`:

```
requiredTrainingsForMember(trainings, memberDepartmentIds) -> trainingIds
  where a training applies when:
    training.isActive && (training.requiredForAll || overlaps(training.departmentIds, memberDepartmentIds))
```

- `memberDepartmentIds` = departments of the person's ACTIVE `TermMembership` rows in the active term.
- Per person the service derives four sets: required, completed, missing (required and not completed), and not-applicable (not required). "Missing" is what drives dashboard highlighting and the reminder determination.

Keep this in a pure module (no Prisma) so it is unit-testable in a worktree.

### 3. Admin surfaces (Volunteers module, gated by `volunteers.manage_compliance`)

- **EHS dashboard** at `/volunteers/ehs`:
  - Matrix: rows = active-term roster (volunteers plus directors), columns = active trainings (ordered by `position`).
  - Cell states: complete (with `completedAt` shown on hover/detail), missing, not-applicable.
  - Toggle a cell to mark complete (creates `EhsCompletion` with `completedAt` defaulting to today, editable; records `markedBy`; writes audit) or to un-complete (deletes the row; writes audit).
  - Filters: by department, and "missing only".
  - Summary counts (e.g. N people fully compliant on EHS, M with gaps).
- **Manage trainings** at `/volunteers/ehs/manage` (mirrors Learning "Manage courses"):
  - CRUD the catalog: name, description, `isActive`, `requiredForAll`, `position`.
  - Assign required departments when `requiredForAll = false`.

Register nav entries under the existing Volunteers module manifest (alongside the existing "Compliance" entry), both gated by `volunteers.manage_compliance`.

### 4. Self visibility (My Info)

Add a read-only EHS section to My Info (placed like the existing HIPAA panel) listing the signed-in person's **required** trainings with complete/missing status, for example:

```
EHS training
  [x] Chemical - Hazard Communication   (completed 2026-03-01)
  [ ] BBP Clinical                       (still needed)
```

Only the person's required items are shown (not-applicable items are omitted). No editing from My Info.

### 5. Reminder integration (reuses the existing engine)

Extend the "is this person compliant" determination inside `runComplianceReminders` (`src/platform/email/reminders.ts`):

- Define full compliance as `hipaaCompliant && noRequiredEhsMissing`.
- The existing `ComplianceReminder` per-person state machine (weekly dedup via `compliance.reminderIntervalDays`, `remindersSent`, escalation at `compliance.escalationThreshold` to department directors, reset on compliant) is reused unchanged. A person who is HIPAA-compliant but missing a required EHS item is now non-compliant and gets reminded; when both are satisfied, the row resets.
- Update the `compliance-reminder` and `compliance-escalation` email templates to enumerate exactly what is missing: HIPAA status (as today) and the specific missing EHS item names. Reuse the shared email layout (brand color already flows through `renderEmail`).
- No new cron and no new notification type; this rides the existing compliance-reminders trigger and `notify()` dispatch.

Care point: the reminder body composition must gracefully handle each combination (HIPAA only, EHS only, both), matching the "cert on file, no action" copy conventions already used elsewhere.

### 6. One-time Airtable seed import (read-only)

Extend the existing read-only import (mirroring `backfillCertificates`) with an EHS backfill step:

- Read the Compliance table's 7 EHS checkbox fields.
- Match Airtable records to `Person` by `airtableRecordId`.
- For each checked box whose catalog training exists, create an `EhsCompletion` row with `source = IMPORT`, `completedAt = null` (the date is unknown from Airtable; do not fabricate one), and `markedById = null`. This matches how the cert import records `source = IMPORT` with an unknown date.
- Dry-run by default (like the cert import), idempotent (skip existing completions).

This seeds day-one state so the dashboard is not empty. It is optional and can be vetoed; the feature works without it (admins would mark from scratch).

### 7. Testing

- **Pure-function unit tests (run in worktree):**
  - `requiredTrainingsForMember`: `requiredForAll` true, department overlap, no overlap, `isActive` false excluded.
  - Missing-set derivation: required minus completed.
  - Reminder compliance determination: HIPAA compliant plus EHS missing -> non-compliant; both satisfied -> compliant.
  - Reminder email enumeration: correct missing-item list for each HIPAA/EHS combination.
- **DB-backed service tests (run in CI):**
  - Toggle create/delete `EhsCompletion` with audit.
  - Dashboard population equals active-term roster.
  - Seed import idempotency and `airtableRecordId` matching.

Per the project constraint, DB-backed vitest is validated in CI, not in the worktree.

## Rollout and migration notes

- New migration adds the three models plus the seed insert of the 7 trainings. Follow the "trim new migrations to intended statements only" guidance (avoid folding pre-existing repo drift; declare any scalar list defaults explicitly).
- Production build runs `prisma migrate deploy` (not the seed script), so the 7-item seed must be part of the migration SQL (an idempotent INSERT), not only in `seed.ts`.
- No new RBAC grant if reusing `volunteers.manage_compliance` (avoids a system-role backfill migration). If a dedicated `volunteers.manage_ehs` is chosen instead, add it to `SYSTEM_ROLES` and include a grant backfill migration.
- Run `prisma migrate status` before any Neon deploy. Do not run `prisma migrate` or DB-backed vitest against the shared Neon DB from a worktree.

## Open questions for spec review

1. Confirm the population (active-term roster) and permission (`volunteers.manage_compliance` reuse vs dedicated `volunteers.manage_ehs`).
2. Confirm the seed defaults, especially whether BBP Clinical / BBP Student / TB Baseline / Respiration should ship pre-scoped to specific departments or start unassigned.
3. Confirm the one-time Airtable seed import is wanted (vs starting the dashboard empty).
4. Confirm folding EHS into the existing weekly compliance email is preferred over a separate EHS-specific email.
