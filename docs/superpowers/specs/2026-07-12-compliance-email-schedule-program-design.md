# Compliance, Email, and Schedule improvements: program design

Date: 2026-07-12
Author: brainstorming session (Jack + Claude)
Shape: five PRs by category, each CI-gated, following the team's established one-PR-per-change pattern.

This doc captures the whole program at a glance, then goes deep on the shared clearance
helper and **PR A** (the first sub-project). PRs E, C, B, and D are stubbed here and get
their design section expanded when we reach them.

---

## Decisions locked during brainstorming

1. **"Cleared to volunteer" means all six onboarding requirements**: profile/contact, HIPAA,
   volunteer/director training, learning courses, and EHS. Today three different definitions
   of "cleared" disagree; the compliance surfaces will converge on the real one.
2. **EHS block scope = clearance surfaces only.** EHS counts toward "cleared to volunteer" on
   the master view Overall column, the schedule clearance banner, and the reminders. It does
   **not** gate app access: app access keeps using the existing self-serviceable `onboarded`
   flag, so a volunteer who has done everything self-serve is never locked out of the hub
   waiting on a coordinator to record EHS.
3. **Email PR ships new conditions and nested groups together** (Airtable-style
   `GROUP A (x AND y) OR GROUP B (x OR y)`).
4. **Onboarding-step editor configures the six known steps** per term (and per track): toggle
   on/off, relabel, reorder, set blocking/non-blocking. Not a free-form custom-step builder.
5. **Scope = all of it.** Every item plus the shared foundation.

## Terminology: the three "cleared" notions today

- **Master/department `Overall`** = valid HIPAA cert AND volunteer-track training complete.
  Computed by `overallClearance()` in `src/platform/compliance/rules.ts`. Ignores EHS,
  learning, profile, director training.
- **`onboarded`** = all *blocking* onboarding tasks satisfied (profile, HIPAA, training,
  directorTraining, learning). EHS is `blocking:false`. This drives the app-wide gate.
- **`cleared`** = `onboarded` plus EHS. Everything. Only informational today.

After this program: the compliance **surfaces** use `cleared` (all six). The **app gate**
keeps using `onboarded`. That is exactly decision 2.

## Decomposition and build order

| PR | Category | Items | Size |
|----|----------|-------|------|
| **A** | Compliance dashboard | shared clearance helper + ① EHS/full-clearance in master view + ② dedicated per-person compliance view | M |
| **E** | Clinic schedule | ⑥ hide date strip in edit-availability + ⑦ HIPAA banner to clearance banner | S + M |
| **C** | Clearance reminders | ④ reminder covers all outstanding items, not just HIPAA/EHS | M |
| **B** | Email audience | ③ new conditions + nested groups | M + L |
| **D** | Onboarding steps | ⑤ per-term/track editable step config | L |

**Order: A -> E -> C -> B -> D.** PR A carries the shared clearance helper that E's banner,
C's reminder, and the master view all reuse, so it goes first. Item ⑥ (hide the date strip)
is a genuinely one-line change and can be split out as an instant merge ahead of everything
if we want a quick win; otherwise it rides in PR E.

---

## Foundation: batched clearance helper (lands in PR A)

### Problem
`getOnboardingStatus(personId)` is the authoritative per-person clearance computation, but it
is request-cached, per-person, and fans out to roughly nine DB queries per call. The master
view (hundreds of rows), the reminders cron (whole roster), and the schedule banner
(volunteers on a date) all need "is this person cleared, and what is missing" for many people
at once. Calling `getOnboardingStatus` in a loop is an N+1 explosion.

### Design
Add a batched sibling that reuses the existing **pure** derivation engine
(`deriveProfileTaskState`, `deriveHipaaTaskState`, `deriveTrainingTaskState`,
`deriveLearningTaskState`, `deriveEhsTaskState`, `computeGating` in
`src/modules/onboarding/engine/status.ts`) but feeds it batched inputs.

- **Location:** `src/modules/onboarding/services/clearance.ts` (the onboarding module owns the
  clearance concept). Cross-module consumers (volunteers, schedule, email) import it as the
  already-sanctioned platform/module exception used today for `getOnboardingStatus` (see the
  note in `src/platform/auth/session.ts`).
