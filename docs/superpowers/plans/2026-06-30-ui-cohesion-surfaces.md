# UI Cohesion Phase 2 (Surfaces / Cards) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate hand-rolled `bg-surface` card divs onto the `Card` primitive (extended with a compact size variant), so radius, border, shadow, and hover behavior are consistent app-wide.

**Architecture:** Extract a `cardClasses({ size, pad, interactive })` helper from `Card` (mirroring `buttonClasses` + `Button`), add a `size: "default" | "compact"` variant, then migrate the ~37 top-level `rounded-2xl bg-surface` divs to `<Card>` and the recurring compact nested-panel / list-row surfaces to the compact variant. Clickable row surfaces (`Link`/`a`/`button`) use `cardClasses(...)` directly. Changes are presentational only: element type, `href`, `onClick`, `key`, children, and data attributes never change.

**Tech Stack:** Next.js (App Router), React Server + Client Components, Tailwind CSS with semantic tokens, Vitest (`environment: node`, pure-function component tests).

## Global Constraints

- **No em-dashes** in any code comment, copy, or commit message. Use commas, colons, parentheses, periods. (User preference.)
- **Product name** is "HAVEN Hub" (two words) in prose/UI; identifiers stay `havenhub`.
- **Presentational only:** never change an element's type, `href`, `onClick`, `key`, children, validation, or data attributes. Only the surface styling moves to the primitive.
- **Semantic tokens only:** `border-border`, `border-border-subtle`, `bg-surface`, etc. Never hardcode hex or slate-N.
- **Canonical surface tokens:** default card `rounded-2xl border-border bg-surface shadow-sm` + `p-5`; compact card `rounded-xl border-border bg-surface` + `p-3`, no shadow; hover-lift via `interactive`.
- **Exclusion rule:** convert ONLY `bg-surface` content surfaces. Leave hand-rolled: non-`bg-surface` (`bg-muted`/`bg-muted/30`/`glass-panel`/`bg-brand/*`), positioned overlays (dropdown/popover menus, toasts with `shadow-lg` + `fixed`/`absolute`), icon/avatar tiles (small fixed `h-/w-`), and embed (iframe) frames.
- **Tests** run in `environment: node`; component tests call the component/helper as a function and assert on the class string or `el.props` (see `spinner.test.ts`). Test files are `*.test.ts`.
- **Run a single test file:** `npx vitest run src/platform/ui/card.test.ts`.
- **Stale Prisma client caveat:** this branch sits on the merged-main state, so `tsc` reports pre-existing stale-client errors unrelated to this work (they name `ApplicantType`/`EmailSenderScope`/`EmailSenderRule`/`fromEmail`/`transferFromDepartments`). Do NOT `prisma generate` in the worktree; CI regenerates. A task is clean if `tsc` introduces NO NEW errors beyond that known set and none reference the files it touched.

---

## File Structure

**Modified primitive:**
- `src/platform/ui/card.tsx`: add `cardClasses` helper + `size` variant; `Card` wraps `cardClasses`.
- `src/platform/ui/card.test.ts` (new): tests for `cardClasses` and `Card`.

**Migrated surface files:** grouped by area in Tasks 2 to 6 (concrete lists per task). Files explicitly NOT touched (exclusion rule): `app/(app)/clinic-channel-card.tsx`, `recruitment/cycles/[id]/builder/type-picker.tsx`, `platform/auth/inactivity.tsx`, `admin/email/templates/[key]/preview.tsx` (iframe), and any `glass-panel`/`bg-muted` surface.

---

## The Migration Recipe (referenced by Tasks 2 to 6)

For each in-scope surface:

