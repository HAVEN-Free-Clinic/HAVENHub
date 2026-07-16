# Recruitment default form templates — design

- **Date:** 2026-07-14
- **Status:** Draft (awaiting review)
- **Branch:** feat/yale-sso-applicant-onramp
- **Author:** Jack C (with Claude)

## Problem

Creating a recruitment cycle today seeds only three fields — `first_name`,
`last_name`, `email` (`src/modules/recruitment/services/cycles.ts:43-49`).
Every department supplement, eligibility gate, availability picker,
acknowledgement, onboarding/contract block, and training question is rebuilt by
hand each cycle in the form builder. HAVEN has run this whole lifecycle in
Airtable for years; the goal is to make a new HAVEN Hub cycle start from a
faithful replica of those Airtable forms so directors tweak rather than rebuild.

## Goal

Ship **code-level default form templates, one per track (VOLUNTEER, DIRECTOR)**,
that materialize into a new cycle's editable `FormSection`/`FormField` rows at
creation time. Everything stays editable in DRAFT exactly as today. The shipped
content is modeled faithfully on the six linked Airtable forms.

## Source forms (Airtable)

Full field/option inventory captured in
`scratchpad/airtable-form-inventory.md`. The six forms:

| # | Form | Base / table | Maps to |
|---|------|--------------|---------|
| 1 | HAVEN Volunteer Recruitment SU26 | `appOq1yOiA1Lfzq8L` / `tblV3UrQQvIIZzFTU` | Volunteer application template |
| 2 | HAVEN Spring 2026 Board Application | `app6MHzSA1yPej2zX` / `tbluFoybFPBjBAXyk` | Director application template |
| 3 | SU-26 Volunteer Contract | `appOq1yOiA1Lfzq8L` / `tblW5qmRckmvz1QGX` | Volunteer contract default layout |
| 4 | HAVEN D-SP26 Director Contracts | `app6MHzSA1yPej2zX` / `tblLLg179HDssV8Of` | Director contract default layout |
| 5 | Volunteer Training Attendance | `appOq1yOiA1Lfzq8L` / `tblFZNiYufv2JjkUd` | Existing training intake (no change) |
| 6 | SU 26 Make-up Training | `appOq1yOiA1Lfzq8L` / `tblYCz2mApTikDK90` | Training quiz template |

Airtable **lazy-renders** the conditional per-department supplements, and its
table schema only exposes generic field names ("BVHD Supplement 1"). Faithful
question text is extracted by driving each form's department selector and
reading the rendered page (`get_page_text`, proven working). This extraction is
the main content-authoring task and happens during implementation.

## Decisions (locked with the user)

1. **Maintenance model:** code-level defaults, tweaked per cycle. No admin UI to
   edit the org-wide default; changing the default itself is a code change (PR).
   Mirrors the existing onboarding-checklist `STEP_DEFAULTS` pattern.
2. **Fidelity:** full — real question wording from the live forms, including
   per-department supplements.
3. **Structure:** composable code template (Approach A) — reusable field-group
   builders composed per track, materialized into rows at `createCycle`.
4. **Training quiz:** materialized into **every** cycle at `createCycle`
   (QUIZ-purpose sections), not gated on training designation.
5. **Quiz answer key:** ship **without** `correctValue`; directors set correct
   answers per cycle in the existing quiz builder.

## Current state (grounding)

- **Form model is already dynamic and per-cycle.** `RecruitmentCycle` →
  `FormSection` (`cycleId`, `title`, `order`, `departmentCode?`, `appliesTo
  ApplicantScope`, `purpose FormPurpose`) → `FormField` (`sectionId`, `cycleId`,
  `key`, `label`, `helpText?`, `type FieldType`, `required`, `options Json?`,
  `correctValue String?`, `order`; `@@unique([cycleId, key])`).
- **Field types available** (`FieldType`): `SHORT_TEXT`, `LONG_TEXT`,
  `SINGLE_SELECT`, `MULTI_SELECT`, `CHECKBOX`, `EMAIL`, `PHONE`, `NUMBER`,
  `DATE`, `FILE`, `DEPARTMENT_CHOICE`, `SUBCOMMITTEE_RANK`.