- **Signature:** `loadClearanceMap(personIds: string[], termId: string): Promise<Map<string, ClearanceSummary>>`
  where `ClearanceSummary = { onboarded: boolean; cleared: boolean; tasks: TaskState[]; missingBlocking: OnboardingTaskKey[]; missing: OnboardingTaskKey[] }`.
- **Batched loaders (one query each, not per person):** newest HIPAA cert per person; assigned
  courses + progress; required training tracks + progress; EHS missing map (reuse the existing
  batched `loadEhsMissingMap(termId)`); profile fields come off the person rows already loaded.
- **Then** run the same pure derive/gating functions per person in memory. Identical logic to
  the single-person path, so results cannot diverge.
- **DRY:** where practical, refactor `getOnboardingStatus` to delegate to the shared pure core
  so single and batched paths cannot drift. Keep the single-person orchestration/caching intact
  to avoid touching the app gate's hot path; the pure functions it calls are already shared.

### Tests
Unit test `loadClearanceMap` against a seeded set covering: fully cleared, missing each single
task kind, director-only vs volunteer vs both-track, and no-active-term (dormant) cases.
Assert it agrees with `getOnboardingStatus` for the same people (the anti-divergence check).

---

## PR A: Compliance dashboard (full design)

Covers the foundation above plus items ① and ②.

### A1. Master view uses real clearance (item ①)

**Files:** `src/modules/volunteers/services/compliance.ts` (masterCompliance + departmentCompliance),
`src/app/(app)/volunteers/master/page.tsx`, `src/app/(app)/volunteers/page.tsx`.

- In `masterCompliance()` / `departmentCompliance()`, call `loadClearanceMap()` once for the
  roster and attach a `clearance: ClearanceSummary` to each row.
- **Overall column** switches from `overallClearance(certStatus, trainingComplete)` to the
  row's `clearance.cleared` (all six requirements incl. EHS). The department view shares the
  service, so both surfaces move together (intended).
- **New columns / status chips:** add an **EHS** cell (Complete / N missing, linking to the
  EHS tab), and surface **Learning** and **Profile** state so a "Not cleared" row shows *why*.
  Simplest presentation: keep the existing Status (HIPAA) and Training columns, add EHS +
  Learning columns, and make the Overall cell expandable/tooltipped with the exact missing
  items. Add an EHS summary StatCard to the top chip row.
- **Director training:** rows for director-track members show director training instead of
  rendering "-". `clearance.tasks` already distinguishes `training` vs `directorTraining`.
- Copy: page subtitle changes from "HIPAA compliance status" to reflect full clearance.

**Open default (flag for review):** the `Training` column today only shows volunteer-track. I
plan to show whichever training applies to the member's track(s), unioned for both-track people.

### A2. Dedicated per-person compliance view (item ②)

Today the person name links to `/admin/people/[id]` (a generic edit form with zero compliance
content) and only for admins. Replace with a purpose-built compliance view.

**New route:** `src/app/(app)/volunteers/compliance/[personId]/page.tsx`, gated by
`requirePermission("volunteers.manage_compliance")`.

**Contents (reusing existing, personId-parameterized building blocks):**
- Header: name, departments, overall Cleared/Not-cleared badge.
- `ClearanceCard` (`src/modules/my-info/components/clearance-card.tsx`, already pure) driven by
  `getOnboardingStatus(personId)` / the new clearance summary: the full six-item checklist with
  per-item state.
- HIPAA cert block reusing the existing `CertificateViewer` plus the manager actions already on
  the master list (`setCompletionDateAsManager`, `verifyCertificate`) so a compliance manager
  can set a date / verify from here, matching what they can already do in the list.
- EHS status (read-only `EhsPanel`-style display of `getMyEhsStatus(personId)`), with a link to
  the EHS tab where completion is recorded.
- Learning status (read-only list of assigned courses + completion).

**Link change:** `src/app/(app)/volunteers/master/page.tsx` (~line 316) points the name at the
new route. **Default (flag for review):** drop the `isAdmin`-only gate so non-admin compliance
managers (who hold `volunteers.manage_compliance` and already see the whole table) also get the
link, instead of seeing plain text.

**Handled edge cases:** `getOnboardingStatus` marks `admin.access` holders `exempt:true`; the
view shows an "exempt" note rather than a misleading Not-cleared. Write panels that are wired to
self-service actions (cert upload, membership withdraw) are shown read-only or swapped for the
manager actions.

