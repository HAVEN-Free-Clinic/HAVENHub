# Onboarding contract: mirror the legacy Airtable form

Date: 2026-07-21
Status: approved, ready for planning

## Problem

The onboarding contract (`/onboard/[token]`) was built to reproduce the old
hand-rolled form field-for-field, not the Airtable form HAVEN actually ran on.
Three things are wrong today:

1. **Agreements render as bare signature pads.** `DEFAULT_CONTRACT_LAYOUT` ships
   every agreement body as `""`, so the volunteer agreement, professionalism
   policy and training acknowledgement are signature boxes with a title and no
   terms. People sign nothing.
2. **The Epic block asks questions it should not.** "Epic access is required for
   my role" is a self-report of something the department already determines, and
   "Access type" is shown to everyone including people with no Epic ID.
3. **Whole sections of the Airtable form are missing** — section headings,
   pronouns, staff title, Epic ID expiration, the HIPAA instructions, the data
   privacy statement, the department-specific responsibility confirmations, and
   the training date.

Ops wants the hub form to mirror the Airtable form so nothing is lost in the
migration.

## Approach

Extend the contract block model with the three capabilities the Airtable form
needs — sections, conditional visibility, and formatted prose — then rebuild the
default layouts on top of them. Reuse the existing condition engine rather than
introducing a second one.

## 1. Block model

All additions are optional properties, so every layout already saved in
`RecruitmentCycleContract.layout` and in the `onboarding.contractTemplate`
setting continues to parse untouched.

### New `section` block

```ts
type SectionBlock = {
  kind: "section";
  id: string;      // unique within a layout, like agreement ids
  title: string;
  body: string;    // markdown subset, may be empty
};
```

Renders a heading and optional prose. No input, no value, never appears in
submitted form data. Covers the Airtable form's "Demographic Information",
"Director Contracts", "HIPAA Training", "HIPAA Compliance", "Epic Access",
"Basic Information" and "Volunteer Contract" headings, plus the contract
preamble (the welcome paragraph and the DATA PRIVACY / EMR ACCESS notes).

### `visibleWhen` on every block kind

```ts
visibleWhen?: FieldCondition   // from engine/field-visibility.ts
```

`FieldCondition` and `isFieldVisible` already exist and drive the application
form's conditional questions. The contract adopts them unchanged — no second
condition language, no new operators.

### `confirmKind` on agreements

```ts
confirmKind?: "signature" | "initials" | "checkbox"   // default "signature"
```

The Airtable form confirms agreements three different ways and the contract
currently only does one:

| Airtable pattern | `confirmKind` |
|---|---|
| "By typing your full name below, you fully acknowledge…" | `signature` |
| "Please initial below." | `initials` |
| Department responsibility blocks (bare checkbox) | `checkbox` |

`signature` and `initials` both render `SignaturePad` and persist into
`OnboardingContract.signatures` under `sig__<id>`, as today. `checkbox` renders
a required checkbox and persists a boolean into `OnboardingContract.customAnswers`
under `confirm__<id>`, keeping the signature store to actual signatures.

### Markdown subset for prose

`AgreementBlock.body` and `SectionBlock.body` render through a new shared
renderer supporting **paragraphs, bold, unordered lists (one level of nesting),
and links** — nothing else. Input stays plain text so the builder's textareas
keep working; output is escaped and constructed as React elements, never
`dangerouslySetInnerHTML`. This is what the Airtable prose needs: the strike
policy and department responsibilities are bulleted, the HIPAA instructions are
bulleted with links to `hipaa.yale.edu`, and headings inside prose are bolded.

Replaces the current `whitespace-pre-line` rendering in `contract-field.tsx`.

## 2. Conditional visibility

### Client

`contract-field.tsx` currently holds a single `useState(hasEpic)` local to the
Epic block. That is lifted: `onboard-form.tsx` owns an answers map
(`Record<string, string | string[]>`), fields report changes into it, and the
block list filters through `isFieldVisible` before rendering.

### Server

The same filter runs in `actions.ts` before validation, so a hidden required
field can neither block submission nor persist a stale value. This mirrors how
the apply wizard already handles hidden fields.

### Synthetic answers

Two keys are injected into the answers map server-side, so conditions can key on
facts the applicant never types:

- `department` — `Acceptance.departmentCode`
- `track` — the cycle's `Track`