1. **Top-level card** (`rounded-2xl border border-border bg-surface shadow-sm` + padding). Replace the `<div>` with `<Card>`. Remove the `rounded-2xl border border-border bg-surface shadow-sm p-5` tokens (Card provides them); keep all other classes (layout, gap, margins, width) in `className`. If padding was non-default (`p-6`, `p-[18px]`, `px-[22px]`, `px-5 py-4`, `p-8`, `px-6 py-16`), pass `pad={false}` and put that padding in `className`. If it had the hover-lift (`hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md`), use `interactive` and drop those tokens.
2. **Compact nested panel** (`rounded-xl border border-border bg-surface p-3`). Replace `<div>` with `<Card size="compact">`, keeping other classes. If the border was `border-border-subtle`, keep it via `className="border-border-subtle"` (it overrides the default border color).
3. **Compact list row that is a `<Link>`/`<a>`/`<button>`** (`rounded-xl border border-border bg-surface px-4 py-3 hover:bg-muted ...`). Keep the element. Set `className={cardClasses({ size: "compact", pad: false })}` and append the row's own classes (`px-4 py-3`, `flex items-center justify-between`, `hover:bg-muted`, `text-sm`, etc.). Import `cardClasses` from `@/platform/ui/card`. Preserve `href`/`onClick`/`key`.
4. **bg-surface empty-state container** (`rounded-2xl border bg-surface` + big padding like `p-8`/`p-10`/`px-6 py-16`). Use `<Card pad={false} className="<the big padding> <other classes>">`.
5. **Exclusion:** if the surface is not `bg-surface`, is a positioned overlay/menu/toast, an icon tile, or an iframe frame, LEAVE IT. If genuinely unsure, leave it and note it in the report.

After each file: `git diff <file>` to confirm only styling changed (element type, href, onClick, key, children intact), then `npx tsc --noEmit` (no NEW errors beyond the known stale-client set).

---

## Task 1: Extend the Card primitive (`cardClasses` + compact size)

**Files:**
- Modify: `src/platform/ui/card.tsx`
- Test: `src/platform/ui/card.test.ts` (new)

**Interfaces:**
- Produces:
  - `cardClasses({ size?: "default" | "compact"; pad?: boolean; interactive?: boolean }): string` (all optional; default `{size:"default", pad:true, interactive:false}`).
  - `Card(props: ComponentProps<"div"> & { size?: "default" | "compact"; interactive?: boolean; pad?: boolean }): ReactElement`.

- [ ] **Step 1: Write the failing test**

Create `src/platform/ui/card.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Card, cardClasses } from "./card";

describe("cardClasses", () => {
  it("defaults to the rounded-2xl content card with shadow and p-5", () => {
    const c = cardClasses();
    expect(c).toContain("rounded-2xl");
    expect(c).toContain("shadow-sm");
    expect(c).toContain("border-border");
    expect(c).toContain("bg-surface");
    expect(c).toContain("p-5");
  });

  it("compact is rounded-xl with p-3 and no base shadow", () => {
    const c = cardClasses({ size: "compact" });
    expect(c).toContain("rounded-xl");
    expect(c).toContain("p-3");
    expect(c).not.toContain("shadow-sm");
    expect(c).not.toContain("rounded-2xl");
  });

  it("omits the inset when pad is false", () => {
    expect(cardClasses({ pad: false })).not.toContain("p-5");
    expect(cardClasses({ size: "compact", pad: false })).not.toContain("p-3");
  });

  it("adds the hover-lift when interactive", () => {
    expect(cardClasses({ interactive: true })).toContain("hover:-translate-y-0.5");
  });
});

describe("Card", () => {
  it("renders a div with the default card classes", () => {
    const el = Card({});
    expect(el.type).toBe("div");
    expect(el.props.className).toContain("rounded-2xl");
  });

  it("applies the compact size and merges a caller className", () => {
    const el = Card({ size: "compact", className: "px-4 py-3" });
    expect(el.props.className).toContain("rounded-xl");
    expect(el.props.className).toContain("px-4 py-3");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/ui/card.test.ts`
Expected: FAIL with "cardClasses is not a function" (cardClasses not exported yet).

- [ ] **Step 3: Rewrite `card.tsx`**

Replace the contents of `src/platform/ui/card.tsx` with:

