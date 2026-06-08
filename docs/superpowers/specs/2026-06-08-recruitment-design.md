# Recruitment Module Design

**Date:** 2026-06-08
**Status:** Approved (brainstorm) — Plan 10 is the first implementation cycle
**Module id:** `recruitment` (currently `coming-soon` in the registry)

Recruitment replaces the per-cycle Airtable recruitment bases. The two canonical
Airtable bases this design is modeled on are **HAVEN Volunteer Recruitment**
(`appOq1yOiA1Lfzq8L`) and **HAVEN Director Recruitment** (`app6MHzSA1yPej2zX`). All
other recruitment bases (`[Outdated] …`, per-term `V-`/`D-` copies) are stale and
not authoritative.

---

## 1. Program overview

Recruitment is a **program**, not a single plan. It is a full applicant pipeline
for two tracks that share a spine but diverge in the middle.

**Shared spine:** a `RecruitmentCycle` (track = Volunteer | Director, term,
in-scope departments, status, public slug) bound to a versioned **form
definition**. Public applicants submit against the slug; authenticated staff
review.

**Tracks diverge:**

- **Volunteer:** Application → Review/score → Accept into dept → Onboarding
  contract → **Training + quiz** → roster promotion
- **Director:** Application → **Interview** (panel, evaluations, decision) →
  Accept → Director contract → roster promotion

**Renewals are a first-class path.** Returning members reapply to *renew* in a
department they are already in, and their application form is different from a new
applicant's (usually shorter, with "what did you contribute / do you want to
continue" style questions — mirrored by the Airtable "Returning Department",
"Return #1/2/3", "Have you volunteered before?" fields). A single recruitment
cycle serves **both** applicant types; the public form branches on applicant type
the same way it branches on department choice. See §4.6 and §6.

Downstream (later plans), renewals may follow a lighter review path than new
applicants — e.g. renewal applications route to the applicant's current
department director rather than the full review panel, and renewers skip
interviews. Plan 10 only captures the branch and the renewal data; the
differentiated downstream handling is specified in Plans 11–13.

**Touch points with existing modules** (Recruitment feeds these; it does not
rebuild them):

- **Admin** — accepted+onboarded applicants are promoted into the term roster as
  `Person` records.
- **Volunteers** — onboarding EPIC-access intake hands off to the existing Epic
  request flow.
- **My Info / compliance** — onboarding HIPAA certificate hands off to the
  existing compliance/certificate flow.

### 1.1 Decomposition (5 plans, sequenced by pipeline stage)

| Plan | Slice | Ships |
|------|-------|-------|
| **10** | Foundation + dynamic form builder + public intake | SRR builds a cycle form in-app, publishes a public link, applications flow in and are viewable |
| **11** | Review & acceptance (Volunteer) | Reviewer surface, scoring, dept-director review, accept into departments, acceptance emails |
| **12** | Director track: interviews | Interview scheduling, panels, evaluations, decisions → reuse acceptance |
| **13** | Onboarding/contracts + roster promotion | Tokenized contract (signatures, EPIC→Volunteers, HIPAA→compliance, identity) + promote accepted applicant into the term roster |
| **14** | Volunteer training + quiz | Attendance + knowledge check → compliance handoff |

The shared review/acceptance engine lands once (Plan 11) and the Director track
(Plan 12) reuses it. Each plan after 10 gets its own spec → plan → implementation
cycle.

**The remainder of this document specifies Plan 10 only.**

---

## 2. Plan 10 scope

A Recruitment module where a recruitment lead (SRR) can:

1. Create a recruitment cycle (track, term, in-scope departments).
2. Build that cycle's application form from scratch — dynamic sections and
   fields, including department-specific supplements.
3. Publish the cycle to a public link.
4. Receive applications submitted at that public link by unauthenticated
   applicants.
5. View submissions (read-only list + single-application view).

Out of scope for Plan 10 (later plans): reviewing/scoring, interviews,
acceptance, onboarding, training, roster promotion.

---

## 3. Architecture & boundaries

- New module under `src/modules/recruitment/{services,components,engine}`,
  following the Schedule/Volunteers module layout.
