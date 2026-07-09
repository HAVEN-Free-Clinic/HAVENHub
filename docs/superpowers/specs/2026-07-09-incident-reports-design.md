# Incident Reports: professional-standards reporting with strike requests

Status: approved design, ready for implementation planning
Date: 2026-07-09
Author: Jack C (with Claude)

## 1. Summary

Move disciplinary handling out of the Volunteers module into a new top-level **Incident Reports** module at `/incidents` (permission namespace `incidents.*`). Today the only front door is a director recording a strike against a volunteer. The new front door is a **Professional Standards Incident Report** that any signed-in person can file about anyone, including a director, and that executive directors (central ops) review.

Strikes are kept exactly as they are today (the `DisciplinaryAction` model, where a person's "strikes" is a count of rows). The report is separate intake feeding a review queue. The one bridge between them: when a director files a report about a volunteer they manage, they can **request a strike**, which creates a pending request that a reviewer **approves** (issuing a `DisciplinaryAction`) or **declines**. Directors no longer issue strikes directly; they request. Directors keep a read-only view of their department's strikes.

CQA routing, SLA timers, and public unauthenticated submission are out of scope. This is purely incident reporting plus strike issuance.

## 2. Background and current state

The disciplinary feature lives entirely inside the Volunteers module and is small:

- **Model** `DisciplinaryAction` (`prisma/schema.prisma`): `personId` (subject, Cascade), `issuedById` (issuer, Restrict), `occurredAt`, `category` (plain `String`, validated in app), `description`, `followUpActions?`, `policyReference?`, `notes?`, `confidential` Boolean, `patientInvolved` Boolean, `createdAt`. There is no strikes table; a "strike" is one row. No status/severity.
- **Page** `src/app/(app)/volunteers/disciplinary/page.tsx` (route `/volunteers/disciplinary`): a "Record Disciplinary Action" form plus a filtered, paginated records table with a computed Strikes column. Server actions are inline in the page. Gated `requirePermission("volunteers.view")`.
- **Service** `src/modules/volunteers/services/disciplinary.ts` (+ `.test.ts`): `DISCIPLINARY_CATEGORIES`, typed errors, `issueAction`, `deleteAction`, `listActions`, `issuablePeople`, `strikeCount`, and internal helpers including `directorVisibility(viewerPersonId)` = `{ OR: [{ confidential: false }, { issuedById: viewerPersonId }] }` (a director sees a row only if it is not confidential or they issued it), plus `loadStrikeCounts` which applies that predicate so the Strikes column never leaks confidential rows.
- **Permissions**: `volunteers.view` (module access, held by directors via the Director baseline role) gates the page; `volunteers.issue_disciplinary` is the central "see all / issue against anyone / delete" permission. Directors issue within their manageable departments in the active term; central bypasses the scope check.
- **Registry / nav** `src/platform/modules/registry.ts`: the `volunteers` manifest lists `volunteers.issue_disciplinary` in `permissions[]` and a `{ label: "Disciplinary", href: "/volunteers/disciplinary" }` nav item (module-access gated only).
- **System roles** `src/platform/rbac/system-roles.ts`: "Volunteer Operations Manager" grants `volunteers.issue_disciplinary`; "Platform Admin" grants `"*"`.

### Platform primitives to reuse

- Module registry `src/platform/modules/registry.ts` (single wiring point); nav filtering `filterNavItems` in `src/platform/modules/access.ts`; page gates `requireModuleAccess` / `requirePermission` in `src/platform/auth/session.ts`.
- RBAC `can` / `getEffectivePermissions` in `src/platform/rbac/engine.ts`; valid-permission set built from `MODULES[*].permissions` by `src/modules/admin/services/rbac.ts`; system roles in `src/platform/rbac/system-roles.ts`.
- Department scoping `manageableDepartmentIds` (`src/platform/departments.ts`); active term `getActiveTerm` (`src/platform/terms/active-term.ts`).
- Notifications `notify(db, input)` (`src/platform/notifications/notify.ts`); type registry `NOTIFICATION_TYPES` (`src/platform/notifications/registry.ts`), admin-routable channel per type; email through the editable template engine (subset only: `{{#if}}`, `{{var}}`, `{{{raw}}}`, no `{{#each}}`).
- Uploads: Vercel Blob plus the shared `validateUploadedFile` size/MIME guard.
- Audit `recordAudit`; UI primitives Card, Badge (neutral chip plus status dot), Alert, Modal, PageHeader, SectionHeader, ModuleNav, Spinner, PageLoading, and the shared form controls.

## 3. Decisions (locked)

1. **Two records, one bridge.** `IncidentReport` is new front-door intake; `DisciplinaryAction` (strikes) is preserved. A report may request a strike; on approval a `DisciplinaryAction` is created and linked. Strike-count semantics are unchanged (a pending request lives on the report, not as a non-counting strike row).
2. **Module "Incident Reports"** at `/incidents`, namespace `incidents.*`. Top-level, **open to any signed-in matched person** (no `accessPermission`), so anyone can file about anyone.
3. **Reviewers reuse the central permission**, renamed `volunteers.issue_disciplinary` -> **`incidents.manage`**: review/triage all reports, approve or decline strike requests, and issue/edit/delete strikes.
4. **Directors: request only, read strikes.** A new read permission **`incidents.view_strikes`** (granted to the Director baseline role) keeps directors' read-only, department-scoped view of the strikes ledger via the existing `directorVisibility` predicate. Directors do not issue strikes directly; they request via a report.
5. **Strike trigger = ED approval gate.** A director filing a report about a volunteer they manage may request a strike (`strikeDecision = PENDING`). A reviewer approves (creates and links a `DisciplinaryAction`, counts) or declines (`DECLINED`, no action).
6. **Anonymity = do-not-share-with-subject.** The reporter is always identified server-side and always visible to reviewers. `anonymous` records the reporter's preference. Its one functional effect: an approved strike from an anonymous report defaults to `confidential = true`, so it is hidden from directors (only reviewers see it) via `directorVisibility`. This is the mechanism behind "directors read all department strikes unless anonymous."
7. **Subjects never see or are notified about reports.** The reporter sees only their own reports; reviewers see all.
8. **The full 10-section form is built faithfully.** Concern types are a multi-select of eight values validated in app (mirroring the existing `category`-as-`String` convention).
9. **No CQA routing, no SLA, no public submission** in this build. The "System / Adverse Event" concern type and the system-vs-individual question are captured only.

## 4. Data model

New Prisma models. `DisciplinaryAction` is unchanged except for one nullable back-link. The table is not renamed, so existing strike rows need no data migration.

### IncidentReport (new)

- `id` String cuid; `number` Int `@unique @default(autoincrement())` (human report number)
- `reporterId` -> Person (relation "incidentReportReporter", Restrict); always set
- `anonymous` Boolean `@default(false)` (section 10; reporter requested anonymity)
- `concernTypes` String[] `@default([])` (section 1; validated against `CONCERN_TYPES`)
- `description` String `@db.Text` (section 2, required)
- `occurredAt` DateTime? (section 3 date); `setting` String? (section 3 context)
- `subjectPersonId` -> Person? (relation "incidentReportSubject", SetNull) (section 4 when known); `subjectDescription` String? (section 4 as-observed)
- `patientImpact` `PatientImpact?`; `patientImpactDetail` String? (section 5)
- `immediateRisk` Boolean `@default(false)` (section 6)
- `issueNature` `IssueNature?` (section 7)
- `priorOccurrence` `PriorOccurrence?`; `priorOccurrenceDetail` String? (section 8)
- `status` `IncidentReportStatus @default(SUBMITTED)`
- `reviewNotes` String? `@db.Text` (reviewer-internal); `resolvedById` -> Person? (Restrict); `resolvedAt` DateTime?
- Strike bridge: `strikeDecision` `StrikeDecision?` (null = none requested); `strikeActionId` String? `@unique` -> DisciplinaryAction (SetNull); `strikeDecidedById` -> Person? (Restrict); `strikeDecidedAt` DateTime?
- `createdAt`, `updatedAt`
- Relations: `attachments IncidentReportAttachment[]`
- Indexes: `@@index([status])`, `@@index([reporterId])`, `@@index([subjectPersonId])`

### IncidentReportAttachment (new)

- `id`; `reportId` -> IncidentReport (Cascade)
- Blob fields: `url`, `pathname`, `filename`, `mimeType`, `size` Int
- `uploadedById` -> Person, `createdAt`
- `@@index([reportId])`

### DisciplinaryAction (kept, one addition)

- Add `reportId` String? `@unique` and the back-relation `incidentReport IncidentReport?`. All existing fields unchanged. On an approved request, `issuedById` = the approving reviewer, `personId` = the subject volunteer, `reportId` = the originating report. `strikeCount` / `loadStrikeCounts` are unchanged (every row is an issued strike).

### Enums (new)

- `PatientImpact { YES NO UNSURE }`
- `IssueNature { SYSTEM INDIVIDUAL BOTH_UNSURE }`
- `PriorOccurrence { YES NO UNSURE }`
- `IncidentReportStatus { SUBMITTED UNDER_REVIEW RESOLVED DISMISSED }`
- `StrikeDecision { PENDING APPROVED DECLINED }`

### CONCERN_TYPES (app constant, not a DB enum)

Eight values with label and helper text, in `src/modules/incidents/services/report.ts`, matching the form:

- `PATIENT_SAFETY` - failure to escalate, scope violations, medication errors, unsafe handoffs
- `PRIVACY_HIPAA` - unauthorized chart access, unsecured sharing, unlocked screens
- `PROFESSIONAL_CONDUCT` - disrespect, intimidation, discriminatory behavior, bullying
- `ROLE_SCOPE` - bypassing chain of command, unauthorized patient contact or referrals
- `DOCUMENTATION_WORKFLOW` - incomplete notes, unsigned tasks, referral mishandling
- `ATTENDANCE_RELIABILITY` - no-call/no-show, chronic late arrival, uncovered departures
- `SYSTEM_ADVERSE_EVENT` - workflow gap, near miss, delayed referral (non-punitive; captured only)
- `OTHER` - describe in the narrative

## 5. Module, routes, permissions

### 5.1 Registry and nav

Add to `MODULES`:

```
{
  id: "incidents",
  title: "Incident Reports",
  description: "Report a professional-standards concern; review reports and manage strikes",
  icon: ShieldAlert, // lucide; confirm during planning
  // no accessPermission: open to any signed-in matched person (like my-info)
  permissions: ["incidents.manage", "incidents.view_strikes"],
  status: "active",
  nav: [
    { label: "Report a concern", href: "/incidents" },
    { label: "My reports", href: "/incidents/mine" },
    { label: "Review", href: "/incidents/review", permission: "incidents.manage" },
    { label: "Strikes", href: "/incidents/strikes", permission: "incidents.view_strikes" },
  ],
}
```

Routes under `src/app/(app)/incidents/`:
- `layout.tsx` calls `requireModuleAccess("incidents")` and renders `<ModuleNav items={filterNavItems(mod.nav, perms)} />`
- `page.tsx` Report a concern form (everyone)
- `mine/page.tsx` My reports (everyone)
- `[id]/page.tsx` report detail (owner sees own; `incidents.manage` sees any; gate accordingly)
- `review/page.tsx` reviewer queue and triage, including strike approvals (requirePermission `incidents.manage`)
- `strikes/page.tsx` relocated strikes ledger (requirePermission `incidents.view_strikes`; write actions re-check `incidents.manage`)
- Attachment download via an authorized API route (owner or `incidents.manage`), reusing the existing inline-serving MIME allowlist pattern.

### 5.2 Permissions

- Introduce `incidents.manage` (rename of `volunteers.issue_disciplinary`) and `incidents.view_strikes` (new read).
- The strikes ledger read is admitted by `incidents.view_strikes` OR `incidents.manage`; every write path (`issueAction`, `deleteAction`, and the new `decideStrike`) requires `incidents.manage`.
- Filing a report needs no permission. The "request a strike" affordance is a capability check (reporter manages the subject volunteer's department AND the subject is a linked volunteer), reusing the existing scope helpers; it is not a permission.

### 5.3 Retirements and moves

- Move `src/app/(app)/volunteers/disciplinary/page.tsx` -> `src/app/(app)/incidents/strikes/page.tsx`; update its hardcoded `/volunteers/disciplinary` redirect URLs; add the `incidents` `layout.tsx`.
- Move `src/modules/volunteers/services/disciplinary.ts` (+ test) -> `src/modules/incidents/services/disciplinary.ts`; add `src/modules/incidents/services/report.ts`.
- Remove the `Disciplinary` nav item and `volunteers.issue_disciplinary` from the `volunteers` manifest; drop "disciplinary" from its description.
- Replace every `volunteers.issue_disciplinary` reference (service checks, page, `system-roles.ts`). The relocated strikes page gate changes from `volunteers.view` to `incidents.view_strikes`.

### 5.4 System roles and backfill

- `SYSTEM_ROLES`: "Volunteer Operations Manager" grants `incidents.manage` and `incidents.view_strikes` in place of `volunteers.issue_disciplinary`. The Director baseline role gains `incidents.view_strikes`. Platform Admin keeps `"*"`.
- Backfill migration (data): grant `incidents.manage` + `incidents.view_strikes` to every current holder of `volunteers.issue_disciplinary`; grant `incidents.view_strikes` to current directors (holders of the Director baseline grant); then remove the `volunteers.issue_disciplinary` grants. Production runs `migrate deploy`, not the seed, so the grant change needs an explicit backfill migration.

## 6. Behavior

### 6.1 Report a concern (`/incidents`, everyone)

The full form, sections 1 to 10. Subject (section 4) accepts a linked person when known and free text as observed. Section 6 "immediate risk" is a yes/no that flags urgent triage. Section 10 pre-fills the reporter's name from the session (read-only) with an "I would prefer to remain anonymous" checkbox.

If the reporter manages the subject volunteer's department and the subject is a linked volunteer, a **Request a strike** checkbox appears. It is unavailable when the subject is free text only or is not a volunteer the reporter manages.

On submit: create `IncidentReport` (status SUBMITTED, reporter = current person), persist attachments, set `strikeDecision = PENDING` if a strike was requested, and fire `incidents.report_submitted` (urgent variant when `immediateRisk`) plus `incidents.strike_requested` when applicable.

### 6.2 My reports (`/incidents/mine`, everyone)

The reporter's own reports (number, concern types, subject, status badge, last updated), newest first, each showing its strike-request status when present. Detail at `/incidents/[id]` for the owner shows the submitted fields and the current status. The reporter cannot see reviewer-internal notes.

### 6.3 Review (`/incidents/review`, `incidents.manage`)

Queue of all reports with filters (status, concern type, immediate-risk, strike-pending) and search over number / reporter / subject. Reviewer opens a report, sets status (UNDER_REVIEW, RESOLVED with `resolvedBy`/`resolvedAt`, or DISMISSED), and writes internal notes. For a pending strike request:

- **Approve**: create a `DisciplinaryAction` from the report (`personId` = subject, `issuedById` = reviewer, `occurredAt` = report date or now, `category` reviewer-selected and pre-filled best-effort from the concern types, `description` from the report and editable, `patientInvolved` = report patient impact is YES, `confidential` = the report's `anonymous`, `reportId` = report). Set `strikeDecision = APPROVED`, `strikeActionId`, `strikeDecidedBy`/`At`.
- **Decline**: set `strikeDecision = DECLINED`, no action created.

Either decision fires `incidents.strike_decided` to the requesting director.

### 6.4 Strikes (`/incidents/strikes`)

The relocated ledger. Holders of `incidents.view_strikes` (directors) read their department's non-confidential rows plus history via `directorVisibility`; holders of `incidents.manage` see all rows and can issue, edit, and delete directly. The record form and delete action live here for `incidents.manage`; directors have read only.

### 6.5 Status and strike lifecycle

Report: `SUBMITTED` -> `UNDER_REVIEW` -> `RESOLVED` or `DISMISSED`. Strike request (when present): `PENDING` -> `APPROVED` (a linked `DisciplinaryAction` now counts) or `DECLINED`. A strike request requires a linked subject person; if the subject is free text only, no strike can be requested.

## 7. Notifications and email

New types in `NOTIFICATION_TYPES` (each admin-routable to email / Teams / both), rendered through the editable template engine (precompute any lists as strings; no `{{#each}}`):

- `incidents.report_submitted`: to reviewers (holders of `incidents.manage`), with an urgent variant when `immediateRisk`.
- `incidents.strike_requested`: to reviewers, flagging a report that needs a strike decision.
- `incidents.strike_decided`: to the requesting reporter (approved or declined).
- `incidents.report_resolved`: to the reporter when a report is resolved or dismissed.

`notify()` is per-person, so reviewer fan-out resolves the holders of `incidents.manage` and notifies each. Subjects are never notified.

## 8. Testing and rollout

- Service unit tests (DB-backed, so CI is the gate per the shared-Prisma / worktree constraint): submit a report (any signed-in person); my-reports scoping (a reporter cannot read another's report); review-queue gating (a non-manager cannot reach `/incidents/review`); a strike request requires the reporter to manage the subject volunteer; approve creates a linked, counted `DisciplinaryAction` and an anonymous report yields a `confidential` strike; decline records `DECLINED` with no action; director read is scoped by `directorVisibility` (confidential rows hidden); relocated permission gating (`incidents.view_strikes` reads, `incidents.manage` writes).
- Notification tests: each new type queues on the resolved channel; the reviewer fan-out targets `incidents.manage` holders; subjects are never notified.
- Playwright e2e: file a report -> appears in My reports -> reviewer sees it in the queue -> resolve; director requests a strike -> reviewer approves -> the strike appears and counts. Move the disciplinary coverage out of `e2e/volunteers.spec.ts` into an incidents spec.
- Migration: additive `IncidentReport` / `IncidentReportAttachment` / enums plus the `DisciplinaryAction.reportId` column and the RBAC grant backfill. `String[] @default([])` must emit `DEFAULT ARRAY[]::TEXT[]`, and new migrations must be trimmed of pre-existing repo drift. Verify with `prisma migrate status` before the Neon deploy (previews share the prod DB, so a branch behind a migration crashes P2021 at runtime).
- UI: reuse existing primitives; neutral status styling (Badge plus status dot, no tinted fills); no em-dashes in copy; "HAVEN Hub" as two words in prose.

## 9. Out of scope (this build)

- CQA routing, a CQA queue, and any system-vs-individual auto-routing (fields captured only).
- SLA timers, business-hours math, and overdue automation.
- Public (unauthenticated) submission; reporters must be signed-in matched persons.
- Changing strike-count semantics or the `DisciplinaryAction` schema beyond the `reportId` link.
- Striking a subject who is not a linked person, or director-initiated strikes without a report.

## 10. Open questions

None blocking. To confirm during planning: the exact lucide icon for the module; whether the reviewer queue should default-sort immediate-risk reports to the top; and whether a resolved/dismissed report should also surface a short outcome line to the reporter in My reports beyond the status badge.
