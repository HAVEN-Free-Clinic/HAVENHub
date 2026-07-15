# Recruitment Forms: Conditional Questions, Open-Cycle Editability, Onboarding Prefill, E2E Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-question conditional visibility (`visibleWhen`) to the recruitment application + quiz forms, allow form edits on open cycles (with warnings), prefill duplicated fields into onboarding, wire the conditions into the default templates, and fix the e2e suite broken by the default-template change.

**Architecture:** A nullable `FormField.visibleWhen` JSON condition, evaluated by a pure `isFieldVisible(condition, answers)` engine. The apply wizard becomes reactive only for the questions that control others (keeps it fast) and unmounts hidden questions. Validation (client + server) skips condition-hidden fields and the server strips their stale answers on submit. A builder control sets conditions on any question. `assertCycleEditable` is relaxed to block only ARCHIVED. Default templates gain conditions; onboarding prefills affiliation/grad-year/Spanish from the application. E2E specs get a shared apply helper.

**Tech Stack:** TypeScript, Next.js App Router, Prisma (PostgreSQL), Vitest, Playwright.

## Global Constraints

- **Condition shape** (`FieldCondition`): `{ field: string; op: "is" | "isNot" | "isAnyOf" | "isAnswered"; value?: string | string[] }`. `value` required except for `isAnswered`. A `null`/absent/invalid `visibleWhen` means always-visible.
- **Answers** are a flat `Record<string, string | string[]>` keyed by `FormField.key`; a multi-select answer is a `string[]`.
- **Hidden-field invariants:** a condition-hidden field is (a) excluded from the built Zod schema and required-file check, (b) skipped by the client `missingRequiredKeys`, (c) unmounted (removed from the DOM) in the wizard, (d) its key stripped from stored `answers` on submit.
- **Editability:** `assertCycleEditable(cycleId, structural)` throws only when `status === "ARCHIVED"` (was: `!== "DRAFT"`). Builders warn when `status !== "DRAFT"`. Past `Application.answers` are never rewritten.
- **Scope:** conditional visibility applies to `FormField`-based forms (application + quiz), NOT the onboarding contract's block system. The only onboarding change is prefill.
- **One PR:** all on `feat/recruitment-default-form-templates` (PR #293).
- **No em-dashes** in user-facing copy. Run unit/integration tests against a fresh isolated Postgres test DB (create one; never the shared drifted `havenhub_test`). Note: the shared DB has a pre-existing P3009 failed migration — make your own DB and `prisma migrate deploy` against it.
- Every task's requirements implicitly include this section.

---

### Task 1: `FormField.visibleWhen` + FieldCondition type & parser

**Files:**
- Modify: `prisma/schema.prisma` (`FormField`) + new migration
- Create: `src/modules/recruitment/engine/field-visibility.ts`
- Test: `src/modules/recruitment/engine/field-visibility.test.ts`

**Interfaces produced:**
- `type FieldCondition = { field: string; op: "is"|"isNot"|"isAnyOf"|"isAnswered"; value?: string | string[] }`
- `parseFieldCondition(v: unknown): FieldCondition | null` (safe; returns null on anything invalid)

- [ ] **Step 1: Add the column.** In `prisma/schema.prisma`, add to `FormField` (next to `options`/`validation`):

```prisma
  visibleWhen Json?
```

- [ ] **Step 2: Create the migration and regenerate the client.**

Create a fresh isolated test/dev DB and run:
```bash
DB="postgresql://haven:haven_dev@localhost:5434/havenhub_cond"
# create the DB via your available psql/superuser path, then:
DATABASE_URL="$DB" DATABASE_URL_UNPOOLED="$DB" npx prisma migrate dev --name form_field_visible_when --create-only
```
Trim the generated migration to ONLY `ALTER TABLE "FormField" ADD COLUMN "visibleWhen" JSONB;` (see the repo memory on `prisma migrate dev` folding in pre-existing drift). Then `DATABASE_URL="$DB" ... npx prisma migrate deploy` and `npx prisma generate`.

- [ ] **Step 3: Write the failing test**

```ts
// field-visibility.test.ts
import { describe, it, expect } from "vitest";
import { parseFieldCondition } from "./field-visibility";

describe("parseFieldCondition", () => {
  it("parses a valid is-condition", () => {
    expect(parseFieldCondition({ field: "other_languages", op: "is", value: "yes" }))
      .toEqual({ field: "other_languages", op: "is", value: "yes" });
  });
  it("parses isAnswered without a value", () => {
    expect(parseFieldCondition({ field: "x", op: "isAnswered" }))
      .toEqual({ field: "x", op: "isAnswered" });
  });
  it("parses isAnyOf with an array value", () => {
    expect(parseFieldCondition({ field: "a", op: "isAnyOf", value: ["other_yale", "staff"] }))
      .toEqual({ field: "a", op: "isAnyOf", value: ["other_yale", "staff"] });
  });
  it("returns null for null / malformed / unknown op / missing value", () => {
    expect(parseFieldCondition(null)).toBeNull();
    expect(parseFieldCondition({})).toBeNull();
    expect(parseFieldCondition({ field: "a", op: "bogus", value: "x" })).toBeNull();
    expect(parseFieldCondition({ field: "a", op: "is" })).toBeNull(); // is needs a value
  });
});
```

- [ ] **Step 4: Run, verify fail** — `npx vitest run src/modules/recruitment/engine/field-visibility.test.ts` (module missing).

- [ ] **Step 5: Implement the type + parser** (append `isFieldVisible` in Task 2)

```ts
// src/modules/recruitment/engine/field-visibility.ts
export type FieldConditionOp = "is" | "isNot" | "isAnyOf" | "isAnswered";
export type FieldCondition = { field: string; op: FieldConditionOp; value?: string | string[] };

export function parseFieldCondition(v: unknown): FieldCondition | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const field = o.field;
  const op = o.op;
  if (typeof field !== "string" || !field) return null;
  if (op === "isAnswered") return { field, op };
  if (op === "is" || op === "isNot") {
    return typeof o.value === "string" ? { field, op, value: o.value } : null;
  }
  if (op === "isAnyOf") {
    return Array.isArray(o.value) && o.value.every((x) => typeof x === "string")
      ? { field, op, value: o.value as string[] }
      : null;
  }
  return null;
}
```

- [ ] **Step 6: Run, verify pass. Commit.**

```bash
git add prisma/schema.prisma prisma/migrations src/modules/recruitment/engine/field-visibility.ts src/modules/recruitment/engine/field-visibility.test.ts
git commit -m "feat(recruitment): FormField.visibleWhen column + FieldCondition parser"
```

---

### Task 2: `isFieldVisible` evaluator

**Files:**
- Modify: `src/modules/recruitment/engine/field-visibility.ts`
- Modify: `src/modules/recruitment/engine/field-visibility.test.ts`

**Interfaces produced:**
- `isFieldVisible(visibleWhen: unknown, answers: Record<string, string | string[] | undefined>): boolean`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { isFieldVisible } from "./field-visibility";

describe("isFieldVisible", () => {
  const cond = (op: string, value?: unknown) => ({ field: "q", op, value });
  it("no condition -> visible", () => {
    expect(isFieldVisible(null, {})).toBe(true);
    expect(isFieldVisible(undefined, { q: "x" })).toBe(true);
  });
  it("is: matches single and array answers", () => {
    expect(isFieldVisible(cond("is", "yes"), { q: "yes" })).toBe(true);
    expect(isFieldVisible(cond("is", "yes"), { q: "no" })).toBe(false);
    expect(isFieldVisible(cond("is", "a"), { q: ["a", "b"] })).toBe(true);
    expect(isFieldVisible(cond("is", "z"), { q: ["a", "b"] })).toBe(false);
    expect(isFieldVisible(cond("is", "yes"), {})).toBe(false); // unanswered
  });
  it("isNot: negation", () => {
    expect(isFieldVisible(cond("isNot", "no"), { q: "yes" })).toBe(true);
    expect(isFieldVisible(cond("isNot", "no"), { q: "no" })).toBe(false);
  });
  it("isAnyOf: membership / intersection", () => {
    expect(isFieldVisible(cond("isAnyOf", ["a", "b"]), { q: "b" })).toBe(true);
    expect(isFieldVisible(cond("isAnyOf", ["a", "b"]), { q: "c" })).toBe(false);
    expect(isFieldVisible(cond("isAnyOf", ["a", "b"]), { q: ["c", "a"] })).toBe(true);
  });
  it("isAnswered: any non-empty answer", () => {
    expect(isFieldVisible(cond("isAnswered"), { q: "x" })).toBe(true);
    expect(isFieldVisible(cond("isAnswered"), { q: [] })).toBe(false);
    expect(isFieldVisible(cond("isAnswered"), { q: "" })).toBe(false);
    expect(isFieldVisible(cond("isAnswered"), {})).toBe(false);
  });
  it("malformed condition -> visible (fail open)", () => {
    expect(isFieldVisible({ nonsense: true }, {})).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** (append to `field-visibility.ts`)

```ts
function asArray(a: string | string[] | undefined): string[] {
  if (a === undefined) return [];
  return Array.isArray(a) ? a : a === "" ? [] : [a];
}

export function isFieldVisible(
  visibleWhen: unknown,
  answers: Record<string, string | string[] | undefined>,
): boolean {
  const cond = parseFieldCondition(visibleWhen);
  if (!cond) return true; // no/invalid condition -> always visible
  const ans = asArray(answers[cond.field]);
  switch (cond.op) {
    case "isAnswered": return ans.length > 0;
    case "is": return ans.includes(cond.value as string);
    case "isNot": return !ans.includes(cond.value as string);
    case "isAnyOf": return (cond.value as string[]).some((v) => ans.includes(v));
    default: return true;
  }
}

/** Filter a field list to the visible ones given the current answers. */
export function visibleFields<T extends { visibleWhen?: unknown }>(
  fields: T[],
  answers: Record<string, string | string[] | undefined>,
): T[] {
  return fields.filter((f) => isFieldVisible(f.visibleWhen, answers));
}
```

- [ ] **Step 4: Run, verify pass. Commit.**

```bash
git add src/modules/recruitment/engine/field-visibility.ts src/modules/recruitment/engine/field-visibility.test.ts
git commit -m "feat(recruitment): isFieldVisible evaluator for per-question conditions"
```

---

### Task 3: Validation skips hidden fields (server + client) + strip on submit

**Files:**
- Modify: `src/modules/recruitment/engine/schema-builder.ts`
- Modify: `src/modules/recruitment/services/submissions.ts`
- Modify: `src/app/apply/[slug]/wizard-validation.ts`
- Test: `src/modules/recruitment/engine/schema-builder.test.ts` (add), `src/modules/recruitment/services/submissions.test.ts` (add)

**Interfaces:** `buildApplicationSchema` / `requiredFileKeys` gain access to the current answers so they skip fields whose `visibleWhen` is unmet. `FieldDef` gains `visibleWhen?: unknown`.

- [ ] **Step 1: Write failing tests** (schema-builder): a required SHORT_TEXT with `visibleWhen {field:"g", op:"is", value:"yes"}` is EXCLUDED from the schema when `answers.g="no"` (so parsing `{}` succeeds), and INCLUDED (required) when `answers.g="yes"`. Follow the existing `schema-builder.test.ts` style. Also a submissions test: `submitApplication` succeeds when a hidden required field is unanswered, and the stored `Application.answers` does not contain the hidden field's key even if it was submitted.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement.**
- Read the current `schema-builder.ts`. Add `visibleWhen?: unknown` to `FieldDef`. Extend the ctx passed to `buildApplicationSchema`/`requiredFileKeys` to include `answers: Record<string,string|string[]|undefined>`. In the per-field loop (within `visibleSections(...)`), `import { isFieldVisible } from "./field-visibility"` and `if (!isFieldVisible(field.visibleWhen, ctx.answers)) continue;` before adding the field to the schema / required-file set.
- In `submissions.ts::submitApplication`, when building `ctx` (currently `{ applicantType, selectedDepartmentCodes }`), add `answers: input.answers`. Ensure `toSectionDefs` carries each field's `visibleWhen` into its `FieldDef`. AFTER successful validation and before persisting, strip hidden fields: compute the visible field keys across visible sections and delete any `answers` key whose field is condition-hidden (`isFieldVisible` false), so `Application.answers` holds only visible answers (the two hoisted keys are already removed).
- In `wizard-validation.ts::missingRequiredKeys(fields, values)`, skip a field when `!isFieldVisible(field.visibleWhen, values)` so a hidden required field does not block "Continue".

- [ ] **Step 4: Run, verify pass** (schema-builder + submissions tests, on a fresh DB). **Commit.**

```bash
git commit -am "feat(recruitment): validation skips condition-hidden fields; strip hidden answers on submit"
```

---

### Task 4: Apply-wizard reactivity + unmount hidden fields

**Files:**
- Modify: `src/modules/recruitment/components/field-preview.tsx`
- Modify: `src/app/apply/[slug]/apply-wizard.tsx`
- Modify: `src/app/apply/[slug]/page.tsx` (pass `visibleWhen` through the serialized `def`)

**Interfaces:** `FieldPreview` gains `onValueChange?: (key: string, value: string | string[]) => void`. The serialized section/field `def` includes `visibleWhen`.

- [ ] **Step 1:** Read `field-preview.tsx`, `apply-wizard.tsx`, `page.tsx`. Confirm the existing `onDeptChoice` wiring (the template to generalize).

- [ ] **Step 2: `page.tsx`** — include `visibleWhen: f.visibleWhen` in the per-field `def` object it serializes (alongside key/label/type/required/options), so the client can evaluate conditions.

- [ ] **Step 3: `field-preview.tsx`** — add an `onValueChange?` prop; call it from each control's `onChange` with `(f.key, value)` (mirror the existing `DEPARTMENT_CHOICE` `onChange` at the `onDeptChoice` site; for multi-selects/checkbox pass the collected array/checked state). Keep controls uncontrolled (`defaultValue`), this only ADDS an onChange notification.

- [ ] **Step 4: `apply-wizard.tsx`**
  - Compute `controllingKeys = useMemo(() => new Set(def.sections.flatMap(s => s.fields).map(f => parseFieldCondition(f.visibleWhen)?.field).filter(Boolean)))`.
  - Hold `const [answers, setAnswers] = useState<Record<string,string|string[]>>({})`. Pass `onValueChange={(k,v) => { if (controllingKeys.has(k)) setAnswers(a => ({ ...a, [k]: v })); }}` to each `FieldPreview`. (Fold the existing `deptChoice`/`renewalDept` state into this map, or mirror them, so there is one source of truth for visibility.)
  - When rendering a section's fields, filter with `visibleFields(section.fields, answers)` (import from the engine) so a hidden field is NOT rendered (unmounted → leaves the DOM/`FormData`).
  - Keep the existing section-step derivation; a section that ends up with zero visible fields still renders its (possibly empty) step — acceptable, or optionally skip empty steps (leave as-is for now).

- [ ] **Step 5: Verify.** No new DB test; add/extend a component or a light behavioral test if the repo has React Testing Library for the wizard (check `field-prefill.test.ts` for the pattern). At minimum: `npx tsc --noEmit`, `npm run lint`, and manual reasoning that a hidden field is absent from `collectValues()`. **Commit.**

```bash
git commit -am "feat(recruitment): apply wizard shows/hides questions live by condition"
```

---

### Task 5: Builder "Show only when" control

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/actions.ts`
- Modify: `src/modules/recruitment/services/form-builder.ts`
- Test: `src/modules/recruitment/services/form-builder.test.ts` (add)

- [ ] **Step 1:** Read the three files. Note `updateField`/`addField` patch shapes and `updateFieldAction`.

- [ ] **Step 2: Persistence** — extend `form-builder.ts` `updateField` and `addField` patch types with `visibleWhen?: unknown | null` and write it (`visibleWhen: patch.visibleWhen === undefined ? undefined : (patch.visibleWhen as never)`). Extend `updateFieldAction`/`addFieldAction`/`duplicateFieldAction` in `actions.ts` to pass it through (duplicate copies the source's `visibleWhen`). Mark a `visibleWhen` change `structural` in `updateField` (it affects required-ness).

- [ ] **Step 3: Test** — `updateField` persists `visibleWhen`; setting it to `null` clears it; a `visibleWhen` change is blocked on ARCHIVED (per Task 6's relaxed guard) but allowed on OPEN. Run on a fresh DB.

- [ ] **Step 4: UI** — in `field-card.tsx`, add a "Show only when" block inside the expanded editor (alongside the Choices/rankCount editors): a select of the cycle's OTHER fields (pass the sibling field list in as a prop, or read from the builder context), an operator select (`is` / `is not` / `is answered` / `is any of`), and a value control — a dropdown of the chosen field's `options` when it is a select/checkbox, a text input otherwise, none for `is answered`. A leading "(always show)" option clears `visibleWhen`. On change, `save({ visibleWhen: cond | null })`.

- [ ] **Step 5: Verify** (`tsc`, lint, the new service test). **Commit.**

```bash
git commit -am "feat(recruitment): builder control to set a question's show-condition"
```

---

### Task 6: Open-cycle editability + warnings + harden review

**Files:**
- Modify: `src/modules/recruitment/services/form-builder.ts` (`assertCycleEditable`)
- Modify: `src/modules/recruitment/contract/template.ts` (contract-layout editability)
- Modify: builder pages: `builder/page.tsx`, `builder/quiz/*`, `builder/contract/*` (warning banner)
- Modify: the recruitment answer/review render path (harden orphaned keys)
- Test: `src/modules/recruitment/services/form-builder.test.ts` (add)

- [ ] **Step 1: Relax the guard.** In `assertCycleEditable(cycleId, structural)`, change the block condition from `structural && cycle.status !== "DRAFT"` to `structural && cycle.status === "ARCHIVED"` (with an updated error message: "This cycle is archived and can no longer be edited."). Apply the equivalent relaxation wherever the contract-layout save enforces DRAFT (`contract/template.ts` `saveCycleContractLayout` / the quiz builder path if it has its own guard).

- [ ] **Step 2: Test** — a structural edit (`addField` required, `updateField` type change, set `visibleWhen`) SUCCEEDS on an OPEN cycle; still THROWS on ARCHIVED. Extend `form-builder.test.ts`. Run on a fresh DB. (Update any existing test that asserted a structural edit is blocked on OPEN — that behavior is intentionally changing.)

- [ ] **Step 3: Warning banner.** In each builder page, when `cycle.status !== "DRAFT"`, render an `Alert` (existing `@/platform/ui/alert`): "This cycle is {status}. Applicants may have already submitted. Changes take effect for new submissions immediately; existing answers are kept as-is and may no longer match the updated form." Use house tone (no em-dashes).

- [ ] **Step 4: Harden review render.** Find where a submitted application's answers are rendered against the form definition (e.g. `cycles/[id]/applicants/[applicationId]/page.tsx` or a review component). Verify it tolerates an `answers` key with no matching current `FormField` (a field deleted/renamed after submission). If it maps over CURRENT fields it is already safe; if it maps over answer keys and looks up the field, guard the missing-field case to render the raw value under its key rather than throw. Add/adjust a test if a unit-testable seam exists; otherwise note the manual check in the report.

- [ ] **Step 5: Verify** (`tsc`, lint, service tests). **Commit.**

```bash
git commit -am "feat(recruitment): allow form edits on open cycles with a live-cycle warning"
```

---

### Task 7: Wire conditions into the default templates

**Files:**
- Modify: `src/modules/recruitment/templates/types.ts` (`TemplateField.visibleWhen?`)
- Modify: `src/modules/recruitment/templates/materialize.ts` (write `visibleWhen`)
- Modify: `src/modules/recruitment/templates/field-groups.ts` (attach conditions)
- Modify: `src/modules/recruitment/templates/index.test.ts` / `field-groups.test.ts` (assert conditions)

- [ ] **Step 1:** Add `visibleWhen?: FieldCondition` to `TemplateField` (import the type). In `materializeTemplate`, include `visibleWhen: (f.visibleWhen ?? undefined) as Prisma.InputJsonValue | undefined` in the `createMany` field data.

- [ ] **Step 2: Write the failing test** — `getApplicationTemplate("VOLUNTEER", [...])` produces the `other_languages_detail` field with `visibleWhen = { field: "other_languages", op: "is", value: "yes" }`, `medical_certifications`/`medical_details` gated on `licensed_professional is "yes"`, and `yale_affiliation_other` gated on `yale_affiliation isAnyOf ["other_yale","staff"]`.

- [ ] **Step 3: Implement** — in `field-groups.ts`, add the `visibleWhen` to those fields in `languagesSection`, `eligibilitySection`, and `identitySection`. Example (languages):

```ts
{ key: "other_languages_detail", label: "Which other languages do you speak?", type: "SHORT_TEXT", required: false,
  visibleWhen: { field: "other_languages", op: "is", value: "yes" } },
```
Apply analogous conditions for the director template's equivalent fields.

- [ ] **Step 4: Run, verify pass. Commit.**

```bash
git commit -am "feat(recruitment): default templates use conditional questions"
```

---

### Task 8: Onboarding prefill (affiliation, grad year, Spanish)

**Files:**
- Modify: `src/modules/recruitment/services/onboarding.ts` (`createOrResendContract`)
- Modify: `src/app/onboard/[token]/page.tsx` (`prefill`)
- Modify: `src/app/onboard/[token]/contract-field.tsx` (defaults)
- Test: `src/modules/recruitment/services/onboarding.test.ts` (add)

- [ ] **Step 1: Write the failing test** — creating a contract for an acceptance whose `application.answers` includes `yale_affiliation`, `grad_year`, and `spanish_proficiency: "conversational"` produces an `OnboardingContract` with `yaleAffiliation`/`gradYear` populated and `spanishSelfReported === true`; with `spanish_proficiency: "none"` → `spanishSelfReported === false`; with those keys absent → the columns stay blank/false (no throw).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — in `createOrResendContract`, read `acceptance.application.answers` (include it in the query) and widen the `create` data:
```ts
const a = (acceptance.application.answers ?? {}) as Record<string, unknown>;
// ...existing firstName/lastName/email/netId/phone...
yaleAffiliation: typeof a.yale_affiliation === "string" ? a.yale_affiliation : undefined,
gradYear: typeof a.grad_year === "string" ? a.grad_year : undefined,
spanishSelfReported: typeof a.spanish_proficiency === "string" && a.spanish_proficiency !== "none",
```
Add `yaleAffiliation`, `gradYear`, `spanish` to the `prefill` object in `page.tsx` and apply them as `defaultValue`/`defaultChecked` in `contract-field.tsx` (the affiliation/gradYear system fields and the spanish checkbox).

- [ ] **Step 4: Run, verify pass. Commit.**

```bash
git commit -am "feat(recruitment): prefill onboarding affiliation/grad-year/Spanish from the application"
```

---

### Task 9: Fix the e2e suite for the default form

**Files:**
- Modify: `e2e/fixtures.ts` (add `fillDefaultApplication` helper)
- Modify: `e2e/recruitment.spec.ts`, `e2e/recruitment-review.spec.ts`, `e2e/recruitment-onboarding.spec.ts`, `e2e/recruitment-interviews.spec.ts`

- [ ] **Step 1:** Run the 4 specs against the local app to see the current failures (or read them). Identify the shared apply-flow pattern.

- [ ] **Step 2: Section locator.** Replace the `h2:"Your information"` locator with `"Personal details"` (the template's identity section title), or a robust locator like the section containing the first-name input. Fix in `recruitment.spec.ts` and any other spec that uses it.

- [ ] **Step 3: Shared apply helper.** Add `fillDefaultApplication(applyPage, opts)` to `e2e/fixtures.ts` that walks the default-form wizard: fills identity (first/last/netid/email/phone as needed), selects Yale affiliation, Spanish proficiency, "speak other languages? = No" (so the conditional detail stays hidden), the department-choice field, availability (at least the required minimum), and the contract acknowledgement/initials fields, clicking "Continue" through each visible step until "Submit application" appears, then submits and asserts "your application was received". Use the conditional questions to keep the flow minimal (answer the gates "No" so dependent questions stay hidden).

- [ ] **Step 4:** Replace the inline apply flows in the 4 specs with calls to `fillDefaultApplication`, preserving each spec's surrounding intent (build/publish before; decide/onboard/interview after).

- [ ] **Step 5: Run the 4 specs.** `npx playwright test e2e/recruitment.spec.ts e2e/recruitment-review.spec.ts e2e/recruitment-onboarding.spec.ts e2e/recruitment-interviews.spec.ts` (per the repo's e2e run instructions — check `package.json`/`playwright.config.ts` for the DB/app setup). All green.

- [ ] **Step 6: Commit.**

```bash
git commit -am "test(e2e): update recruitment apply flows for the default form"
```

---

## Self-Review

**Spec coverage:**
- Component 1 (data model) → Task 1. Component 2 (engine) → Task 2. Component 4 (validation, strip-on-submit) → Task 3. Component 3 (wizard reactivity/unmount) → Task 4. Component 5 (builder control) → Task 5. Component 8 (open-cycle editability + warnings + harden review) → Task 6. Component 6 (templates use conditions) → Task 7. Component 7 (onboarding prefill) → Task 8. Component 9 (e2e) → Task 9. Testing section spread across all tasks.

**Placeholder scan:** UI-heavy tasks (4, 5, 6, 9) give precise steps + key code and direct the implementer to read the current component (which #292 may have changed) rather than reproduce large React/Playwright files verbatim — the "how" is concrete (exact props, guard conditions, helper shape). No `TODO`/`TBD` in shipped code. The migration step is explicit about trimming drift.

**Type consistency:** `FieldCondition`/`parseFieldCondition`/`isFieldVisible`/`visibleFields` defined once (Tasks 1-2), consumed unchanged in Tasks 3, 4, 5, 7. `visibleWhen` is the single column/prop name throughout. `assertCycleEditable`'s relaxed condition (`=== "ARCHIVED"`) is stated identically in the Global Constraints and Task 6.