```tsx
import type { ComponentProps } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

type CardSize = "default" | "compact";

const interactiveClasses =
  "transition-[transform,box-shadow,border-color] duration-150 " +
  "hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md";

/**
 * Canonical surface classes. `default` is the 16px-radius, soft-shadow content
 * card; `compact` is a 12px-radius, shadowless surface for dense list rows and
 * nested sub-panels. Use this directly on a Link/button/a when the surface must
 * be a clickable element; use the Card component for the common div case.
 */
export function cardClasses({
  size = "default",
  pad = true,
  interactive = false,
}: { size?: CardSize; pad?: boolean; interactive?: boolean } = {}): string {
  return cx(
    "border border-border bg-surface",
    size === "compact" ? "rounded-xl" : "rounded-2xl shadow-sm",
    pad && (size === "compact" ? "p-3" : "p-5"),
    interactive && interactiveClasses,
  );
}

type CardProps = ComponentProps<"div"> & {
  /** Surface size. Default is the 16px content card; compact is a 12px dense surface. */
  size?: CardSize;
  /** Adds the hover-lift used on clickable tiles (translateY + stronger shadow/border). */
  interactive?: boolean;
  /** Toggles the default inset (p-5 default, p-3 compact). Set false to manage padding via className. */
  pad?: boolean;
};

/**
 * The atomic surface container. Prefer it (or cardClasses) over hand-rolling
 * rounded-2xl border bg-surface so the radius/shadow/border stay consistent app-wide.
 */
export function Card({ size = "default", interactive = false, pad = true, className, ...rest }: CardProps) {
  return (
    <div {...rest} className={cx(cardClasses({ size, pad, interactive }), className)} />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/ui/card.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck (existing Card callers unaffected)**

Run: `npx tsc --noEmit`
Expected: no NEW errors beyond the known stale-Prisma-client set. Existing `<Card>` usages compile unchanged (default props produce the identical class string).

- [ ] **Step 6: Commit**

```bash
git add src/platform/ui/card.tsx src/platform/ui/card.test.ts
git commit -m "feat(ui): add cardClasses helper and compact Card size variant"
```

---

## Task 2: Migrate the training area

**Files (apply the Migration Recipe):**
- `src/app/(app)/training/page.tsx` (9 top-level cards)
- `src/app/(app)/training/training-quiz.tsx` (3 cards; note this file also has the quiz container and a fail banner, both `bg-surface`)

- [ ] **Step 1: Apply the recipe to each card in both files**

Replace each `rounded-2xl border border-border bg-surface ...` div with `<Card>` (import `Card` from `@/platform/ui/card`), moving non-surface classes into `className`, using `pad={false}` + className for any non-`p-5` padding, and `interactive` for hover-lift tiles. Leave any `bg-muted`/`glass` surfaces alone.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff "src/app/(app)/training/"`
Confirm: no element type / href / onClick / key / children changes; only surface styling.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors beyond the known stale-client set; none referencing training files.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/training/"
git commit -m "refactor(training): migrate surfaces to the Card primitive"
```

---

## Task 3: Migrate the schedule area

**Files (apply the Migration Recipe):**
- `src/app/(app)/schedule/builder/page.tsx` (3 cards + the `rounded-xl ... px-4 py-3` status banner at ~line 630: that is a `bg-surface` inline status box, use `<Card size="compact" pad={false} className="... px-4 py-3 ...">`)
- `src/app/(app)/schedule/page.tsx` (1 card)
- `src/app/(app)/schedule/attendings/page.tsx` (1 card)
- `src/modules/schedule/components/pending-requests.tsx` (2 cards)
- `src/modules/schedule/components/readiness-panel.tsx` (1 card)
- `src/modules/schedule/components/capacity-panel.tsx` (1 card)

Do NOT touch `builder-cell.tsx` (Phase 4) or the schedule grid cells / hero (not `bg-surface` content cards; leave as-is unless they are plain `bg-surface` cards).

- [ ] **Step 1: Apply the recipe to each card**

As Task 2. Keep the schedule grid/hero and any `bg-muted` surfaces untouched.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff src/modules/schedule/ "src/app/(app)/schedule/"`
Confirm: only surface styling changed; no builder-cell changes.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors beyond the known stale-client set.

- [ ] **Step 4: Commit**

```bash
git add src/modules/schedule/ "src/app/(app)/schedule/"
git commit -m "refactor(schedule): migrate surfaces to the Card primitive"
```

---

## Task 4: Migrate home, welcome, and my-info surfaces

