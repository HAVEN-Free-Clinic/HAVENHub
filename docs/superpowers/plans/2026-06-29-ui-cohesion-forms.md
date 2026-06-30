# UI Cohesion Phase 1 (Forms) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize every form in HAVEN Hub onto one canonical carded pattern with shared primitives, eliminating the read-only/editable visual mismatch and the three competing form styles.

**Architecture:** Add four small presentational primitives to `src/platform/ui/` (`ReadonlyField`, `Radio`/`RadioGroup`, `FormSection`, `FormActions`), then migrate all form-bearing components onto the canonical pattern: primary edit/create forms wrapped in `<Card>`, read-only values rendered as static `ReadonlyField` rows, all controls routed through `Field`+`Input`/`Select`/`Textarea`/`Checkbox`/`Radio`, labels at the `Field` default (`text-xs font-medium text-muted-foreground`). Changes are presentational only: server actions, `name` attributes, and `defaultValue`s never change.

**Tech Stack:** Next.js (App Router), React Server Components + server actions, Tailwind CSS with semantic color tokens, Vitest (`environment: node`, pure-function component tests).

## Global Constraints

- **No em-dashes** in any code comment, copy, or commit message. Use commas, colons, parentheses, or periods. (User preference.)
- **Product name** is "HAVEN Hub" (two words) in prose/UI; identifiers stay `havenhub`.
- **Presentational only:** never change a form's server `action`, control `name`, validation, or `defaultValue`. If a diff changes any of those, it is out of scope for this phase.
- **Semantic tokens only:** use `text-foreground`, `text-muted-foreground`, `border-border`, `border-border-strong`, `bg-surface`, `bg-muted`, `text-brand`, etc. Never hardcode hex or slate-N classes. This keeps light/dark theming working.
- **Canonical tokens:** controls `rounded-lg` + `border-border-strong`; surfaces (Card) `rounded-2xl` + `border-border`; form-control focus = `focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15`; button/checkbox/radio focus = `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand`.
- **Tests** run in `environment: node`; component tests call the component as a function and assert on `el.props` (see existing `spinner.test.ts`). Test files are `*.test.ts` (not `.tsx`).
- **Run a single test file:** `npx vitest run src/platform/ui/<name>.test.ts`.
- **DB caveat:** the full `npm test` suite needs a local Postgres at `localhost:5434` (or `TEST_DATABASE_URL` set to a per-worktree DB). Never point Prisma migrate or tests at the shared Neon DB. The new primitive tests in this plan touch no DB.

---

## File Structure

**New files:**
- `src/platform/ui/radio.tsx` + `src/platform/ui/radio.test.ts` — `Radio`, `RadioGroup`.
- `src/platform/ui/form.tsx` + `src/platform/ui/form.test.ts` — `FormSection`, `FormActions`.

**Modified primitive file:**
- `src/platform/ui/input.tsx` (+ new `src/platform/ui/input.test.ts`) — add `ReadonlyField` beside `Field`.

**Migrated form files:** grouped by module in Tasks 5 to 12 (full inventory in each task). The three infra `<form>` files (`platform/ui/app-shell.tsx`, `combobox.tsx`, `submit-button.tsx`) are NOT touched.

---

## The Migration Recipe (referenced by Tasks 5 to 12)

Every form migration applies this recipe. Tasks below name the exact files and call out per-file specifics; the mechanical transformation is always one of these moves:

1. **Card the form.** For a primary create/edit form, wrap the field body in `<Card className="space-y-6">` (import `Card` from `@/platform/ui/card`). Put error/success `<Alert>`s as the first children inside the Card. Small inline utilities (search/filter boxes, single-field actions, dev-login) are NOT carded; they only get primitive controls.
2. **Replace read-only "fake input" rows.** Any `<p className="rounded-xl border ... bg-muted ...">{value}</p>` paired with a hand-rolled label becomes `<ReadonlyField label="..." value={value} hint="..." />`.
3. **Route every editable control through `Field` + primitive.** Replace raw `<input>`/`<select>`/`<textarea>` (with inline className) with `<Field label="..."><Input .../></Field>` (or `Select`/`Textarea`). Keep `name`, `defaultValue`, `type`, `required`, `placeholder` exactly as they were.
4. **Replace hand-rolled checkboxes/radios.** `<input type="checkbox" className=...>` becomes `<Checkbox ... />`; `<input type="radio" ...>` groups become `<RadioGroup><Radio label=... /></RadioGroup>`. Preserve `name`/`value`/`defaultChecked`.
5. **Standardize the footer.** Wrap the submit area in `<FormActions>...<SubmitButton>...</SubmitButton></FormActions>`.
6. **Labels.** Delete ad-hoc `text-sm font-medium` labels; the label now comes from `Field`/`ReadonlyField` (`text-xs font-medium text-muted-foreground`).