- **`createCycle`** (`services/cycles.ts:27-55`) creates the cycle + a "Your
  information" section (`order 0`, `appliesTo BOTH`) + the three identity fields,
  inside one transaction (section first so both ids exist, then `createMany`
  fields with `cycleId` set — `FormField.cycleId` is required so it can't be a
  nested create).
- **`publishCycle`** (`services/cycles.ts:84-99`) validates: `first_name` /
  `last_name` / `email` keys present; and **if any section has a
  `departmentCode`, exactly one `DEPARTMENT_CHOICE` field must exist**.
- **`assertCycleEditable(cycleId, structural)`** (`services/form-builder.ts`)
  blocks structural edits once a cycle leaves DRAFT.
- **Visibility engine** (`engine/visibility.ts`) already hides sections by
  `appliesTo` (NEW/RENEWAL/BOTH) and by `departmentCode` vs the applicant's
  chosen departments. `DEPARTMENT_CHOICE` options are injected live at
  render/submit (`services/submissions.ts` `toSectionDefs`), not stored on the field.
- **Contract default stack already exists:** `DEFAULT_CONTRACT_LAYOUT` (code,
  `contract/system-fields.ts:38-57`) → global `Setting` `onboarding.contractTemplate`
  → per-cycle `RecruitmentCycleContract.layout` → frozen `OnboardingContract.templateSnapshot`.
  Resolver `contract/resolve.ts`. The current default deliberately mirrors the
  live onboard form field-for-field with empty agreement bodies.
- **Training** = same `FormSection`/`FormField` tables with `purpose = QUIZ`
  (`correctValue` holds the answer key); intake fields (`minShiftsWanted`,
  `additionalShiftAvailability`, `feedback`) are fixed columns on `Training`,
  already collected in `src/app/(app)/training/training-quiz.tsx`.

No schema migration is required — every structure the templates need already exists.

## Architecture

```
createCycle(track, termId, departments, ...)
  └─ materializeTemplate(tx, cycleId, sections)                    ← new
        sections = [
          ...getApplicationTemplate(track, departments, termContext),   // purpose APPLICATION
          ...getQuizTemplate(track),                                     // purpose QUIZ (no correctValue)
        ]
  → FormSection rows (title, order, appliesTo, departmentCode, purpose)
  → FormField rows  (key, label, type, required, helpText, options, order; cycleId set)

Contract:  resolveContractLayout(cycleId)
  → cycle override → global Setting → defaultContractLayout(track)  ← default becomes track-aware
```

### Component 1 — Template module (`src/modules/recruitment/templates/`)

- `types.ts` — plain serializable shapes:
  - `TemplateField { key; label; type: FieldType; required; helpText?; options?: TemplateOption[]; correctValue?; order }`
  - `TemplateSection { title; description?; order; appliesTo: ApplicantScope; departmentCode?; purpose: FormPurpose; fields: TemplateField[] }`
  - `TemplateOption { label; value }` (value is the stored answer; label is shown).
- `field-groups.ts` — reusable builders returning section/field fragments:
  `identityGroup()`, `affiliationGroup(track)`, `eligibilityGateGroup()`,
  `languagesGroup()`, `availabilityGroup(termContext)`,
  `departmentRankingGroup(track)`, `generalEssaysGroup()` (director shared
  supplements), `acknowledgementsGroup(track)`, `additionalInfoGroup()`,
  `deptSupplementSection(code, questions)`.
- `application/volunteer.ts`, `application/director.ts` — compose the groups.
- `application/supplements/` — per-department supplement question sets, keyed by
  reconciled `Department.code` (the bulk of the extracted content; one small file
  or record per department keeps each unit reviewable).
- `quiz.ts` — the ~14 makeup-training knowledge questions as `SINGLE_SELECT`
  fields with options and **no** `correctValue`.
- `index.ts` — `getApplicationTemplate(track, departments, termContext)` and
  `getQuizTemplate(track)`.