**Files (apply the Migration Recipe):**
- `src/app/(app)/page.tsx` (3 top-level cards + the compact hover-lift tile at ~line 377: `rounded-xl ... p-3.5 hover:-translate-y-0.5 ...` is a clickable tile. If it is a `<Link>`/`<a>`, use `className={cardClasses({ size: "compact", interactive: true, pad: false })}` + `p-3.5` and its layout classes; if a `<div>`, use `<Card size="compact" interactive pad={false} className="p-3.5 ...">`.)
- `src/app/welcome/page.tsx` (1 card)
- `src/modules/my-info/components/clearance-card.tsx` (1 card)

- [ ] **Step 1: Apply the recipe to each card**

Note the home tile uses the hover-lift (`hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md`), so map it to `interactive` and drop those tokens.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff "src/app/(app)/page.tsx" src/app/welcome/ src/modules/my-info/components/clearance-card.tsx`
Confirm: only surface styling changed; tile `href`/`onClick` intact.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors beyond the known stale-client set.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/page.tsx" src/app/welcome/ src/modules/my-info/components/clearance-card.tsx
git commit -m "refactor(home,welcome,my-info): migrate surfaces to the Card primitive"
```

---

## Task 5: Migrate the admin area

**Files (apply the Migration Recipe):**
- `src/app/(app)/admin/email/page.tsx` (2 cards)
- `src/app/(app)/admin/email/templates/page.tsx` (1 card)
- `src/app/(app)/admin/email/templates/[key]/page.tsx` (1 card). Do NOT touch the iframe wrapper in `templates/[key]/preview.tsx` (embed frame, excluded).
- `src/app/(app)/admin/email/campaigns/page.tsx` (1 card)
- `src/app/(app)/admin/email/campaigns/[id]/page.tsx` (1 card)
- `src/app/(app)/admin/itcm/page.tsx` (1 card; note the `rounded-xl ... px-5 py-4` block at ~line 53 is a `bg-surface` info strip, use `<Card size="compact" pad={false} className="... px-5 py-4 ...">`)
- `src/modules/admin/components/roster-panel.tsx` (1 card)

- [ ] **Step 1: Apply the recipe to each card**

As Task 2.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff "src/app/(app)/admin/" src/modules/admin/components/roster-panel.tsx`
Confirm: only surface styling; no iframe wrapper change.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors beyond the known stale-client set.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/admin/" src/modules/admin/components/roster-panel.tsx
git commit -m "refactor(admin): migrate surfaces to the Card primitive"
```

---

## Task 6: Migrate recruitment and apply surfaces (incl. compact panels and rows)

**Files (apply the Migration Recipe):**
- `src/app/(app)/recruitment/cycles/[id]/decisions/page.tsx` (1 top-level card)
- `src/app/(app)/recruitment/cycles/[id]/builder/form-builder.tsx` (1 top-level card)
- `src/app/(app)/recruitment/cycles/[id]/builder/quiz/quiz-builder.tsx` (1 top-level `rounded-2xl` card + 1 compact `rounded-xl p-3` nested panel at ~line 61: use `<Card size="compact">`)
- `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx` (compact `rounded-xl p-3 shadow-sm` panel at ~line 55: use `<Card size="compact">`; it has the dnd drag handle button inside, leave that untouched)
- `src/app/(app)/recruitment/cycles/[id]/builder/section-card.tsx` (compact sub-grid `rounded-xl border-border-subtle bg-surface p-3` at ~line 81: use `<Card size="compact" className="border-border-subtle ...">`; do NOT convert the outer `bg-muted/30` section wrapper, excluded)
- `src/app/(app)/recruitment/cycles/[id]/emails/page.tsx` (compact list rows `rounded-xl ... px-4 py-3`: these are `<li>` items; use `<Card size="compact" pad={false} className="... px-4 py-3 ...">` if a plain element, or `cardClasses({ size: "compact", pad: false })` if a Link/a)
- `src/app/apply/page.tsx` (compact list rows at ~lines 63, 68, 85: rows 63 and 85 are `<Link ... hover:bg-muted>`, row 68 is a `<div>`. For the Links use `className={cardClasses({ size: "compact", pad: false })}` + `flex items-center justify-between px-4 py-3 hover:bg-muted text-sm` and preserve `href`; for the div use `<Card size="compact" pad={false} className="flex items-center justify-between px-4 py-3">`)

- [ ] **Step 1: Apply the recipe to each surface**