After each file: confirm no `name`/`action`/`defaultValue` changed (diff review), then typecheck.

---

## Task 1: `ReadonlyField` primitive

**Files:**
- Modify: `src/platform/ui/input.tsx` (add export beside `Field`)
- Test: `src/platform/ui/input.test.ts` (new)

**Interfaces:**
- Produces: `ReadonlyField({ label: string; value: ReactNode; hint?: string }): ReactElement` — a static (non-interactive, non-tab-stop) label+value display row with an optional hint. Empty `value` shows an italic "Not set" placeholder.

- [ ] **Step 1: Write the failing test**

Create `src/platform/ui/input.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ReadonlyField } from "./input";

describe("ReadonlyField", () => {
  it("renders the label as muted text and the value as static foreground text", () => {
    const el = ReadonlyField({ label: "Epic ID", value: "CARNEYJU" });
    expect(el.type).toBe("div");
    const [labelSpan, valueP] = el.props.children;
    expect(labelSpan.props.children).toBe("Epic ID");
    expect(labelSpan.props.className).toContain("text-muted-foreground");
    expect(valueP.type).toBe("p");
    expect(valueP.props.children).toBe("CARNEYJU");
    expect(valueP.props.className).toContain("border-b");
    expect(valueP.props.className).toContain("text-foreground");
  });

  it("shows a 'Not set' placeholder when value is empty", () => {
    const el = ReadonlyField({ label: "Phone", value: "" });
    const valueP = el.props.children[1];
    expect(JSON.stringify(valueP.props.children)).toContain("Not set");
  });

  it("renders an optional hint as subtle text", () => {
    const el = ReadonlyField({ label: "Epic ID", value: "X", hint: "Contact IT" });
    const hint = el.props.children[2];
    expect(hint.props.children).toBe("Contact IT");
    expect(hint.props.className).toContain("text-subtle-foreground");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/ui/input.test.ts`
Expected: FAIL with "ReadonlyField is not a function" (or import/undefined error).

- [ ] **Step 3: Add the implementation**

In `src/platform/ui/input.tsx`, after the `Field` function, add:

```tsx
/**
 * Static display row for a non-editable value (IT-managed fields, computed
 * values). Renders as plain text with a hairline underline so it reads as
 * information, not as a disabled input, and is not a tab stop.
 */
export function ReadonlyField({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <p className="min-h-[34px] border-b border-border py-1.5 text-sm font-medium text-foreground">
        {value || (
          <span className="font-normal italic text-subtle-foreground">Not set</span>
        )}
      </p>
      {hint && <p className="text-xs text-subtle-foreground">{hint}</p>}
    </div>
  );
}
```

