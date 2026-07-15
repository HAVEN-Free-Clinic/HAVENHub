# Recruitment conditional questions + onboarding prefill — design

- **Date:** 2026-07-14
- **Status:** Draft (awaiting review)
- **Branch:** feat/recruitment-conditional-questions (stacked on feat/recruitment-default-form-templates / PR #293)
- **Author:** Jack C (with Claude)

## Problem

Two related asks on the recruitment forms:

1. Applicants answer questions that don't apply to them. HAVEN's Airtable forms hid
   questions conditionally (e.g. "which other languages?" only appeared after
   answering "Yes" to "do you speak other languages?"). HAVEN Hub today has **no
   per-question conditional visibility** — only section-level gates (new/renewal +
   department). We want a general "show this question only when …" capability on
   **every** question.
2. Several fields are collected on the application **and then again** at onboarding.
   Onboarding should reuse what the applicant already gave.

## Goals

- **`visibleWhen`**: any FormField can declare a single show-condition referencing
  another field's answer; the apply wizard shows/hides it live and validation
  respects it. Scoped to the **application + training-quiz** forms (FormField-based).
- **Onboarding prefill**: carry the genuinely-duplicated fields (Yale affiliation,
  graduation year, Spanish) from the application into the onboarding contract so
  they arrive pre-filled and editable rather than re-asked.

## Decisions (locked with the user)

1. **Single rule per question** (not multi-condition AND/OR). Operators:
   `is` | `isNot` | `isAnyOf` | `isAnswered`.
2. **Prefill** the duplicated onboarding fields from the application (keep the
   fields, auto-fill them) — not drop them.
3. **Scope**: application + quiz forms only. The onboarding contract is a separate
   block/layout system with its own bespoke conditionals (the EPIC block) and is
   NOT getting data-driven conditions in this feature — the only onboarding change
   is the prefill in decision 2.

## Current state (grounding, from the engine map)

- **No field-level conditions exist** anywhere (`grep visibleWhen|showWhen|dependsOn`
  is empty). Section visibility (`engine/visibility.ts` `isSectionVisible`) keys only
  on `appliesTo` + `departmentCode`; `VisibilityContext` carries no answers.
- **The apply wizard is uncontrolled** (fields use `defaultValue`/`defaultChecked`);
  values are read on demand via `new FormData(formRef.current)` in `collectValues()`.
  BUT three inputs are already reactive React state — `applicantType`, `deptChoice`
  (wired via `onDeptChoice` on the `DEPARTMENT_CHOICE` field), `renewalDept` — and
  they drive live section show/hide through `deriveSteps` (`apply-wizard.tsx`
  `useMemo`). **This is the exact pattern to generalize.**
- All visible section steps stay mounted (only the current one is un-`hidden`), so a
  condition-hidden field must be **removed from the DOM**, not just hidden, or its
  stale value leaks into `FormData`.
- **Validation is section-level only**: `schema-builder.ts buildApplicationSchema`
  / `requiredFileKeys` iterate `visibleSections(...)`; a required field in a *visible*
  section is always required. There is no field-level skip today — this is the
  correctness-critical gap to close.
- **Answers are keyed by `FormField.key`**, a flat `Record<string,string|string[]>`
  (multi-value → array), stored on `Application.answers`. `DEPARTMENT_CHOICE` and
  `SUBCOMMITTEE_RANK` answers are hoisted into columns.
- **Onboarding prefill today** (`services/onboarding.ts createOrResendContract`)
  seeds only `firstName,lastName,email,netId,phone` from the `Applicant` record;
  everything else (dob, dietary, yaleAffiliation, gradYear, initials, epic, spanish,
  licensedRN, hipaa) is re-asked with no default. There is no application-answers →
  contract-column path beyond those four.

## Design

### Component 1 — Data model

Add `visibleWhen Json?` to `FormField` (nullable). A field with `visibleWhen: null`
is always visible (today's behavior, no backfill needed). Migration is additive and
non-structural.

```ts
// engine/field-visibility.ts
export type FieldCondition = {
  field: string;                                   // controlling field key
  op: "is" | "isNot" | "isAnyOf" | "isAnswered";
  value?: string | string[];                        // required except for isAnswered
};
export function parseFieldCondition(v: unknown): FieldCondition | null; // safe parse, null on invalid
```

Persisted/validated via a small zod (or hand) parser so a malformed `visibleWhen`
degrades to "always visible" rather than throwing.

### Component 2 — Engine `isFieldVisible`

```ts
// engine/field-visibility.ts
export function isFieldVisible(
  visibleWhen: unknown,
  answers: Record<string, string | string[] | undefined>,
): boolean;
```

- No/invalid condition → `true`.
- Read `answer = answers[cond.field]`. Normalize to compare (a multi-select answer is
  a `string[]`).
- `is`: single answer equals `value`; array answer includes `value`.
- `isNot`: negation of `is`.
- `isAnyOf`: `value` is `string[]`; single answer ∈ value, or array answer intersects value.
- `isAnswered`: answer is present and non-empty (ignores `value`).

Plus `visibleFields<T extends {visibleWhen?: unknown}>(fields, answers): T[]` helper.

### Component 3 — Apply wizard reactivity

- **`FieldPreview`** gains a generic `onValueChange?(key, value)` prop, wired to each
  control's `onChange` (generalizing the existing `DEPARTMENT_CHOICE`-only `onDeptChoice`).
- **`apply-wizard.tsx`** holds an `answers` state map. To keep the form uncontrolled
  and fast, it computes the set of **controlling keys** once (every `visibleWhen.field`
  across the def) and updates `answers` state **only when a controlling field changes**.
  Non-controlling fields stay uncontrolled (no per-keystroke re-render).
- The controlling values already tracked as dedicated state (`deptChoice`, etc.) are
  folded into (or mirrored by) this `answers` map for a single source of truth.
- **Field rendering** filters a section's fields through `isFieldVisible(field.visibleWhen,
  answers)` and renders only visible ones; a hidden field is not rendered (unmounted),
  so it leaves `FormData`. When the controlling answer changes, the dependent field
  mounts/unmounts on the next render.
- Draft autosave is unaffected (hidden fields simply aren't in the serialized form).

### Component 4 — Validation (correctness-critical)

- Thread the current answers into field iteration:
  - `schema-builder.ts buildApplicationSchema(sections, ctx)` and `requiredFileKeys` —
    within each visible section, **skip a field whose `visibleWhen` is unmet** (given
    `ctx.answers`), so it's neither required nor present in the schema.
  - `submissions.ts submitApplication` — pass `answers` into `ctx` (extend
    `VisibilityContext` / the section-def ctx) so the derived schema and file allow-list
    exclude condition-hidden fields.
  - Client `wizard-validation.ts missingRequiredKeys(fields, values)` — skip
    condition-hidden fields so "Continue" isn't blocked by a hidden required field.
- The server evaluates conditions against the SUBMITTED answers (single source of
  truth), so a client that failed to unmount a field can't force a hidden field's
  value to count, and a hidden required field can't block a legitimate submit.
- On submit, `submitApplication` **strips answers for condition-hidden fields** from
  the stored `answers` blob before persisting, so no stale hidden value survives even
  if a client submitted one. Conditions are evaluated against the answers as given;
  hidden fields' keys are then removed.

### Component 5 — Builder control

- **`field-card.tsx`** adds a "Show only when …" block: a select of the cycle's other
  fields (the controlling field), an operator select (`is`/`is not`/`is answered`/`is
  any of`), and a value control that adapts to the controlling field's type — a
  dropdown of that field's `options` for selects/checkbox, a text input otherwise, and
  no value for `is answered`. A "(always show)" default clears the condition.
- Persist through `updateField`/`addField` (`form-builder.ts`) and the builder actions
  (`updateFieldAction`, `addFieldAction`, `duplicateFieldAction` copies the condition),
  carrying `visibleWhen` alongside `options`/`validation`.
- **Structural gating**: adding/removing/changing a condition changes what is
  effectively required, so treat it as a structural edit — DRAFT-only, via the existing
  `assertCycleEditable(cycleId, structural=true)` path used for type/required changes.
- Builder only offers **already-defined** fields as controllers (any field in the
  cycle); a soft warning if a condition references a field ordered *after* this one
  (forward reference works at eval time but is confusing) — non-blocking.

### Component 6 — Default templates use it

Wire `visibleWhen` into the shipped default templates so they behave like the Airtable
originals (and show fewer questions):
- Volunteer: `other_languages_detail` visible when `other_languages is "yes"`;
  `medical_certifications` + `medical_details` visible when `licensed_professional is
  "yes"`; `yale_affiliation_other` visible when `yale_affiliation isAnyOf [other_yale,
  staff]`.
- Director: analogous (other-languages detail, affiliation-other).
- Field-group builders gain an optional `visibleWhen` on the relevant `TemplateField`s;
  `materializeTemplate` writes it through.

### Component 7 — Onboarding prefill (de-dup)

- **`services/onboarding.ts createOrResendContract`**: widen the contract `create`
  data by mapping from `acceptance.application.answers`:
  - `answers.yale_affiliation → yaleAffiliation`
  - `answers.grad_year → gradYear`
  - `spanishSelfReported = (answers.spanish_proficiency ?? "none") !== "none"`
- **`onboard/[token]/page.tsx`** `prefill` object + `contract-field.tsx` defaults: add
  `yaleAffiliation`, `gradYear`, and the derived `spanish` checkbox so they render
  pre-filled and editable.
- Mapping keys reference the default template's field keys; if a cycle's application
  uses different keys (custom form), those prefills simply no-op (fall back to blank) —
  no error.

## Error handling / edge cases

- Malformed `visibleWhen` → treated as always-visible (safe parser), never throws.
- Controlling field hidden/unanswered for this applicant → its answer is absent →
  `isAnswered` false, `is` false — dependent field stays hidden (acceptable).
- Server is authoritative: validation re-evaluates conditions against submitted
  answers, so client/DOM bugs can't smuggle a hidden field's value or block submit.
- Condition edits are DRAFT-only, so a live (OPEN) form's required-set can't shift
  under applicants.

## Testing

- **Engine** — `isFieldVisible` per operator, incl. multi-select array answers,
  missing controlling answer, malformed condition.
- **Schema-builder** — a hidden required field is excluded from the schema and from
  `requiredFileKeys`; a visible one is still required; toggling the controlling answer
  flips it.
- **Submission** — `submitApplication` succeeds when a hidden required field is
  unanswered; fails when a *visible* required field is unanswered; a stale hidden-field
  value doesn't get stored as a required answer.
- **Wizard** — dependent field mounts/unmounts as the controlling answer changes and
  is absent from `collectValues()` when hidden; `missingRequiredKeys` skips hidden.
- **Builder** — setting/clearing a condition persists `visibleWhen`; condition edits
  are blocked on a non-DRAFT cycle.
- **Prefill** — a contract created from an application whose answers include
  affiliation/grad-year/Spanish arrives with those columns populated; missing keys
  no-op.
- Run under the repo's per-worktree throwaway test DB (never the shared drifted one).

## Out of scope (YAGNI)

- Multi-condition AND/OR and richer operators (contains, numeric comparisons).
- Data-driven conditions on the onboarding **contract** questions (separate system).
- Conditional whole **sections** driven by field answers (sections keep appliesTo +
  department only).
- Migrating the existing bespoke EPIC-block conditional to the new mechanism.

## Data model impact

- **One Prisma migration**: `FormField.visibleWhen Json?` (additive, nullable). No
  backfill.

## File inventory

**New**
- `src/modules/recruitment/engine/field-visibility.ts` (+ test)

**Modified**
- `prisma/schema.prisma` — `FormField.visibleWhen Json?` (+ migration)
- `src/modules/recruitment/engine/schema-builder.ts` — skip condition-hidden fields
- `src/modules/recruitment/services/submissions.ts` — thread answers into ctx
- `src/app/apply/[slug]/apply-wizard.tsx` — generic `onValueChange`, answers state, unmount hidden
- `src/modules/recruitment/components/field-preview.tsx` — `onValueChange` prop
- `src/app/apply/[slug]/wizard-validation.ts` — skip hidden in `missingRequiredKeys`
- `src/app/apply/[slug]/wizard-steps.ts` — (if field-level filtering lands here)
- `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx` — "Show only when" control
- `src/app/(app)/recruitment/cycles/[id]/builder/actions.ts` + `src/modules/recruitment/services/form-builder.ts` — carry `visibleWhen`
- `src/modules/recruitment/templates/types.ts` + `field-groups.ts` + `materialize.ts` — optional `visibleWhen` on template fields, materialized through
- `src/modules/recruitment/services/onboarding.ts` + `src/app/onboard/[token]/page.tsx` + `contract-field.tsx` — application → contract prefill