Airtable field-type → `FieldType`: text→`SHORT_TEXT`, multilineText→`LONG_TEXT`,
singleSelect→`SINGLE_SELECT`, multipleSelects→`MULTI_SELECT`, checkbox→`CHECKBOX`,
email→`EMAIL`, phone→`PHONE`, date→`DATE`, attachment→`FILE`, dept picker→
`DEPARTMENT_CHOICE`, subcommittee rank→`SUBCOMMITTEE_RANK`.

Each builder is independently unit-testable — you can read what
`eligibilityGateGroup()` produces without reading the whole template.

### Component 2 — Materialization at `createCycle`

- New `templates/materialize.ts`: `materializeTemplate(tx, cycleId, sections)`
  creates `FormSection` rows, then their `FormField` rows with `cycleId` set —
  same two-step shape `createCycle` uses today.
- `createCycle` calls it in place of the hardcoded 3-field seed. Identity keys
  stay `first_name`/`last_name`/`email` so `publishCycle` passes untouched.
- **Supplement sections are materialized only for the cycle's selected
  `departments`.** Departments this cycle doesn't run add nothing.
- **Exactly one `DEPARTMENT_CHOICE` field** is emitted by
  `departmentRankingGroup` (its options are injected live at render, per the
  existing engine) so the `publishCycle` dept-supplement guard is satisfied.