Both are authoritative and always win over any same-named form answer, following
the precedent set by `mergeDepartmentAnswer`.

## 3. Data model

| Model | Field | Type | Notes |
|---|---|---|---|
| `Person` | `pronouns` | `String?` | promoted from contract |
| `Person` | `staffTitle` | `String?` | Yale employee title / office |
| `OnboardingContract` | `pronouns` | `String?` | |
| `OnboardingContract` | `staffTitle` | `String?` | |
| `OnboardingContract` | `epicIdExpiration` | `DateTime?` | |
| `RecruitmentCycle` | `trainingLocation` | `String?` | e.g. "in person", "Zoom at 10:00 AM" |
| `Department` | `requiresEpicDirector` | `EpicRequirement` | |
| `Department` | `requiresEpicVolunteer` | `EpicRequirement` | |
| `Department` | `epicGuidance` | `String?` | shown when the rule is `SOME` |

```prisma
enum EpicRequirement { ALL NONE SOME }
```

`OnboardingContract.epicNeeded` is **kept**. Historical contracts retain their
recorded answer; the column simply stops being written from a checkbox and
starts being written from the resolution in §4.

New system field keys added to `SYSTEM_FIELD_KEYS`: `pronouns`, `staffTitle`,
`epicIdExpiration`.

`yaleAffiliation` and `gradYear` change from free-text inputs to selects.
Affiliation options: College, GSAS, YLS, YSM – MD or MD/PhD, YSM – PA, YSN,
YSPH, Staff, Other. Graduation year: a rolling window of the next seven years
plus Other and N/A.

`promotion.ts` extends its person upsert to carry `pronouns` and `staffTitle`,
following the same `person.x || contract.x` precedence it already uses for
`spanishSelfReported`.

## 4. Epic requirement resolution

At submit, `epicNeeded` resolves from the acceptance's department and the
cycle's track:

| Rule for that department × track | `epicNeeded` |
|---|---|
| `ALL` | `true`, nobody is asked |
| `NONE` | `false`, nobody is asked |
| `SOME` | the applicant's answer to a question shown only for these departments |

The `SOME` question is an ordinary system field gated by
`visibleWhen: { field: "department", op: "isAnyOf", value: [...] }`, carrying
that department's `epicGuidance` as help text.

This exists because there is no seniority concept anywhere in the schema —
`Track` is `VOLUNTEER | DIRECTOR` and `ShiftRole` is
`DIRECTOR | VOLUNTEER | SHADOW`. Departments where only senior volunteers get
Epic cannot be resolved from data alone. The Airtable form hit the same wall and
handled it in prose: "LCC (Patient Navigator or TOC)", "QA/QI (Only if indicated
by directors)". `SOME` makes that explicit and confines the question to the
departments that genuinely need it.

Seeds come from the Airtable form's own two lists:

- **Requires Epic** — Behavioral Health, Clinical Advisor, Education, Lab,
  LTBI, Medical Debt & Insurance Counseling, Oral Health Initiative, Patient
  Services, Pharmacy, Referrals, Reproductive Health, Social Services, Vaccine
- **Does not require Epic** — Faculty Relations, Finance and Development,
  Interpretation & Diversity, IT & Communications, Public Relations, Student
  Recruitment, Community Relations and Advocacy, MLP, Food Pharmacy
- **`SOME`** — LCC (Patient Navigator or TOC only) and QA/QI (only if indicated
  by directors)

`promotion.ts:145` is untouched and keeps creating the `EpicRequest`.

### Epic block rework

- "Epic access is required for my role" checkbox: **removed** (resolved above).
- "Access type": shown only when "I already have an Epic ID" is checked, and
  changed from free text to a select — *New account* / *Reactivation, renewal,
  extension or modification* — matching the Airtable request types.