- Registry entry (`src/platform/modules/registry.ts`) flips `recruitment` from
  `status: "coming-soon"` to `status: "active"` and adds nav + the
  `manage_cycles` permission.
- **Module boundary rule** (lint-enforced): the module may import `platform`;
  it never imports another module. Cross-module needs (later: roster promotion,
  Epic handoff) go through platform services.
- **Public surface** lives at a top-level route `src/app/apply/[slug]/` — outside
  the authenticated hub shell and its module nav.

### 3.1 The public-route auth carve-out (key integration concern)

The platform gates every route behind Entra login + Person match. `/apply/[slug]`
is the one genuinely public surface and must be **explicitly exempted** from that
gate. The plan adds the carve-out in the auth/middleware config and guards the
route by other means:

- The cycle must be `OPEN` and within its `opensAt`/`closesAt` window; otherwise a
  closed-state page renders (no form, no submission).
- Basic abuse protection: a per-IP submission rate limit and the dedup rule
  (§6.4). PHI is never present (no patient data in recruitment).

---

## 4. Data model

All new tables. Prisma models (additive migration).

### RecruitmentCycle

| Field | Type | Notes |
|-------|------|-------|
| `id` | String @id @default(cuid()) | |
| `track` | enum `RecruitmentTrack` { VOLUNTEER, DIRECTOR } | |
| `termId` | String | FK → `Term` (onDelete: Restrict) |
| `title` | String | e.g. "Volunteer Recruitment — SU26" |
| `status` | enum `CycleStatus` { DRAFT, OPEN, CLOSED, ARCHIVED } | default DRAFT |
| `publicSlug` | String @unique | URL slug for `/apply/[slug]` |
| `opensAt` | DateTime? | optional open window start |
| `closesAt` | DateTime? | optional open window end |
| `departments` | String[] | in-scope department codes (canonical dept codes) |
| `acceptsRenewals` | Boolean | default false; when true the public form offers the renewal branch (§4.6, §6) |
| `createdById` | String | FK → `Person` |
| `createdAt` / `updatedAt` | DateTime | |

Back-relations: `sections FormSection[]`, `applicants Applicant[]`,
`applications Application[]`.

### FormSection

| Field | Type | Notes |
|-------|------|-------|
| `id` | String @id @default(cuid()) | |
| `cycleId` | String | FK → RecruitmentCycle (onDelete: Cascade) |
| `title` | String | |
| `description` | String? | |
| `order` | Int | sort within the form |
| `departmentCode` | String? | null = always shown; set = supplement shown only when applicant chooses that department |
| `appliesTo` | enum `ApplicantScope` { NEW, RENEWAL, BOTH } | default BOTH; which applicant type sees this section (§4.6) |

Back-relation: `fields FormField[]`.

### FormField

| Field | Type | Notes |
|-------|------|-------|
| `id` | String @id @default(cuid()) | |
| `sectionId` | String | FK → FormSection (onDelete: Cascade) |
| `cycleId` | String | FK → RecruitmentCycle (onDelete: Cascade); denormalized so `(cycleId, key)` is uniquely indexable |
| `key` | String | stable answer key; unique within a cycle; immutable once submissions exist |
| `label` | String | |
| `helpText` | String? | |
| `type` | enum `FieldType` | SHORT_TEXT, LONG_TEXT, SINGLE_SELECT, MULTI_SELECT, CHECKBOX, EMAIL, PHONE, NUMBER, DATE, FILE, DEPARTMENT_CHOICE |
| `required` | Boolean | default false |
| `options` | Json? | for selects: ordered list of `{value,label}`. Ignored for DEPARTMENT_CHOICE (options derive from the cycle's `departments`) |
| `validation` | Json? | `{ min?, max?, regex?, maxFileMB?, acceptedTypes? }` |
| `order` | Int | sort within the section |

`key` uniqueness is enforced per cycle via a DB unique index on `(cycleId, key)`
(see the denormalized `cycleId` column above), plus the service layer.

### The department-choice field

Supplement visibility is driven by a dedicated field type, **`DEPARTMENT_CHOICE`**,
rather than guessing from a free-form select:

- Its selectable options are derived from the cycle's `departments` (not from
  `FormField.options`), so the builder never duplicates the department list.