Use `<Card>` / `<Card size="compact">` for div surfaces and `cardClasses(...)` for the clickable `<Link>` rows. Preserve every `href`, `key`, `onClick`, and the dnd drag handle in field-card. Leave the `bg-muted/30` section wrapper and the `type-picker` popover untouched.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff "src/app/(app)/recruitment/" src/app/apply/page.tsx`
Confirm: element types preserved (Links stay Links), href/key/onClick intact, dnd handle untouched, bg-muted/30 wrapper untouched.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors beyond the known stale-client set.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/recruitment/" src/app/apply/page.tsx
git commit -m "refactor(recruitment,apply): migrate surfaces and compact panels to the Card primitive"
```

---

## Task 7: Final sweep and verification

**Files:** none expected to change unless the sweep finds a straggler.

- [ ] **Step 1: Straggler grep for hand-rolled card surfaces**

Run:
```bash
grep -rnE 'rounded-2xl[^"]*border[^"]*bg-surface|bg-surface[^"]*border[^"]*rounded-2xl' src/ --include="*.tsx" | grep -v 'platform/ui/'
grep -rnE 'rounded-xl[^"]*border[^"]*bg-surface|bg-surface[^"]*border[^"]*rounded-xl' src/ --include="*.tsx" | grep -v 'platform/ui/'
```
Triage every remaining hit. LEGITIMATE (leave): excluded surfaces per the rule (icon tile `clinic-channel-card`, popover `type-picker`, toast `inactivity`, iframe `preview`), and any surface a task deliberately left. ILLEGITIMATE: a `bg-surface` content card still hand-rolled. Migrate any illegitimate straggler with the recipe. List each remaining hit with a LEGIT/ILLEGIT verdict in the report.

- [ ] **Step 2: Confirm excluded surfaces are intact**

Run: `grep -nE 'rounded-xl|rounded-2xl' src/app/(app)/clinic-channel-card.tsx "src/app/(app)/recruitment/cycles/[id]/builder/type-picker.tsx" src/platform/auth/inactivity.tsx`
Confirm these were left hand-rolled (excluded by the rule).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: only the known stale-Prisma-client errors; none referencing files this branch changed.

- [ ] **Step 5: Build (compile)**

Run: `npm run build`
Expected: compiles. Page-data collection may fail on missing `DATABASE_URL` (infra limitation, not a code failure); a real type/import/JSX error introduced by the migration is ILLEGIT and must be fixed.

- [ ] **Step 6: Run the primitive test**

Run: `npx vitest run src/platform/ui/card.test.ts`
Expected: 6 passing.

- [ ] **Step 7: Commit any stragglers**

```bash
git add -A
git commit -m "refactor(ui): final surfaces-cohesion sweep and verification"
```
(If nothing changed, do not create an empty commit; just report.)

---

## Self-Review (completed by plan author)

**Spec coverage:**
- `cardClasses` helper + `size` variant + Card wrapper: Task 1. ✓
- Migrate ~37 top-level cards: Tasks 2 to 6 (training 12, schedule ~9, home/welcome/my-info 5, admin ~8, recruitment ~3 + compact). ✓
- Compact nested panels (field-card, quiz-builder, section-card): Task 6. ✓
- Compact list rows (apply/page, recruitment emails): Task 6. ✓ Clickable rows via `cardClasses` on the element. ✓
- bg-surface empty states: covered by recipe step 4 (pad={false} + padding className), applied where found. ✓
- Exclusion rule (bg-muted/glass/tinted, overlays, icon tiles, iframes): Global Constraints + recipe step 5 + Task 7 step 2 confirmation. ✓
- border-border-subtle preserved: recipe step 2 + Task 6 section-card note. ✓
- Testing (card.test.ts) + presentational-only + stale-client caveat: Task 1, per-task diff+tsc, Task 7. ✓

**Placeholder scan:** Task 1 has complete code. Migration tasks (2 to 6) use the shared recipe plus exact per-file lists and the specific compact/exclusion notes per file; no "TBD"/"handle edge cases"/"similar to Task N".

**Type consistency:** `cardClasses({ size, pad, interactive })` and `Card({ size, interactive, pad, ...div })` are used consistently across Task 1 and the recipe. Import path `@/platform/ui/card` matches.
