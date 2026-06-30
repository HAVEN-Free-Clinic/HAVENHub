# UI Cohesion Phase 4 (Controls + Guardrails) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an ESLint guardrail (plus house-style doc) that blocks hand-rolled styled controls, then resolve the remaining control/primitive loose ends so the rule passes cleanly.

**Architecture:** Make the primitive changes first (SectionHeader `as`, StatCard/Table onto cardClasses), apply/clean up (h3 nesting, focus rings, training-quiz Field, reindent), sweep every styled raw control (convert plain ones to primitives, annotate genuinely-specialized ones with `eslint-disable` + reason), then add the `no-restricted-syntax` rule LAST so the build goes green only once the sweep is complete. All control changes preserve name/value/handler/focus behavior.

**Tech Stack:** Next.js (App Router), React, Tailwind CSS (semantic tokens), ESLint flat config (`eslint-config-next`), Vitest (`environment: node`).

## Global Constraints

- **No em-dashes** in any code comment, copy, doc, or commit message. Use commas, colons, parentheses, periods. (User preference.)
- **Product name** "HAVEN Hub" (two words) in prose/UI; identifiers stay `havenhub`.
- **Presentational/behavioral preservation:** never change a control's `name`/`value`/`defaultChecked`/`checked`/`onClick`/`onChange`/`type` or its form wiring. Focus behavior is preserved or improved (toward canonical).
- **Semantic tokens only:** no hardcoded hex or slate-N.
- **Canonical focus rings:** button/checkbox/radio = `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand`; form controls (input/select/textarea) = `focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15`.
- **Raw-control annotation convention:** a genuinely-required raw control gets `// eslint-disable-next-line no-restricted-syntax -- <one-line reason>` immediately above the opening tag.
- **Tests** run in `environment: node`; component tests call the component as a function and assert on `el.props` (see `spinner.test.ts`). Test files are `*.test.ts`.
- **Stale Prisma client caveat:** this branch sits on the merged-main state, so `tsc` reports ~25 pre-existing stale-client errors. A task is clean if it adds NO NEW `tsc` errors referencing the files it changed. Do NOT `prisma generate`; CI regenerates.
- **Ordering note:** the ESLint rule is added in the LAST task (Task 9). During the sweep tasks (7, 8) the `eslint-disable` directives are inert and ESLint may emit "unused disable directive" WARNINGS; these do not fail `eslint .` (no `--max-warnings`). Sweep tasks gate on `tsc` + a grep self-check, not on lint. Task 9 activates the rule and verifies a fully green `eslint .`.

---

## File Structure

**Modified primitives:**
- `src/platform/ui/section-header.tsx` (+ `section-header.test.ts`): add `as?: "h2" | "h3"`.
- `src/platform/ui/stat-card.tsx`, `src/platform/ui/table.tsx`: use `cardClasses()`.

**New file:**
- `docs/ui-house-style.md`: the house-style reference.

**Modified config:**
- `eslint.config.mjs`: the `no-restricted-syntax` rule (Task 9).

**Swept/cleaned app + module files:** named per task.

---

## Task 1: SectionHeader `as` variant

**Files:**
- Modify: `src/platform/ui/section-header.tsx`
- Test: `src/platform/ui/section-header.test.ts`

**Interfaces:**
- Produces: `SectionHeader({ level?: "eyebrow" | "title"; as?: "h2" | "h3"; className?: string; children: ReactNode })` rendering the `as` tag (default `h2`).

- [ ] **Step 1: Add the failing test**

Append to `src/platform/ui/section-header.test.ts`:

```ts
  it("renders as an h3 when as='h3', keeping the level styling", () => {
    const el = SectionHeader({ as: "h3", children: "Subsection" });
    expect(el.type).toBe("h3");
    expect(el.props.className).toContain("uppercase");
    expect(el.props.children).toBe("Subsection");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/ui/section-header.test.ts`
Expected: FAIL (current component hardcodes `<h2>`, so `el.type` is `"h2"`).

- [ ] **Step 3: Implement the `as` prop**

Replace the `SectionHeader` function in `src/platform/ui/section-header.tsx` with:

```tsx
export function SectionHeader({
  level = "eyebrow",
  as: Tag = "h2",
  className,
  children,
}: {
  level?: SectionHeaderLevel;
  as?: "h2" | "h3";
  className?: string;
  children: ReactNode;
}) {
  return <Tag className={cx(levelClasses[level], className)}>{children}</Tag>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/ui/section-header.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/section-header.tsx src/platform/ui/section-header.test.ts
git commit -m "feat(ui): add optional as prop (h2/h3) to SectionHeader"
```

---

## Task 2: StatCard + Table use cardClasses

**Files:**
- Modify: `src/platform/ui/stat-card.tsx`, `src/platform/ui/table.tsx`

**Interfaces:**
- Consumes: `cardClasses({ pad?, size?, interactive? })` from `@/platform/ui/card` (Phase 2).

- [ ] **Step 1: stat-card.tsx**

Add the import and replace the `base` constant. In `src/platform/ui/stat-card.tsx`:
- Add at top: `import { cardClasses } from "./card";`
- Replace `const base = "block rounded-2xl border border-border bg-surface p-5 shadow-sm";` with:

```tsx
  const base = cx("block", cardClasses());
```

(Keep the linked branch's `"transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md"` and `focus-visible:outline-...` classes exactly as they are. StatCard's hover uses `border-brand/40`, NOT Card's interactive hover, so do NOT pass `interactive: true`.) `cardClasses()` emits `border border-border bg-surface rounded-2xl shadow-sm p-5`, so `cx("block", cardClasses())` is output-equivalent to the old `base`.

- [ ] **Step 2: table.tsx**

In `src/platform/ui/table.tsx`:
- Add at top: `import { cardClasses } from "./card";`
- Replace `<div className="rounded-2xl border border-border bg-surface overflow-x-auto shadow-sm">` with:

```tsx
    <div className={cx(cardClasses({ pad: false }), "overflow-x-auto")}>
```

`cardClasses({ pad: false })` emits `border border-border bg-surface rounded-2xl shadow-sm` (no padding), so with `overflow-x-auto` this is output-equivalent.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors beyond the known stale-client set.

- [ ] **Step 4: Confirm the existing card test still passes (cardClasses unchanged)**

Run: `npx vitest run src/platform/ui/card.test.ts`
Expected: PASS (cardClasses is unchanged; this just confirms no accidental edit).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/stat-card.tsx src/platform/ui/table.tsx
git commit -m "refactor(ui): StatCard and Table use cardClasses instead of hardcoded card strings"
```

---

## Task 3: Apply SectionHeader as="h3" to flattened subsections

**Files (set `as="h3"` on the section sub-labels that sit UNDER a section-level `<h2>`):**
- `src/modules/my-info/components/hipaa-panel.tsx` (the "Current Certificate"/"Upload New Certificate"/"History" sub-labels under the panel's section heading)
- `src/modules/my-info/components/epic-panel.tsx` (the "Request Epic Access" sub-heading under "Epic Access")
- `src/modules/schedule/components/pending-requests.tsx` ("Recent decisions" sub-label under "Pending Requests")
- `src/modules/schedule/components/readiness-panel.tsx` ("Readiness" sub-label under "RHD Clinic Readiness")

**Interfaces:**
- Consumes: `SectionHeader` with `as` (Task 1).

- [ ] **Step 1: Add `as="h3"` to the nested SectionHeader usages**

In each file, find the `<SectionHeader ...>` calls that are SUBSECTION labels nested beneath a higher section heading (a hand-rolled `<h2>` or another SectionHeader rendering h2 above them in the same component), and add `as="h3"`. Only the genuinely-nested ones; top-level section eyebrows stay `h2` (default). Preserve text and any `level`/`className`. If a file has only one section heading (not nested), leave it.

- [ ] **Step 2: Verify**

Run: `git diff src/modules/my-info/ src/modules/schedule/`
Confirm: only `as="h3"` added to nested headings; text unchanged.
Run: `npx tsc --noEmit` (no NEW errors).

- [ ] **Step 3: Commit**

```bash
git add src/modules/my-info/components/hipaa-panel.tsx src/modules/my-info/components/epic-panel.tsx src/modules/schedule/components/pending-requests.tsx src/modules/schedule/components/readiness-panel.tsx
git commit -m "fix(ui): nest subsection SectionHeaders as h3 to restore heading hierarchy"
```

---

## Task 4: Focus-ring unification (builder-cell + pill checkboxes)

**Files:**
- `src/modules/schedule/components/builder-cell.tsx` (3 grid-cell buttons, ~lines 99/118/166)
- `src/app/(app)/schedule/page.tsx` and `src/app/(app)/schedule/builder/page.tsx` (date-pill checkboxes)

- [ ] **Step 1: builder-cell focus ring + annotate**

In `builder-cell.tsx`, on the 3 buttons, replace `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-fg` with `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand`. These remain raw grid-cell controls (not standard Buttons: full-cell layout + custom states), so add immediately above each `<button>`:
`{/* eslint-disable-next-line no-restricted-syntax -- grid-cell action button, not a standard Button */}`
Preserve every onClick/disabled/aria/children.

- [ ] **Step 2: Convert the date-pill checkboxes to Checkbox**

In `schedule/page.tsx` and `schedule/builder/page.tsx`, the date pills are a `<label className="...pill...">` wrapping `<input type="checkbox" className="h-3 w-3 ... focus:ring-brand focus:ring-1 accent-brand" ...>`. Replace the inner `<input type="checkbox" ...>` with `<Checkbox className="h-3 w-3" ... />` (import `Checkbox` from `@/platform/ui/checkbox`), keeping the pill `<label>` wrapper and every `name`/`value`/`defaultChecked`/`checked`/`onChange` attribute. The `Checkbox` primitive supplies the canonical `accent-brand` + outline focus ring; the `h-3 w-3` className keeps the small pill size.

- [ ] **Step 3: Verify**

Run: `git diff src/modules/schedule/components/builder-cell.tsx "src/app/(app)/schedule/page.tsx" "src/app/(app)/schedule/builder/page.tsx"`
Confirm: focus classes canonical; no name/value/onChange change; pill labels intact.
Run: `npx tsc --noEmit` (no NEW errors).

- [ ] **Step 4: Commit**

```bash
git add src/modules/schedule/components/builder-cell.tsx "src/app/(app)/schedule/page.tsx" "src/app/(app)/schedule/builder/page.tsx"
git commit -m "refactor(schedule): unify focus rings; pills use the Checkbox primitive"
```

---

## Task 5: Converge training-quiz onto the platform Field

**Files:**
- `src/app/(app)/training/training-quiz.tsx`

- [ ] **Step 1: Replace the local Field with the platform Field**

In `training-quiz.tsx`, delete the local `Field` component definition and import the platform one: `import { Field, Input, Textarea } from "@/platform/ui/input";` (and `Select` from `@/platform/ui/select` if used). For each usage:
- A field that passed `optional` becomes a `Field` with the optional state shown via its `hint` (e.g. `hint="Optional"`) or omitted if not meaningful.
- A field that passed `full` (grid span) wraps in a `className` span on the field container, e.g. put the `<Field>` inside `<div className="sm:col-span-2">` or pass the span class to a wrapping element, rather than extending the platform `Field` API.
Keep all `name`/`defaultValue`/`required` on the inner controls unchanged.

- [ ] **Step 2: Verify**

Run: `git diff "src/app/(app)/training/training-quiz.tsx"`
Confirm: local `Field` definition removed; platform `Field` used; control `name`/`defaultValue`/`required` unchanged; grid spans preserved via className.
Run: `npx tsc --noEmit` (no NEW errors).

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/training/training-quiz.tsx"
git commit -m "refactor(training): use the platform Field in the training quiz"
```

---

## Task 6: Card-child reindent (cosmetic)

**Files:**
- `src/modules/admin/components/person-form.tsx`, `department-form.tsx`, `term-form.tsx`, `subcommittee-form.tsx`, `delegation-editor.tsx`

- [ ] **Step 1: Reindent Card children**

In each file, where Phase 2 inserted `<Card>` but left children at the prior indent, reindent so children sit one level inside `<Card>` and the closing `</Card>` aligns with the opening `<Card>`. If the project has a formatter (`npx prettier --write <files>` if prettier is a devDependency), run it on these files; otherwise reindent by hand. No token/text/logic change, only whitespace.

- [ ] **Step 2: Verify it is whitespace-only**

Run: `git diff -w src/modules/admin/components/person-form.tsx src/modules/admin/components/department-form.tsx src/modules/admin/components/term-form.tsx src/modules/admin/components/subcommittee-form.tsx src/modules/admin/components/delegation-editor.tsx`
Expected: EMPTY (the `-w` ignores whitespace, so an empty diff proves only indentation changed).
Run: `npx tsc --noEmit` (no NEW errors).

- [ ] **Step 3: Commit**

```bash
git add src/modules/admin/components/person-form.tsx src/modules/admin/components/department-form.tsx src/modules/admin/components/term-form.tsx src/modules/admin/components/subcommittee-form.tsx src/modules/admin/components/delegation-editor.tsx
git commit -m "style(admin): reindent Card children in migrated forms"
```

---

## Task 7: Raw-control sweep, src/app

**Files:** all `src/app/**/*.tsx` with a styled raw `<button>/<input>/<select>/<textarea>` (the rule is not added yet; enumerate with grep).

- [ ] **Step 1: Enumerate**

Run:
```bash
grep -rnE '<(button|input|select|textarea)\b' "src/app" --include="*.tsx" | grep -v 'type="hidden"'
```
(Multi-line elements: also open any file with a raw control to find its `className`.) Known hotspots: `admin/email/templates/[key]/preview.tsx` (~14 editor-toolbar buttons), `admin/email/campaigns/[id]/audience-builder.tsx` (segmented ALL/ANY toggle), `admin/email/campaigns/[id]/cron-presets.tsx`, `notifications/page.tsx`, `get-started/page.tsx`, `login/sign-in-button.tsx`, `learning/[courseId]/ScormPlayer.tsx`, and the native file inputs in `learning/manage/[courseId]/UploadPackageForm.tsx`, `admin/settings/branding-image-field.tsx`, `onboard/[token]/onboard-form.tsx`.

- [ ] **Step 2: Convert or annotate each**

For each styled raw control:
- If it is a plain action button, convert to `<Button variant=...>` (import from `@/platform/ui/button`), preserving onClick/label/disabled/type.
- If it is genuinely specialized (editor toolbar toggle, segmented toggle, tab, popover trigger, native file input), keep it raw and add immediately above the opening tag: `// eslint-disable-next-line no-restricted-syntax -- <specific reason>` (e.g. `editor toolbar toggle`, `segmented match-mode toggle`, `native file input, no file primitive`). Use a JSX comment form `{/* eslint-disable-next-line no-restricted-syntax -- reason */}` inside JSX.
Do not change any control's behavior.

- [ ] **Step 3: Verify**

Run: `git diff "src/app"` and confirm only control conversions/annotations; no behavior wiring changed.
Run: `npx tsc --noEmit` (no NEW errors).

- [ ] **Step 4: Commit**

```bash
git add "src/app"
git commit -m "refactor(app): convert or annotate raw controls for the no-raw-control rule"
```

---

## Task 8: Raw-control sweep, src/modules

**Files:** all `src/modules/**/*.tsx` with a styled raw control, EXCEPT `builder-cell.tsx` (already done in Task 4).

- [ ] **Step 1: Enumerate**

Run:
```bash
grep -rnE '<(button|input|select|textarea)\b' "src/modules" --include="*.tsx" | grep -v 'type="hidden"'
```
Known: `admin/components/epic-request-tabs.tsx` (tab buttons), the recruitment builder drag-handle / add buttons (`type-picker.tsx`, `section-card.tsx`, `options-editor.tsx`, `field-card.tsx`), `clinic/avs/avs-tool.tsx`, the `recruitment/components/field-preview.tsx` native file input.

- [ ] **Step 2: Convert or annotate each** (same rule as Task 7 Step 2: convert plain action buttons to `<Button>`; annotate specialized ones with a specific reason: `tab control`, `dnd drag handle`, `segmented toggle`, `native file input, no file primitive`).

- [ ] **Step 3: Verify**

Run: `git diff "src/modules"` and confirm only conversions/annotations; no behavior change; `builder-cell.tsx` unchanged here.
Run: `npx tsc --noEmit` (no NEW errors).

- [ ] **Step 4: Commit**

```bash
git add "src/modules"
git commit -m "refactor(modules): convert or annotate raw controls for the no-raw-control rule"
```

---

## Task 9: Add the ESLint rule + house-style doc + green gate

**Files:**
- Modify: `eslint.config.mjs`
- Create: `docs/ui-house-style.md`

- [ ] **Step 1: Add the rule**

In `eslint.config.mjs`, add a new config block (after the existing module-import block):

```js
  {
    files: ["src/app/**/*.tsx", "src/modules/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXOpeningElement[name.name=/^(button|input|select|textarea)$/] > JSXAttribute[name.name='className']",
          message:
            "Use the shared UI primitives (Button/Input/Select/Textarea/Checkbox/Radio from @/platform/ui) instead of a styled raw control. If a raw element is genuinely required, add an eslint-disable-next-line no-restricted-syntax with a one-line reason. See docs/ui-house-style.md.",
        },
      ],
    },
  },
```

- [ ] **Step 2: Run the rule, drive to green**

Run: `npx eslint .`
Expected: any remaining styled raw control in `src/app`/`src/modules` errors. For each error, convert or annotate it (the Tasks 7-8 sweep should have caught most; fix any straggler now). Re-run until `npx eslint .` reports no errors.

- [ ] **Step 3: Negative check (the rule actually fires)**

Temporarily add `<button className="x" />` to any `src/app/**/page.tsx`, run `npx eslint <that file>`, confirm it errors with the rule's message, then remove the temporary button and re-run to confirm clean. Record the observed error in the report.

- [ ] **Step 4: Write the house-style doc**

Create `docs/ui-house-style.md` with these sections (no em-dashes):
- **Primitives:** a table of the platform/ui components and when to use each: `Button`/`buttonClasses`, `Input`/`Textarea`/`Field`/`ReadonlyField`, `Select`, `Checkbox`, `Radio`/`RadioGroup`, `FormSection`/`FormActions`, `Card`/`cardClasses` (default + `compact`), `SectionHeader` (eyebrow/title, `as` h2/h3), `PageHeader`, `Alert`, `Badge`, `Modal`, `Table`, `StatCard`, `Spinner`/`Skeleton`.
- **Tokens:** control radius `rounded-lg` + `border-border-strong`; surface radius `rounded-2xl` (compact `rounded-xl`); the two focus-ring patterns (verbatim); semantic-tokens-only (no hex/slate-N); "HAVEN Hub" naming; no em-dashes.
- **Forms recipe:** carded form, `ReadonlyField` for read-only rows, `Field` labels, `FormActions` footer.
- **When raw is acceptable:** the categories (toolbar toggles, tabs, drag handles, segmented toggles, native file inputs, grid-cell buttons) and the `// eslint-disable-next-line no-restricted-syntax -- reason` convention, enforced by the rule added in this phase.

- [ ] **Step 5: Final verification**

Run: `npm run lint` (green), `npx tsc --noEmit` (only stale-client errors), `npx vitest run src/platform/ui/` (all platform/ui tests pass).

- [ ] **Step 6: Commit**

```bash
git add eslint.config.mjs docs/ui-house-style.md
git commit -m "feat(ui): enforce no-raw-styled-controls via ESLint + add house-style doc"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- ESLint guardrail + scope + message: Task 9. ✓
- Raw-control sweep (convert/annotate): Tasks 7 (app) + 8 (modules) + builder-cell in Task 4. ✓
- Focus-ring unification (builder-cell + pill checkboxes): Task 4. ✓
- StatCard + Table -> cardClasses: Task 2. ✓
- SectionHeader `as` variant + apply to flattened subsections: Tasks 1 + 3. ✓
- training-quiz Field convergence: Task 5. ✓
- Card-child reindent: Task 6. ✓
- House-style doc: Task 9. ✓
- Negative check the rule fires: Task 9 Step 3. ✓
- Ordering hazard (rule added last so sweep tasks stay green): Global Constraints "Ordering note" + Task 9. ✓

**Placeholder scan:** Tasks 1, 2, 9 contain complete code/config. Sweep tasks (7, 8) and the apply task (3) use a grep-driven recipe with exact convert/annotate rules and named hotspots, since the authoritative list is the rule's own output. No "TBD"/"handle the rest".

**Type consistency:** `SectionHeader({ level, as, className, children })` (Task 1) used in Task 3. `cardClasses({ pad?, size?, interactive? })` (Phase 2) consumed in Task 2. `Checkbox` import path `@/platform/ui/checkbox` (Task 4). `Button` from `@/platform/ui/button` (Tasks 7-8).