- Section visibility maps Airtable behavior onto existing fields:
  - Personal-details section → `appliesTo: NEW` so renewals skip it (mirrors
    Airtable's "returning record auto-pulled").
  - Department supplement sections → `departmentCode` so the engine reveals them
    by the applicant's choice.
- `termContext` (the term's clinic Saturdays) is read in `createCycle` and passed
  to `availabilityGroup`, which emits a `MULTI_SELECT` of those dates. If the term
  has no clinic calendar yet, availability ships with empty options for the
  director to fill in the builder.

### Component 3 — Contract track-variants

Reuse the existing default→global→per-cycle→snapshot stack; only make the **code
default track-aware**:

- `DEFAULT_CONTRACT_LAYOUT` becomes `defaultContractLayout(track: Track):
  ContractLayout` in `contract/system-fields.ts`, threaded through
  `contract/resolve.ts` (`resolveLayoutSources`/`resolveContractLayout` gain the
  cycle's `track`).
- **Volunteer** default ≈ today's layout with the real agreement/professionalism/
  training bodies filled from Airtable form #3.
- **Director** default = the volunteer blocks plus the director-specific
  data-privacy acknowledgement and term-date questions (Airtable form #4).
- **Deliberate simplification:** the Airtable director contract's ~22
  per-department "Confirm" checkboxes are **not** replicated — HAVEN Hub already
  knows a director's department from their `Acceptance`, so the checkbox was an
  Airtable workaround with no analog here. Flagged for review; easy to add as
  `custom_question` blocks if wanted.
- Global `Setting` and per-cycle overrides continue to sit on top unchanged.

### Component 4 — Training quiz template

- `getQuizTemplate(track)` returns QUIZ-purpose sections/fields; materialized at
  every `createCycle` (decision 4).
- Questions ship with options but **no `correctValue`** (decision 5). The quiz
  builder and grading already tolerate an unset key; directors set answers per
  cycle.
- Training **intake** (min shifts / additional availability / feedback) is
  unchanged — those columns already exist and already cover Airtable form #5.
  Making intake builder-configurable is **out of scope**.

## Department-code reconciliation

Supplement sections key on `departmentCode`, which must match a real
`Department.code` (seed in `prisma/seed.ts:11-43`). Extraction found genuine
mismatches to resolve during content authoring:

- **Normalize spelling/punctuation:** Airtable `FCLR` → repo `FCRL`; `SR&R` → `SRR`.
- **Codes not in the seed:** `JONES`, `LCCN`, `TBAD` (director), `SCTL`, `PNTC`
  (volunteer). For each, either (a) add to the `DEPARTMENT` seed + upsert (they
  are real HAVEN departments), or (b) map to an existing code, or (c) omit the
  supplement. Default recommendation: **add the missing real departments to the
  seed** so codes are consistent app-wide; decided per-department during authoring
  and listed in the plan.
- The reconciliation is a lookup table in `application/supplements/`; any code
  that resolves to no `Department` is a **build/test failure**, never a silent drop.

## Content workstream

Authored during implementation from the live forms (method proven this session):

1. Volunteer application — shared core (already captured) + ~24 dept supplement
   branches.
2. Director application — shared core + ~25 dept supplement branches.
3. Volunteer + director contract bodies (agreements, data-privacy, term dates).
4. Quiz question text + options (no answer key).

Each is a discrete, reviewable content unit. Sequencing lives in the
implementation plan (vertical slice first: mechanism + volunteer shared core).

## Data model impact

- **No Prisma migration.** All structures exist.
- Possible **seed additions**: new `Department` rows for `JONES`/`LCCN`/`TBAD`/
  `SCTL`/`PNTC` if authoring chooses option (a) above. Seed upserts are idempotent.

## Error handling

- Materialization runs inside the `createCycle` transaction; any failure rolls
  back the whole cycle creation (no half-built cycle).
- A template-integrity unit test (below) catches malformed templates at CI time,
  before they can reach `createCycle`.
- Unknown `departmentCode` in a supplement fails a test rather than materializing
  a dangling section.

## Testing

- **Unit — template integrity:** for each track, keys are unique; `first_name`/
  `last_name`/`email` present; exactly one `DEPARTMENT_CHOICE`; every
  `departmentCode` resolves to a seeded `Department`; `SINGLE_SELECT`/
  `MULTI_SELECT` fields have options; quiz fields are `SINGLE_SELECT`.
- **Unit — field groups:** each builder returns the expected fields/labels/types.
- **Integration — createCycle:** materializes the expected section/field counts
  per track; supplements appear only for selected departments; quiz sections
  present with `purpose = QUIZ`.
- **Integration — publish:** `publishCycle` succeeds on an untouched default
  cycle (no manual edits), for both tracks and for a cycle with department supplements.
- **Integration — visibility:** NEW-only personal-details section hidden for a
  renewal; a department's supplement hidden unless chosen.
- **Contract:** `resolveContractLayout` returns the volunteer vs director default
  when no overrides exist; overrides still win.
- Run per the repo's per-worktree `TEST_DATABASE_URL` convention (throwaway local
  pg, never Neon).

## Out of scope (YAGNI)

- Admin UI to edit the org-wide default (decision 1).
- Builder-configurable training intake.
- Enforced hard-stop for ineligible applicants (the eligibility gate ships as
  fields + an acknowledgement checkbox; blocking submission mid-form is a
  possible follow-up, not this spec).
- A "reset this cycle to the current default" action (nice-to-have follow-up).
- Replicating the director contract's per-department confirm checkboxes.

## Open follow-ups (non-blocking)

- Whether to enforce the eligibility gate (block submission) later.
- Whether to add a per-cycle "re-apply default" action.
- Final per-department decision (add-to-seed vs map vs omit) for the five
  unmatched codes — resolved during authoring, recorded in the plan.

## File inventory

**New**
- `src/modules/recruitment/templates/types.ts`
- `src/modules/recruitment/templates/field-groups.ts`
- `src/modules/recruitment/templates/application/volunteer.ts`
- `src/modules/recruitment/templates/application/director.ts`
- `src/modules/recruitment/templates/application/supplements/` (per-department content + code map)
- `src/modules/recruitment/templates/quiz.ts`
- `src/modules/recruitment/templates/materialize.ts`
- `src/modules/recruitment/templates/index.ts`
- Tests under `src/modules/recruitment/templates/__tests__/` (or repo test convention)

**Modified**
- `src/modules/recruitment/services/cycles.ts` — `createCycle` calls `materializeTemplate`; reads `termContext`
- `src/modules/recruitment/contract/system-fields.ts` — `defaultContractLayout(track)`
- `src/modules/recruitment/contract/resolve.ts` — thread `track` into resolution
- `prisma/seed.ts` — add unmatched real departments (only if authoring picks that option)