(`ReactNode` is already imported in `input.tsx`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/ui/input.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/input.tsx src/platform/ui/input.test.ts
git commit -m "feat(ui): add ReadonlyField static display primitive"
```

---

## Task 2: `Radio` and `RadioGroup` primitives

**Files:**
- Create: `src/platform/ui/radio.tsx`
- Test: `src/platform/ui/radio.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `Radio({ label: ReactNode } & ComponentProps<"input">): ReactElement` — a `<label>` wrapping a real `input[type=radio]` with the brand outline focus ring (matches `Checkbox`).
  - `RadioGroup({ legend?: string; children: ReactNode; className?: string }): ReactElement` — `div[role=radiogroup]` with an optional legend.

- [ ] **Step 1: Write the failing test**

Create `src/platform/ui/radio.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Radio, RadioGroup } from "./radio";

describe("Radio", () => {
  it("renders a real radio input with the brand outline focus ring", () => {
    const el = Radio({ label: "Yes", name: "answer", value: "yes" });
    expect(el.type).toBe("label");
    const [input, span] = el.props.children;
    expect(input.props.type).toBe("radio");
    expect(input.props.name).toBe("answer");
    expect(input.props.value).toBe("yes");
    expect(input.props.className).toContain("accent-brand");
    expect(input.props.className).toContain("outline-brand");
    expect(span.props.children).toBe("Yes");
  });
});

describe("RadioGroup", () => {
  it("uses role=radiogroup and renders an optional legend", () => {
    const el = RadioGroup({ legend: "Pick one", children: null });
    expect(el.props.role).toBe("radiogroup");
    const [legend] = el.props.children;
    expect(legend.props.children).toBe("Pick one");
    expect(legend.props.className).toContain("text-muted-foreground");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/ui/radio.test.ts`
Expected: FAIL with "Failed to resolve import ./radio" or "Radio is not a function".

- [ ] **Step 3: Write the implementation**

Create `src/platform/ui/radio.tsx`:

```tsx
import type { ComponentProps, ReactNode } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Brand-tinted radio with the same visible focus ring as Checkbox, so keyboard
 * users get a consistent focus affordance across all form controls.
 */
export function Radio({
  label,
  className,
  ...rest
}: { label: ReactNode } & ComponentProps<"input">) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="radio"
        {...rest}
        className={cx(
          "h-4 w-4 border-border-strong text-brand accent-brand cursor-pointer",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          className,
        )}
      />
      <span>{label}</span>
    </label>
  );
}

export function RadioGroup({
  legend,
  children,
  className,
}: {
  legend?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div role="radiogroup" className={cx("flex flex-col gap-2", className)}>
      {legend && (
        <span className="text-xs font-medium text-muted-foreground">{legend}</span>
      )}
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/ui/radio.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/radio.tsx src/platform/ui/radio.test.ts
git commit -m "feat(ui): add Radio and RadioGroup primitives"
```

---

## Task 3: `FormSection` and `FormActions` primitives

**Files:**
- Create: `src/platform/ui/form.tsx`
- Test: `src/platform/ui/form.test.ts` (new)

**Interfaces:**
- Produces:
  - `FormSection({ title?: string; description?: string; children: ReactNode }): ReactElement` — a border-reset `<fieldset>` with an optional uppercase `<legend>` and optional description, `space-y-4` body.
  - `FormActions({ children: ReactNode; align?: "start" | "end"; className?: string }): ReactElement` — a flex row footer for buttons, `pt-2`, optional right-align.

- [ ] **Step 1: Write the failing test**

Create `src/platform/ui/form.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FormSection, FormActions } from "./form";

describe("FormSection", () => {
  it("renders a border-reset fieldset with an uppercase legend", () => {
    const el = FormSection({ title: "Contact details", children: null });
    expect(el.type).toBe("fieldset");
    expect(el.props.className).toContain("border-0");
    const [legend] = el.props.children;
    expect(legend.props.children).toBe("Contact details");
    expect(legend.props.className).toContain("uppercase");
    expect(legend.props.className).toContain("text-muted-foreground");
  });
});

describe("FormActions", () => {
  it("is a left-aligned flex row by default", () => {
    const el = FormActions({ children: null });
    expect(el.props.className).toContain("flex");
    expect(el.props.className).not.toContain("justify-end");
  });

  it("right-aligns when align=end", () => {
    expect(FormActions({ children: null, align: "end" }).props.className).toContain(
      "justify-end",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/ui/form.test.ts`
Expected: FAIL with "Failed to resolve import ./form".

- [ ] **Step 3: Write the implementation**

Create `src/platform/ui/form.tsx`:

```tsx
import type { ReactNode } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * A labeled group of fields inside a form. Replaces the divergent hand-rolled
 * fieldset/legend blocks (and the field()/FieldPreview helpers) with one
 * consistent legend style.
 */
export function FormSection({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="m-0 space-y-4 border-0 p-0">
      {title && (
        <legend className="mb-3 p-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </legend>
      )}
      {description && <p className="-mt-2 text-xs text-subtle-foreground">{description}</p>}
      {children}
    </fieldset>
  );
}

/** Standard footer row for form submit/secondary buttons. */
export function FormActions({
  children,
  align = "start",
  className,
}: {
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex items-center gap-3 pt-2",
        align === "end" && "justify-end",
        className,
      )}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/ui/form.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/form.tsx src/platform/ui/form.test.ts
git commit -m "feat(ui): add FormSection and FormActions primitives"
```

---

## Task 4: Migrate My Info (reference implementation)

This is the canonical worked example. Later module tasks apply the same moves.

**Files:**
- Modify: `src/modules/my-info/components/my-info-form.tsx`

**Interfaces:**
- Consumes: `Card` (`@/platform/ui/card`), `ReadonlyField` (Task 1), `FormActions` (Task 3), existing `Field`/`Input`/`Select`/`SubmitButton`/`Alert`.

- [ ] **Step 1: Update imports**

In `src/modules/my-info/components/my-info-form.tsx`, replace the import block:

```tsx
import { Input, Field, ReadonlyField } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
```

- [ ] **Step 2: Card the form and convert read-only rows**

Replace the entire `return (...)` body with:

```tsx
  return (
    <form action={action}>
      <Card className="space-y-6">
        {error && <Alert tone="error">{error}</Alert>}
        {saved && <Alert tone="success">{saved}</Alert>}

        {/* Read-only identity rows (IT-managed) */}
        <div className="grid gap-4 sm:grid-cols-2">
          <ReadonlyField label="Name" value={person.name} />
          <ReadonlyField
            label="NetID"
            value={person.netId}
            hint="Contact the IT team to correct your name or NetID."
          />
          <ReadonlyField
            label="Epic ID"
            value={person.epicId}
            hint="Contact the IT team to update your Epic ID."
          />
        </div>

        {/* Editable fields */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone">
            <Input
              name="phone"
              type="tel"
              defaultValue={person.phone ?? ""}
              placeholder="203-555-0100"
            />
          </Field>

          <Field label="Email">
            <Input
              name="contactEmail"
              type="email"
              defaultValue={person.contactEmail ?? ""}
              placeholder="you@example.com"
            />
          </Field>

          <Field label="Yale Affiliation">
            <Select name="yaleAffiliation" defaultValue={currentAffiliation}>
              <option value="">Not set</option>
              {YALE_AFFILIATIONS.map((aff) => (
                <option key={aff} value={aff}>
                  {aff}
                </option>
              ))}
              {currentAffiliation && !isKnownAffiliation && (
                <option value={currentAffiliation}>{currentAffiliation}</option>
              )}
            </Select>
          </Field>

          <Field label="Grad Year">
            <Input
              name="gradYear"
              defaultValue={person.gradYear ?? ""}
              placeholder="2027"
              inputMode="numeric"
              maxLength={4}
              pattern="\d{4}"
            />
          </Field>
        </div>

        <FormActions>
          <SubmitButton variant="primary" pendingLabel="Saving…">
            Save
          </SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
```

- [ ] **Step 3: Verify no behavior changed**

Run: `git diff src/modules/my-info/components/my-info-form.tsx`
Confirm: every `name=` (`phone`, `contactEmail`, `yaleAffiliation`, `gradYear`), every `defaultValue`, and the `action` prop are unchanged. Only markup/styling changed.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Visual check (light + dark)**

Run the app (`npm run dev`), open `/my-info`. Confirm: the form sits in a white card; Name/NetID/Epic ID are static rows with a hairline, no filled boxes; inputs and the Save button are unchanged in behavior. Toggle dark mode via the theme toggle and confirm the card, hairline, and text contrast read correctly.

- [ ] **Step 6: Commit**

```bash
git add src/modules/my-info/components/my-info-form.tsx
git commit -m "refactor(my-info): card the profile form and use ReadonlyField for identity rows"
```

---

## Task 5: Migrate my-info remaining components

**Files (apply the Migration Recipe to each):**
- Modify: `src/modules/my-info/components/epic-panel.tsx` — has a raw control + form; card the request form, route the control through `Field`+`Select`/`Input`, footer via `FormActions`. Replace any read-only Epic ID display with `ReadonlyField`.
- Modify: `src/modules/my-info/components/hipaa-panel.tsx` — card the upload form; the file input stays a native `<input type="file">` (no file primitive) but wrap it in `Field` and keep its `name`. Submit area to `FormActions`.
- Modify: `src/modules/my-info/components/certificate-viewer.tsx` — replace raw `<button>`s with `<Button variant=...>` (import from `@/platform/ui/button`); keep onClick handlers and labels.
- Modify: `src/modules/my-info/components/memberships-card.tsx` — its `<form>` is a withdraw action button; ensure the action button uses `<SubmitButton>`/`<ConfirmButton>` and the surrounding surface uses `<Card>` if it hand-rolls one.

- [ ] **Step 1: Apply the recipe to each file above**

For each file: update imports, card primary forms, convert read-only displays to `ReadonlyField`, route controls through `Field`+primitive, replace raw `<button>` with `<Button>`, wrap submit areas in `FormActions`. Keep all `name`/`action`/`defaultValue`/onClick wiring identical. (File input example for `hipaa-panel.tsx`:)

```tsx
<Field label="HIPAA certificate (PDF)">
  <input
    type="file"
    name="file"
    accept="application/pdf"
    className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong"
  />
</Field>
```

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff src/modules/my-info/`
Confirm: no `name`/`action`/`defaultValue`/onClick changes.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Visual check**

Open `/my-info`. Confirm Epic Access, HIPAA, and certificate viewer render and submit as before, in light and dark.

- [ ] **Step 5: Commit**

```bash
git add src/modules/my-info/
git commit -m "refactor(my-info): migrate epic, hipaa, certificate, memberships forms to canonical pattern"
```

---

## Task 6: Migrate admin module components

**Files (apply the Migration Recipe):**
- `src/modules/admin/components/person-form.tsx` — already primitive-heavy; card it, convert any read-only rows to `ReadonlyField`, footer to `FormActions`.
- `src/modules/admin/components/department-form.tsx`
- `src/modules/admin/components/term-form.tsx`
- `src/modules/admin/components/subcommittee-form.tsx`
- `src/modules/admin/components/assignment-form.tsx` — note: the embedded search box is an inline utility; keep it inline (not carded) but route its input through `Input`/`Field`.
- `src/modules/admin/components/delegation-editor.tsx`
- `src/modules/admin/components/clinic-dates-editor.tsx`
- `src/modules/admin/components/roles-panel.tsx`
- `src/modules/admin/components/roster-panel.tsx`
- `src/modules/admin/components/person-memberships-panel.tsx`
- `src/modules/admin/components/epic-request-form.tsx` — has hand-rolled checkbox(es): convert to `<Checkbox>`.
- `src/modules/admin/components/ticket-number-field.tsx` — raw `<input>` + raw `<button>`s: route input through `Input` (or keep compact but use the `rounded-lg` token), buttons to `<Button size="sm">`.

- [ ] **Step 1: Apply the recipe to each file**

Update imports, card primary forms, convert read-only rows, route controls through `Field`+primitive, hand-rolled checkboxes to `<Checkbox>`, raw buttons to `<Button>`, footers to `FormActions`. Keep wiring identical.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff src/modules/admin/components/`
Confirm: no `name`/`action`/`defaultValue`/onClick changes.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Visual check**

Open an admin person page and the terms/departments admin screens; confirm forms render and submit, light and dark.

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin/components/
git commit -m "refactor(admin): migrate admin component forms to canonical pattern"
```

---

## Task 7: Migrate admin pages

**Files (apply the Migration Recipe):**
- `src/app/(app)/admin/settings/page.tsx` — each setting is already in a `Card`; replace ad-hoc `text-sm font-medium` labels with `Field`, route raw controls through `Input`/`Select`/`Textarea`, replace direct `buttonClasses(...)` on raw `<button>` with `<Button>`. Submit areas to `FormActions`.
- `src/app/(app)/admin/settings/branding-image-field.tsx` — raw input + button: `Field`+`Input` (file input pattern from Task 5), `<Button>`.
- `src/app/(app)/admin/people/[id]/page.tsx`
- `src/app/(app)/admin/people/page.tsx` (search/filter form: keep inline, primitive controls only)
- `src/app/(app)/admin/terms/[id]/page.tsx`
- `src/app/(app)/admin/notifications/page.tsx` — raw controls to primitives.
- `src/app/(app)/admin/audit/page.tsx` (filter form: inline, primitives)
- `src/app/(app)/admin/email/page.tsx`
- `src/app/(app)/admin/email/campaigns/new/page.tsx`
- `src/app/(app)/admin/email/campaigns/[id]/page.tsx`
- `src/app/(app)/admin/email/campaigns/[id]/audience-builder.tsx` — hand-rolled checkbox/radio + raw controls: convert to `Checkbox`/`Radio`/`Input`.
- `src/app/(app)/admin/email/templates/[key]/page.tsx`
- `src/app/(app)/admin/email/templates/[key]/preview.tsx` — raw control(s) to primitives.

- [ ] **Step 1: Apply the recipe to each file**

Card primary edit/create forms; keep search/filter/preview forms inline with primitive controls; convert hand-rolled checkboxes/radios; standardize labels and footers. Keep wiring identical.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff "src/app/(app)/admin/"`
Confirm: no `name`/`action`/`defaultValue`/onClick changes.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Visual check**

Open `/admin/settings`, `/admin/email`, and a campaign editor; confirm render and submit, light and dark.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/admin/"
git commit -m "refactor(admin): migrate admin page forms to canonical pattern"
```

---

## Task 8: Migrate recruitment forms

**Files (apply the Migration Recipe):**
- `src/app/(app)/recruitment/cycles/[id]/page.tsx`
- `src/app/(app)/recruitment/cycles/new/page.tsx`
- `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx`
- `src/app/(app)/recruitment/cycles/[id]/builder/section-card.tsx`
- `src/app/(app)/recruitment/cycles/[id]/builder/options-editor.tsx` — hand-rolled checkbox/radio + raw inputs: convert to `Checkbox`/`Radio`/`Input`.
- `src/app/(app)/recruitment/cycles/[id]/builder/quiz/quiz-builder.tsx`
- `src/app/(app)/recruitment/cycles/[id]/onboarding/page.tsx`
- `src/app/(app)/recruitment/cycles/[id]/training/page.tsx`
- `src/app/(app)/recruitment/cycles/[id]/subcommittees/page.tsx`
- `src/app/(app)/recruitment/cycles/[id]/decisions/page.tsx`
- `src/app/(app)/recruitment/cycles/[id]/emails/[key]/page.tsx`
- `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`
- `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx`
- `src/app/(app)/recruitment/interviews/[interviewId]/add-panelist-form.tsx`

Note: the recruitment builder uses hand-rolled `rounded-xl` card-like wrappers; for this phase only card the actual forms and route controls; leave non-form surface divs for Phase 2.

- [ ] **Step 1: Apply the recipe to each file**

Card primary forms; convert hand-rolled checkboxes/radios in `options-editor.tsx`; route raw controls through primitives; standardize labels/footers. Keep wiring identical.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff "src/app/(app)/recruitment/"`
Confirm: no `name`/`action`/`defaultValue`/onClick changes.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Visual check**

Open a recruitment cycle, the form builder, and an applicant detail; confirm render and submit, light and dark.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/recruitment/"
git commit -m "refactor(recruitment): migrate cycle, builder, and interview forms to canonical pattern"
```

---

## Task 9: Migrate learning forms

**Files (apply the Migration Recipe):**
- `src/app/(app)/learning/manage/page.tsx`
- `src/app/(app)/learning/manage/[courseId]/page.tsx`
- `src/app/(app)/learning/manage/[courseId]/UploadPackageForm.tsx` — hand-rolled checkbox (the resetProgress replace checkbox) + file input + raw controls: convert checkbox to `<Checkbox>`, file input via the Task 5 file pattern, card the form, footer to `FormActions`. Preserve the `resetProgress` checkbox `name` and its "shown only on replace" conditional.
- `src/app/(app)/learning/dashboard/page.tsx`

- [ ] **Step 1: Apply the recipe to each file**

Card the upload/manage forms; convert the hand-rolled checkbox; route controls through primitives. Keep wiring identical (especially `UploadPackageForm` `name`s and the replace-only checkbox visibility).

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff "src/app/(app)/learning/"`
Confirm: no `name`/`action`/`defaultValue` changes; `resetProgress` checkbox still only renders on replace.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Visual check**

Open `/learning/manage` and a course manage page; confirm the upload form (including the replace checkbox) renders and submits, light and dark.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/learning/"
git commit -m "refactor(learning): migrate manage and upload forms to canonical pattern"
```

---

## Task 10: Migrate schedule forms

**Files (apply the Migration Recipe, forms only):**
- `src/modules/schedule/components/attending-form.tsx` — hand-rolled checkbox + raw controls: convert to `Checkbox`/primitives, card if it is a primary form.
- `src/modules/schedule/components/capacity-panel.tsx`
- `src/modules/schedule/components/pending-requests.tsx`
- `src/modules/schedule/components/readiness-panel.tsx`
- `src/app/(app)/schedule/page.tsx` — hand-rolled checkbox + raw controls in the page-level forms only. The shift cards and hero are surfaces (Phase 2); do not card them here.
- `src/app/(app)/schedule/builder/page.tsx` — form parts only (filters/inputs). `builder-cell.tsx` raw buttons are Phase 4; do not touch them here.

- [ ] **Step 1: Apply the recipe to the form parts only**

Convert hand-rolled checkboxes to `<Checkbox>`, route raw form inputs through `Field`+primitive. Leave the schedule grid cells, hero, and `builder-cell` interactive buttons for later phases. Keep wiring identical.

- [ ] **Step 2: Verify scope and behavior**

Run: `git diff src/modules/schedule/ "src/app/(app)/schedule/"`
Confirm: only form controls changed; no `builder-cell.tsx` button changes; no `name`/`action`/onClick changes.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Visual check**

Open `/schedule` and `/schedule/builder`; confirm form controls render and submit, light and dark; grid interactions unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/modules/schedule/ "src/app/(app)/schedule/"
git commit -m "refactor(schedule): migrate schedule form controls to canonical primitives"
```

---

## Task 11: Migrate volunteers forms

**Files (apply the Migration Recipe):**
- `src/app/(app)/volunteers/page.tsx` (filter/search: inline, primitives)
- `src/app/(app)/volunteers/master/page.tsx`
- `src/app/(app)/volunteers/disciplinary/page.tsx`
- `src/app/(app)/volunteers/offboarding/page.tsx`
- `src/app/(app)/volunteers/spanish-review/page.tsx`
- `src/app/(app)/volunteers/epic/page.tsx`
- `src/app/(app)/volunteers/epic/select-all-checkbox.tsx` — hand-rolled checkbox: convert to `<Checkbox>`, preserve its select-all onClick/indeterminate behavior.

- [ ] **Step 1: Apply the recipe to each file**

Card primary action forms; keep list filters inline with primitives; convert the select-all checkbox to `<Checkbox>` (preserve `indeterminate`/onChange wiring). Keep wiring identical.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff "src/app/(app)/volunteers/"`
Confirm: no `name`/`action`/onClick changes; select-all still toggles correctly.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Visual check**

Open the volunteers master, epic, and spanish-review pages; confirm forms and the select-all checkbox render and work, light and dark.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/volunteers/"
git commit -m "refactor(volunteers): migrate volunteer forms to canonical pattern"
```

---

## Task 12: Migrate public and auth forms

These are the highest-divergence forms. Card the primary public forms; keep the login dev box inline but on primitives.

**Files:**
- `src/app/apply/[slug]/apply-form.tsx` — replace the custom `FieldPreview` component and hand-rolled radios with `Field`+`Input`/`Textarea`/`Select` and `RadioGroup`/`Radio`; card the form; footer to `FormActions`. Preserve every field `name` and the dynamic field rendering keyed by the form schema.
- `src/app/apply/sign-in-form.tsx` — replace hand-rolled label + raw input with `Field`+`Input`; submit via `<SubmitButton>`. This is a small form; card it for a finished look (it is a primary action, not a filter).
- `src/app/apply/page.tsx`
- `src/app/onboard/[token]/onboard-form.tsx` — replace the custom `field()` helper and hand-rolled checkboxes with `Field`+`Input` and `<Checkbox>`; group with `FormSection`; card the form. Preserve field `name`s and the contract-capture wiring.
- `src/app/login/page.tsx` — the dev-mode box: route its raw `<input>`/`<button>` through `Input`/`Button` and use `Field` labels; keep it inline (not carded), preserve the dev login action.
- `src/app/get-started/page.tsx`
- `src/app/welcome/page.tsx`

- [ ] **Step 1: Apply the recipe to each file**

Convert custom helpers (`FieldPreview`, `field()`) to `Field`+primitive; hand-rolled radios to `RadioGroup`/`Radio`; hand-rolled checkboxes to `<Checkbox>`; card primary forms; standardize labels/footers. For `apply-form.tsx`, keep the schema-driven dynamic field loop intact, only swapping the per-field rendering to primitives. Keep all `name`s and actions identical.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff src/app/apply/ src/app/onboard/ src/app/login/ src/app/get-started/ src/app/welcome/`
Confirm: every field `name`, action, and dynamic-field key is unchanged.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the public application Playwright spec**

Run the recruitment portal e2e that exercises `apply-form` (uses the forged `applicant_session` cookie, see `e2e/portal-cookie.ts`). Confirm the application still submits end to end.

- [ ] **Step 5: Visual check**

Open `/apply/<a real cycle slug>`, the onboarding link form, and `/login`; confirm render and submit, light and dark.

- [ ] **Step 6: Commit**

```bash
git add src/app/apply/ src/app/onboard/ src/app/login/ src/app/get-started/ src/app/welcome/
git commit -m "refactor(public): migrate apply, onboard, sign-in, and login forms to canonical pattern"
```

---

## Task 13: Final sweep and full verification

**Files:** none expected to change unless the grep finds stragglers.

- [ ] **Step 1: Confirm no hand-rolled controls remain (outside primitives/infra)**

Run:
```bash
grep -rnE 'type="(checkbox|radio)"' src/ --include="*.tsx" | grep -vE 'platform/ui/(checkbox|radio)\.tsx'
grep -rnE '<(input|select|textarea)\b' src/ --include="*.tsx" | grep -vE 'platform/ui/(input|select|checkbox|combobox)\.tsx'
```
Expected: only legitimate cases remain (native `<input type="file">` wrapped in `Field`, and any inline utility inputs that intentionally stay native). Investigate anything unexpected and migrate it.

- [ ] **Step 2: Confirm read-only "fake input" boxes are gone**

Run: `grep -rnE 'rounded-xl border.*bg-muted' src/ --include="*.tsx"`
Expected: no form read-only rows left (these are now `ReadonlyField`). Any remaining hits should be non-form surfaces (left for Phase 2); note them.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Run the unit test suite for primitives**

Run: `npx vitest run src/platform/ui/`
Expected: all `platform/ui` tests pass, including the new `input`, `radio`, and `form` tests.

- [ ] **Step 7: Final visual pass (light + dark)**

Walk My Info, an admin person page, `/admin/settings`, a recruitment cycle + apply form, `/learning/manage`, `/schedule`, a volunteers page, and `/login`. Confirm one cohesive carded form look, no read-only/editable shape mismatches, and correct dark-mode contrast.

- [ ] **Step 8: Commit any stragglers**

```bash
git add -A
git commit -m "refactor(ui): final forms-cohesion sweep and verification"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Canonical pattern (carded forms, ReadonlyField, Field labels, grid, FormActions footer, Alert at top): Tasks 1, 3, 4, applied in 5 to 12. ✓
- New primitives (ReadonlyField, Radio/RadioGroup, FormSection, FormActions): Tasks 1, 2, 3. ✓
- Carding rule (primary carded, inline utilities not): stated in the Recipe and applied per task (search/filter/preview kept inline). ✓
- Full migration inventory groups A/B/C: Tasks 5 to 12 enumerate every file from the spec's inventory; Task 13 greps for stragglers. ✓
- Infra `<form>` files excluded: stated in File Structure and not listed in any migration task. ✓
- A11y + dark mode: ReadonlyField non-tab-stop (Task 1), Radio role/inputs (Task 2), semantic tokens (Global Constraints), dark-mode visual checks in every migration task. ✓
- Testing/verification gate (typecheck, lint, build, vitest, apply-form e2e, visual): Tasks 1 to 3 (unit), per-task typecheck + visual, Task 12 (e2e), Task 13 (lint/build/full sweep). ✓
- Presentational-only constraint: enforced by the "verify no behavior changed" step in every migration task. ✓

**Placeholder scan:** Primitive tasks (1 to 3) and the reference task (4) contain complete code. Migration tasks (5 to 12) intentionally use the shared Recipe plus exact per-file change notes rather than verbatim rewrites of ~60 files; each names exact files and exact transformations, so there is no "implement later" ambiguity. No "TBD"/"add error handling"/"write tests for the above" placeholders.

**Type consistency:** `ReadonlyField({label,value,hint})`, `Radio({label,...input})`, `RadioGroup({legend,children,className})`, `FormSection({title,description,children})`, `FormActions({children,align,className})` are used consistently in Task 4 and the recipe. Import paths (`@/platform/ui/input`, `/radio`, `/form`, `/card`, `/button`) match the created files.