- Epic ID expiration date: **added**, also gated on having an Epic ID, with the
  Airtable help text ("Your Epic ID expires one year from the date it was
  created, renewed, or last modified").
- "I currently work with Yale New Haven Hospital": kept.

## 5. Default content

`DEFAULT_CONTRACT_LAYOUT` moves out of `system-fields.ts`. With 21 department
blocks and the full policy prose it would swamp a file whose job is describing
system fields.

```
src/modules/recruitment/contract/defaults/
  index.ts        defaultContractLayout(track) — assembly only
  volunteer.ts    volunteer layout + volunteer-specific prose
  director.ts     director layout + board responsibilities, strike policy
  departments.ts  the 21 department responsibility blocks
  shared.ts       HIPAA instructions, Epic preamble, data privacy statement
```

`system-fields.ts` keeps `SYSTEM_FIELD_KEYS` and `SYSTEM_FIELDS` and re-exports
`defaultContractLayout` so existing importers do not break.

### Department responsibility blocks

One agreement block per department, `confirmKind: "checkbox"`, gated on
`visibleWhen: { field: "department", op: "is", value: "<CODE>" }`, body carrying
that department's responsibilities and approximate hours per week. Departments
covered: BVHD, CRAD, EDUC, EXEC, FCRL, FIND, ITCM, INTP, LABR, LCCN, MDIC, PATS,
PBRL, PCAR, PHAM, QAQI, REFF, SOSE, SRR, SRHD, VADM.

Content is transcribed from the Airtable form. Because it is gated on
department, a person sees exactly one of these.

### Director-only content

The director layout additionally carries the board responsibilities list, the
strike policy, the active engagement and attendance statement, and the full
HAVEN Free Clinic Data Privacy Statement, as agreement blocks in the Airtable
form's order.

### Training acknowledgement

The training agreement body interpolates the cycle's **existing**
`inPersonTrainingDate` plus a new `trainingLocation`, rather than hardcoding a
date, so "Sunday, May 3rd" and "Zoom training on Sunday 5/24 at 10:00 AM" both
come from configuration. When `inPersonTrainingDate` is unset the block falls
back to prose with no date. `{{trainingDate}}` and `{{trainingLocation}}` join
the existing `{{firstName}}` / `{{orgName}}` substitutions in `renderVars`.
Dates render in the configured display zone via `src/platform/dates`.

**Dependency:** `RecruitmentCycle.inPersonTrainingDate` is added by the
unmerged `worktree-in-person-training-date` branch (#352), where it already
gates the makeup quiz and is editable in the cycle TRAINING form. This work
reuses that column rather than adding a second one, so it must land after #352
merges. Only `trainingLocation` is new here, and it belongs beside
`inPersonTrainingDate` in that same TRAINING form.

## 6. Builder UI

- **`SectionCard`** — title + body, matching `AgreementCard`'s shape.
- **Condition editor** — a shared control available on every card: field picker,
  operator, value. Offers `department` and `track` alongside the layout's own
  answerable keys.
- **`confirmKind` picker** on `AgreementCard`.
- `TypePicker` gains "Section" as an addable block.

`SortableList`, save/reset, the two-tier assertion and the global-vs-cycle mode
split are all unchanged.

## 7. Compatibility

- Every new block property is optional; `parseContractLayout` accepts existing
  layouts unchanged.
- Cycles with a saved override keep it. Only the code default changes, so
  existing cycles do not silently gain the new content — this is deliberate.
  Directors adopt it by resetting a cycle to the default.
- `epicNeeded`, `spanishSelfReported` and every other existing column are
  retained; no data is dropped.
- Removing the Spanish checkbox is safe: `promotion.ts:86` reads
  `person.spanishSelfReported || contract.spanishSelfReported`, and the
  application form already captures languages, so the signal survives.

## 8. Testing

| Area | Test |
|---|---|
| `layout.ts` | round-trip parse of `section`, `visibleWhen`, `confirmKind`; existing layouts still parse; duplicate section ids rejected |
| Visibility | `isFieldVisible` over contract blocks; `department` / `track` injection wins over form answers |
| Markdown | bold, bullets, links, paragraphs render; HTML in source is escaped; no `dangerouslySetInnerHTML` |
| Defaults | per-track snapshot of the assembled layout; every department code has exactly one block; every block's `visibleWhen` references a real key |
| Epic | `ALL` / `NONE` / `SOME` resolution per department × track; `SOME` persists the applicant's answer; `promotion.ts` still creates the request |
| Submit | hidden required fields neither block submission nor persist; `checkbox` agreements persist |
| Promotion | `pronouns` / `staffTitle` carry to `Person` with existing-value precedence |

## Out of scope

- Modelling volunteer seniority (senior vs junior). Called out in §4 as the
  reason `SOME` exists; a real role/level on the acceptance is its own feature
  touching recruitment, scheduling and rosters, and needs its own spec.
- Backfilling existing cycle overrides with the new default content.
- A WYSIWYG editor for agreement prose.