### A3. Tests
- Service test: master rows reflect `cleared` incl. EHS/learning; a person cleared on HIPAA but
  missing EHS now shows Not cleared.
- New route renders the checklist for an arbitrary person and is reachable by a
  `volunteers.manage_compliance` holder without `admin.access`.
- e2e: click a person in the master view, land on the compliance view (not the admin record).

### A4. Risks
- Changing `Overall` semantics also changes the department view (shared service). Intended, but
  call it out in the PR description.
- Perf: `loadClearanceMap` must be genuinely batched or the master view regresses. Covered by
  the foundation design.
- Naming: `getMyEhsStatus` / `listMyCertificates` are "my"-prefixed but take a personId; safe to
  reuse, just semantically self-labeled.

---

## PR E: Clinic schedule (stub, expand when we reach it)

- **⑥ Hide date strip in edit-availability:** the top `<nav aria-label="Clinic dates">` in
  `src/app/(app)/schedule/builder/page.tsx` (~line 559) renders in availability mode
  unnecessarily. Add `mode !== "availability"` to its guard. Keep the per-member date
  checkboxes inside `AvailabilityView` (those are the editing UI). One-line, single file.
- **⑦ HIPAA banner -> clearance banner:** `builderView()` in
  `src/modules/schedule/services/builder.ts` (~835) computes `banner` from HIPAA cert only, for
  volunteer-role assignees. Switch to the shared clearance helper (`cleared`, all six). Copy in
  `page.tsx` (~644) changes to "Clearance issues on this date". Generalize `banner.ts` from a
  HIPAA `ComplianceStatus` filter to a cleared/blocked boolean. Decisions to settle then:
  volunteer-only vs all scheduled roles; whether to keep flagging EXPIRING_SOON; whether to also
  surface in the grid view; whether "as of the clinic date" needs per-date cert-expiry math
  (today it bars against term-end).

## PR C: Clearance reminders (stub)

- Extend the existing `runComplianceReminders()` (`src/platform/email/reminders.ts`,
  `/api/cron/reminders`) so the nudge covers all outstanding clearance items (learning courses,
  training quizzes, profile), not just HIPAA + EHS. Reuse the shared clearance helper to find
  what each active-term member is missing. Reuse the `ComplianceReminder` dedup/escalation
  pattern and the `compliance` email template (extend its body to itemize every gap). Decide
  then: unify into the one compliance reminder vs a second engine; cadence/escalation.

## PR B: Email audience conditions + nested groups (stub)

- **New conditions** in `src/platform/email/audience/person-fields.ts`: EHS status, learning
  completion, onboarding/cleared state, incident/strike, tech tickets, offboard flag, verified
  cert. Direct relation filters are one registry entry each; derived ones (EHS missing,
  "completed all assigned courses") follow the existing precompute-a-per-person-map pattern used
  by `complianceStatus`.
- **Nested groups:** replace the flat `{ match, conditions[] }` in `types.ts` with a recursive
  group tree; make `compilePersonWhere` recursive (Prisma composes nested AND/OR natively);
  read-time shim wraps legacy flat audiences into a root group (JSON column, no migration);
  rewrite `audience-builder.tsx` to render nested groups with per-group match toggles and
  add-condition / add-group / remove controls. Decide then: nesting depth (one level vs
  arbitrary); per-course/per-training dynamic options vs coarse booleans.

## PR D: Editable per-term onboarding steps (stub)

- New DB model (e.g. `TermOnboardingStep { termId, track?, kind, label, description, href,
  ctaLabel, order, blocking, enabled }`) seeded from today's hardcoded six for existing terms.
- `getOnboardingStatus` / the assembly in `onboarding.ts` reads the term's configured steps and
  maps each `kind` to its existing derive helper (still bespoke per kind: this is a
  configure-the-known-steps editor, not arbitrary steps).
- New admin/recruitment UI to toggle/relabel/reorder/set-blocking per term and track, gated by
  a suitable permission. Decide then: editor home (term-settings admin page vs recruitment cycle
  overview) and permission; how configured training steps reconcile with the existing
  `requiredTrainingTracks` derivation; retroactivity (clearance is computed live, so changes
  take effect immediately unless we snapshot).

---

## Process

Each PR: expand its section here into a full design, get sign-off, run writing-plans for the
implementation plan, implement on its own branch with CI, open the PR. PR A goes first because
it carries the shared clearance helper the others depend on.