- It may be single- or multi-select (governed by `validation.max`, e.g. "rank up
  to 2"); the Airtable forms use 1st/2nd-choice department fields.
- The applicant's selected department codes populate `Application.departmentChoices`
  and are an input to the conditional-supplement resolver (§4.6). A
  `FormSection.departmentCode` supplement shows iff its code is among the chosen
  departments (and the section's `appliesTo` matches the applicant type).
- **Publish guard:** a cycle that has any `departmentCode`-tagged supplement
  section must contain exactly one `DEPARTMENT_CHOICE` field before it can move
  `DRAFT → OPEN` (otherwise no supplement could ever surface).

### 4.6 Renewal branch

A renewal is a returning member reapplying to continue in a department they are
already in, answering a *different* form. The model treats applicant type as a
second branching dimension alongside department:

- `RecruitmentCycle.acceptsRenewals` turns the branch on. When off, the cycle is
  new-applicants-only and behaves exactly as §4.1–4.5 describe.
- Every `FormSection` carries `appliesTo` ∈ { NEW, RENEWAL, BOTH } (default BOTH).
  Identity sections stay BOTH; new-applicant essays are tagged NEW; the shorter
  "do you want to continue / what did you contribute" sections are tagged RENEWAL.
- On the public form (§6), when `acceptsRenewals` is true the applicant first
  chooses **New applicant** or **Renewing**. This routing step is **built-in**
  (structural), not a builder-authored field — like the required identity fields.
- A NEW applicant answers the `DEPARTMENT_CHOICE` field (ranked choices), which
  drives new-applicant supplements. A RENEWAL applicant instead picks a **single
  current department** from the cycle's `departments` (built into the renewal
  branch), stored as `renewalDepartment`; that drives renewal supplements.
- **Identity can't be verified at intake** (public, no login). The
  `renewalDepartment` is self-asserted; confirming the applicant truly holds that
  department membership happens at review/acceptance time (Plan 11+), where the
  renewal application is matched to the existing `Person`.

**Conditional-supplement resolver (the single authority for visibility).** Given
`(applicantType, selectedDepartmentCodes)` — where `selectedDepartmentCodes` is
`departmentChoices` for NEW or `[renewalDepartment]` for RENEWAL — a section `S`
is visible iff:

1. `S.appliesTo ∈ { BOTH, applicantType }`, **and**
2. `S.departmentCode` is null **or** `S.departmentCode ∈ selectedDepartmentCodes`.

### Applicant

| Field | Type | Notes |
|-------|------|-------|
| `id` | String @id @default(cuid()) | |
| `cycleId` | String | FK → RecruitmentCycle (onDelete: Cascade) |
| `firstName` | String | |
| `lastName` | String | |
| `email` | String | |
| `netId` | String? | |
| `phone` | String? | |
| `createdAt` | DateTime | |

Dedup: unique index on `(cycleId, lower(email))` (Postgres expression index /
Prisma `@@unique` on a stored normalized column `emailLower`). Linking an
applicant to an existing `Person` is **deferred to Plan 13**; no `personId` yet.

### Application

| Field | Type | Notes |
|-------|------|-------|
| `id` | String @id @default(cuid()) | |
| `cycleId` | String | FK → RecruitmentCycle (onDelete: Cascade) |
| `applicantId` | String | FK → Applicant (onDelete: Cascade) |
| `answers` | Json | object keyed by `FormField.key` |
| `applicantType` | enum `ApplicantType` { NEW, RENEWAL } | default NEW; RENEWAL only possible when the cycle `acceptsRenewals` (§4.6) |
| `departmentChoices` | String[] | NEW: ranked department codes chosen. RENEWAL: the single current department, stored as a one-element array (see `renewalDepartment`) |
| `renewalDepartment` | String? | RENEWAL only: the department code the applicant is renewing in; must be one of the cycle's `departments`. Null for NEW |
| `status` | enum `ApplicationStatus` { SUBMITTED } | only SUBMITTED in Plan 10; later plans extend |
| `submittedAt` | DateTime @default(now()) | |
| `createdAt` / `updatedAt` | DateTime | |

Unique `(cycleId, applicantId)` — one application per applicant per cycle.

### Storage decision (recap)

Normalized definition (`FormSection`/`FormField`) + JSON answers on `Application`,
validated at write time by a zod schema **generated from the field definitions**.
Chosen over fully-normalized answer rows (too heavy/join-prone for file uploads
and rendering) and over an all-JSON model (no referential integrity on fields,
clumsy builder/versioning).

### File uploads

`FILE` answers reuse the existing local-filesystem mechanism from HIPAA
certificates (`UPLOAD_DIR`, `MAX_UPLOAD_MB`). Files are written under a
cycle-scoped path; the answer stores a file reference (path + original filename +
size + mime), never the blob. Per-field `maxFileMB`/`acceptedTypes` override the
global cap downward.

---

## 5. Authenticated surface (builder + submissions)

Routes under the module, guarded by `recruitment.manage_cycles`:

- `/recruitment` — cycle list (status, track, term, submission count).
- `/recruitment/cycles/new` — create cycle (track, term, title, departments).
- `/recruitment/cycles/[id]` — cycle overview + publish/close controls.
- `/recruitment/cycles/[id]/builder` — the form builder.
- `/recruitment/cycles/[id]/applicants` — read-only submissions list.
- `/recruitment/cycles/[id]/applicants/[applicationId]` — single application,
  answers rendered against the field definitions.

### 5.1 Builder UX

- The form is a vertical list of **sections**, each holding ordered **fields**.
- Sections and fields reorder via up/down controls (not drag-and-drop — matches
  the Schedule builder's server-action-friendly approach).
- Each field edits inline: label, help text, type, required, and type-specific
  extras (options for selects; `maxFileMB`/`acceptedTypes` for FILE; min/max/regex
  for text/number).
- A section tagged with a `departmentCode` becomes a **supplement** shown only
  when the applicant selects that department; untagged sections always show. This
  models the Airtable "SRHD Supplement", "MDIC Supplement", etc.
- Each section also has an **Applies to** selector — New applicants / Renewals /
  Both (default Both) — surfaced only when the cycle's "Accept renewals" toggle is
  on. This is how a lead builds the shorter renewal variant alongside the new
  form. The cycle overview carries the **Accept renewals** toggle itself.
- `FormField.key` auto-generates from the label (slugified, de-duplicated). It is
  **immutable once submissions exist** so historical answers never orphan.

### 5.2 Lifecycle guard

- `DRAFT`: builder fully editable.
- `OPEN` (published): structural edits that would invalidate existing answers are
  **blocked** (delete field, change `type`, optional→required). Safe edits remain
  allowed (label, help text, reorder, add an *optional* field).
- Publishing (`DRAFT → OPEN`) requires the core identity fields present — first
  name, last name, email — so every applicant is contactable and dedupable.
- When `acceptsRenewals` is true, publishing also requires at least one section
  visible to each applicant type (i.e. coverage for both NEW and RENEWAL after
  resolving `appliesTo`), so neither branch renders an empty form.
- `CLOSED`: public form stops accepting submissions; staff surfaces stay
  readable. `ARCHIVED`: hidden from the default cycle list.

---

## 6. Public intake (`/apply/[slug]`, no auth)

### 6.1 Render

1. Load cycle by `publicSlug`. If status ≠ `OPEN`, or now is outside
   `opensAt`/`closesAt`, render a closed-state page (no form).
2. If `acceptsRenewals`, the first step asks **New applicant or Renewing?**
   (built-in routing). A renewer then picks their single current department; a new
   applicant proceeds to the `DEPARTMENT_CHOICE` field.
3. Render the sections the resolver (§4.6) returns for `(applicantType,
   selectedDepartmentCodes)`; resolved client-side for UX.
4. The single authority for visibility is that same pure resolver, re-run
   **server-side** on submit.

### 6.2 Validate

`buildApplicationSchema(fields, applicantType, selectedDepartmentCodes)` builds a
zod schema from the *current* field definitions, restricted to the sections the
resolver (§4.6) deems visible for that applicant type and department selection.
Fields in non-visible sections (wrong applicant type, or unchosen-department
supplements) are **not** enforced. For RENEWAL submissions the server also checks
`renewalDepartment` is one of the cycle's `departments`. The client mirrors this
for inline UX but never decides — "UI reflects, server decides".

### 6.3 Files

Streamed to `UPLOAD_DIR` under a cycle-scoped path, capped by the field's
`maxFileMB` (falling back to `MAX_UPLOAD_MB`); the answer stores a file reference.

### 6.4 Dedup

If `(cycleId, lower(email))` already has an applicant, block with a friendly
"you've already applied" message rather than creating a duplicate.

### 6.5 Success

Confirmation page. A confirmation email is enqueued via the existing `EmailLog`
queue (email transport is live) so applicants get a receipt.

---

## 7. Permissions

Declared on the manifest, fed to the RBAC editor:

- `recruitment.access` — see the module + cycle list (manifest `accessPermission`).
- `recruitment.manage_cycles` — create/edit cycles, build forms, publish/close,
  view submissions.

Reviewer/acceptance permissions are **not** declared in Plan 10 (YAGNI — they
arrive with Plan 11). The public `/apply/[slug]` route is permission-free by
design.

---

## 8. Error handling

**Public form** — typed service errors map to friendly states:

- cycle-not-found / not-open → closed page.
- validation failure → field-level errors re-rendered with entered values
  preserved.
- duplicate submission → "already applied".
- file too large / wrong type → field error.
- upload write failure → retryable "couldn't save your upload" without losing the
  rest of the form.

**Builder** — structural-edit-after-open violations return a clear "this cycle is
published; that change would invalidate existing answers" message rather than a
500. Slug collisions surface as a validation error on the cycle form.

**Boundaries** — a React error boundary wraps the module (per platform spec) so a
builder crash never takes down the hub; the public route carries its own minimal
boundary since it renders outside the authed shell.

---

## 9. Testing strategy

**Engine (pure, unit):**

- `buildApplicationSchema` — each field type; required vs optional;
  regex/min/max; file constraints; scoping to visible sections only.
- conditional-supplement resolver (§4.6) — the `(applicantType,
  selectedDepartmentCodes)` matrix: NEW vs RENEWAL section visibility, department
  supplements, BOTH sections always shown; hidden required fields are not enforced.
- `key` generation + immutability.

**Services (integration, real DB):**

- cycle CRUD + status transitions (DRAFT→OPEN→CLOSED).
- publish guard rejects structurally-unsafe edits after OPEN; and (when
  `acceptsRenewals`) rejects publishing if either applicant-type branch is empty.
- submission: happy path, dedup block, validation rejection, file persistence.
- renewal submission: routes to RENEWAL sections, stores `applicantType` +
  `renewalDepartment`, rejects a `renewalDepartment` outside the cycle's
  departments.
- applicant-list read.

**e2e (Playwright):**

- Sign in as `j.carney@yale.edu` → create a cycle (renewals on) → add a BOTH
  identity section, a NEW-only section, and a department supplement → publish →
  open `/apply/[slug]` **unauthenticated** → submit once as a new applicant (with a
  file + department choice) and once via the renewing branch → both submissions
  appear in the authenticated applicant list, correctly typed. This proves the
  public/authenticated boundary, the whole loop, and the renewal branch.

---

## 10. Plan 10 done-criteria

- `recruitment` module is `active` in the registry with nav + permissions.
- SRR can build a cycle's form from scratch (dynamic sections/fields + department
  supplements) and publish a public link.
- A cycle can offer a **renewal branch**: renewers reapply into their current
  department via a different (typically shorter) form, captured with
  `applicantType` + `renewalDepartment`.
- Unauthenticated applicants submit at `/apply/[slug]`; submissions are validated,
  deduped, store file references, and appear in the authenticated applicant list.
- Public route is correctly exempted from the auth gate and refuses submissions
  for non-OPEN cycles.
- Unit + integration + e2e tests green; CI (lint incl. module-boundary, typecheck,
  tests) passes.
