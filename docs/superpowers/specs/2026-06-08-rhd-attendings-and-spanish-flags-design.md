# RHD Attending Editor + Spanish/RN Flags

Date: 2026-06-08
Status: Approved (design)
Branch: `rhd-attendings-spanish-flags` (stacked on `caprice` / PR #11)

## Context

Two attributes were ported from the clinic's scheduling spreadsheet and are currently
read-only in the app (only writable by the Airtable import):

1. **RHD attendings and their capabilities.** `RhdAttending` is already a Prisma model
   (`scheduleName`, `fullName`, six procedure capabilities `iudIn` / `iudOut` /
   `nexplanon` / `gac` / `emb` / `seesMale` each `"yes" | "no" | "unknown"`, `notes`,
   `isActive`). The RHD Clinic Readiness panel reads the **selected attending's**
   capabilities to show the IUD/Nexplanon/GAC/EMB/Sees-Male badges. Today there is no
   in-app way to manage the attending roster or edit a capability.
2. **Spanish-speaking and Licensed-RN flags.** `Person.spanishSpeaking` and
   `Person.licensedRN` exist, imported from Airtable, but are not editable in the people
   admin UI and only appear in the scheduler as aggregate counts (capacity "Spanish
   speakers: N", readiness "Spanish N / RN N"), never per person.

This work makes both editable in the app and surfaces the person flags per-person in the
scheduler. The website becomes authoritative for these attributes post-cutover.

## Goal

- Admins manage the **RHD attending roster + capabilities** in-app (full CRUD), with a
  quick-add shortcut from the readiness panel.
- `spanishSpeaking` and `licensedRN` are **editable** on the person record and shown as
  **per-person badges** in the schedule builder (counts unchanged).

## Non-goals

- The readiness *rules* stay hardcoded: Depo OK = `≥1 licensed RN on shift`, and the RHD
  family `RHD_CODES = {SCTS, JCTS, CCRH}`. Only the attending roster + capabilities
  become editable.
- No change to the Airtable import. Re-running it would overwrite in-app edits; post-
  cutover it is a one-time tool, not a sync. (Noted as an operational caveat, not built.)
- Per-person badges land in the **schedule builder** only. `/schedule/full` and
  `/schedule` are out of scope for badges this round (counts there are unchanged).

---

## Phase 1 — Spanish & RN flags

Smaller, lower-risk; build and verify first.

### 1a. Editable on the person record

- **Service** `src/modules/admin/services/people.ts`: extend the `PersonInput` type and
  `updatePersonFields` so `updatePerson` accepts `spanishSpeaking?: boolean` and
  `licensedRN?: boolean` and persists them to `Person`. Keep the existing audit-logging
  behavior.
- **Form** `src/modules/admin/components/person-form.tsx`: add two checkboxes
  ("Spanish-speaking", "Licensed RN") bound to the person's current values.
- **Detail page** `src/app/admin/people/[id]/page.tsx`: in `updateAction`, read the two
  checkbox values from `formData` (checkbox absent ⇒ `false`) and pass them to
  `updatePerson`. Gate unchanged (`requirePermission("admin.manage_people")`).
- **People list** `src/modules/admin/components/people-table.tsx`: add compact read-only
  `ES` / `RN` chips per row (shown when the flag is true), matching the Airtable-checkbox
  feel. Requires `searchPeople` to select `spanishSpeaking` / `licensedRN` (verify it
  returns them; add to the select if not).

### 1b. Per-person badges in the schedule builder

`BuilderMember.person` already carries `spanishSpeaking` and `licensedRN`, so no service
change. Add small `ES` / `RN` badges next to the person's name in
`src/app/schedule/builder/page.tsx`:

- the `assignCard` helper (Available / Not-available cards), and
- the Assigned column cards (directors, volunteers, shadows) — name is looked up via
  `memberByPersonId.get(pid).person`, which has both flags.

Use the existing `Badge` component with a subtle tone (e.g. `default`), labels `ES` and
`RN`, rendered only when the flag is true. Aggregate counts (capacity / readiness) stay.

### Phase 1 testing

- Unit: extend the people-service test (if present) to assert `updatePerson` persists
  `spanishSpeaking` / `licensedRN`.
- e2e (`e2e/schedule.spec.ts` or an admin e2e if one exists): a builder member with
  `spanishSpeaking` shows an `ES` badge. (dev.volunteer / seed data: confirm at least one
  member has the flag, or set one in the test.)

---

## Phase 2 — RHD attending editor

### 2a. Service

New `src/modules/schedule/services/attendings.ts` (sits with the other schedule services
and follows their patterns: scope check, validation, `writeAuditLog`):

- `listAttendings(actor)` → all `RhdAttending` ordered by `scheduleName` (active + inactive).
- `createAttending(actor, { scheduleName, fullName, capabilities, notes })` — validates
  non-empty `scheduleName` (unique; surface a friendly error on collision), `fullName`,
  and each capability ∈ `{"yes","no","unknown"}`; defaults capabilities to `"unknown"`.
- `updateAttending(actor, id, partial)` — same validation for provided fields.
- `setAttendingActive(actor, id, isActive)` — soft enable/disable (the readiness dropdown
  already filters `isActive: true`).

Define a `CAPABILITY_KEYS = ["iudIn","iudOut","nexplanon","gac","emb","seesMale"]` constant
and a `CapabilityValue = "yes" | "no" | "unknown"` type, reused by the service, the form,
and validation. Errors use a typed `AttendingValidationError` like the other services.

Permission gate: page access is `requireModuleAccess("schedule")`. **Mutations** in the
service enforce the RHD-manager scope (actor manages an RHD-family department) via an
`assertRhdManager(actor)` helper extracted from the `upsertRhdClinic` pattern, so a
platform admin or an RHD director can manage the roster, but a non-RHD schedule manager
cannot create/edit attendings. (We do NOT put this under `/admin` — `src/app/admin/layout.tsx`
gates every `/admin/*` page on `admin.access`, which RHD directors lack; the schedule
module is the correct home.)

### 2b. Management page

`src/app/schedule/attendings/page.tsx` (+ an `[id]` edit route, mirroring
`/admin/people`'s structure but gated by `requireModuleAccess("schedule")`):

- List table: Name (`scheduleName` / `fullName`), the six capabilities, Active, Edit link.
- Add / edit form (`AttendingForm` component under `src/modules/schedule/components/` or
  `src/modules/admin/components/`): text inputs for `scheduleName`, `fullName`, `notes`; a
  yes/no/unknown `Select` for each of the six capabilities; an Active toggle. Submits to
  server actions wrapping `createAttending` / `updateAttending` / `setAttendingActive`.

```
/schedule/attendings
────────────────────────────────────────────────────────────
Name      IUD-In  IUD-Out  Nexp  GAC  EMB  Male  Active
Rivera     yes     yes      yes   no   yes  no     ✓   [edit]
Chen       yes     unknown  yes   yes  yes  yes    ✓   [edit]
[＋ Add attending]
```

### 2c. Quick-add from the readiness panel

In `src/modules/schedule/components/readiness-panel.tsx` + `builder/page.tsx`:

- A small "＋ Add attending" disclosure (a `<details>` or always-visible mini-form) that
  creates a new `RhdAttending` (scheduleName + fullName; capabilities default `"unknown"`)
  via a new server action in `builder/page.tsx` wrapping `createAttending`. On success the
  page revalidates and the new attending appears in the Attending `<select>`.
- A "Manage attendings" link to `/schedule/attendings` for full capability editing.
- Quick-add gate: the existing RHD scope used by `upsertRhdClinic` (actor manages an RHD
  department), so an RHD director can add one without admin rights.

### Phase 2 testing

- Unit (`src/modules/schedule/services/attendings.test.ts`): `createAttending` rejects
  duplicate `scheduleName` and invalid capability values; `updateAttending` patches only
  provided fields; `setAttendingActive` toggles; capabilities default to `"unknown"`.
- e2e: from `/admin/rhd-attendings`, add an attending and edit a capability; assert it then
  appears in the readiness panel's Attending dropdown for an RHD department.

---

## Data / migrations

No schema changes required — `RhdAttending`, `RhdClinic`, `Person.spanishSpeaking`,
`Person.licensedRN` all already exist. No migration. (If the people-list chips need a
column the existing `searchPeople` query doesn't select, that's a query change, not a
migration.)

## Build order

Phase 1 (1a then 1b), then Phase 2 (2a → 2b → 2c). Each phase is independently shippable;
the single PR (stacked on #11) contains both.
