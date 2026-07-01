# UI Cohesion Phase 3 (Page Chrome) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One canonical `PageHeader` for app page titles and a new two-level `SectionHeader` primitive for section headings, replacing hand-rolled `<h1>`s and four duplicated local helpers; plus fix issue #112 (next-shift hero `text-brand-light` going dark-on-dark in dark mode).

**Architecture:** Add `SectionHeader` (`eyebrow`/`title` levels) to `src/platform/ui/`, migrate the eyebrow + subsection-title headings and the 4 local helpers onto it, migrate the divergent app-page `<h1>`s onto the existing `<PageHeader>`, and swap the next-shift hero's `text-brand-light` to non-flipping `text-white/70`. All changes are presentational: heading text, element nesting, handlers, and surrounding markup are preserved.

**Tech Stack:** Next.js (App Router), React Server + Client Components, Tailwind CSS with semantic tokens, Vitest (`environment: node`, pure-function component tests).

## Global Constraints

- **No em-dashes** in any code comment, copy, or commit message. Use commas, colons, parentheses, periods. (User preference.)
- **Product name** is "HAVEN Hub" (two words) in prose/UI; identifiers stay `havenhub`.
- **Presentational only:** preserve heading text, element nesting, handlers, `key`s, and surrounding markup. Only the heading style/component changes.
- **Semantic tokens only:** `text-muted-foreground`, `text-foreground`, `text-white/70`, etc. No hardcoded hex or slate-N.
- **SectionHeader levels:** `eyebrow` = `text-sm font-semibold uppercase tracking-wider text-muted-foreground`; `title` = `text-base font-semibold text-foreground`. Renders `<h2>`. No baked margin (callers pass `mb-*` via `className`).
- **PageHeader is adopted unmodified:** `h1 text-2xl font-bold tracking-tight` + description + `action` slot.
- **Leave hand-rolled (out of scope):** the 5 brand-colored eyebrows (`text-brand-fg` / on-brand surfaces); the home greeting hero and next-shift hero (heroes); the centered `no-access` page; auth/public pages (login, welcome, apply portal shell, onboard, get-started) for PageHeader. A `className` text-COLOR override on `SectionHeader` is Tailwind same-property ordering-unreliable, so never override the eyebrow color via className: leave color-variant eyebrows hand-rolled.
- **Tests** run in `environment: node`; component tests call the component as a function and assert on `el.props` (see `spinner.test.ts`). Test files are `*.test.ts`.
- **Run a single test file:** `npx vitest run src/platform/ui/section-header.test.ts`.
- **Stale Prisma client caveat:** this branch sits on the merged-main state, so `tsc` reports ~25 pre-existing stale-client errors (`ApplicantType`/`EmailSenderScope`/`EmailSenderRule`/`fromEmail`/`transferFromDepartments`). A task is clean if it adds NO NEW `tsc` errors referencing the files it changed. Do NOT `prisma generate`; CI regenerates.

---

## File Structure

**New primitive:**
- `src/platform/ui/section-header.tsx` + `src/platform/ui/section-header.test.ts`.

**Migrated files:** grouped by area in Tasks 2 to 7. `PageHeader` (`page-header.tsx`) is adopted unmodified.

---

## The SectionHeader Migration Recipe (referenced by Tasks 4 to 7)

1. **Local helper component** (`SectionHead` in training; `SectionHeading` in assignment-form / roles-panel / roster-panel): delete the local function definition, import `SectionHeader` from `@/platform/ui/section-header`, and replace each `<SectionHead>X</SectionHead>` / `<SectionHeading>X</SectionHeading>` with `<SectionHeader>X</SectionHeader>`. If the local helper baked a margin (e.g. `mb-2`), pass it via `className`.
2. **Inline eyebrow** (`text-{xs,sm} font-{semibold,bold,medium} uppercase tracking-wider text-muted-foreground`, any element): replace with `<SectionHeader className="<the mb-* it had, if any>">text</SectionHeader>`. Drop the typography tokens (the component supplies them); keep only layout/margin classes.
3. **Inline subsection title** (`text-{base,lg} font-{semibold,bold} text-foreground`, non-uppercase): replace with `<SectionHeader level="title" className="<margin>">text</SectionHeader>`.
4. **LEAVE hand-rolled:** any eyebrow whose color is not the muted default (`text-brand-fg`, on-brand white eyebrows), and headings on excluded surfaces (heroes). Never recolor via `className` on SectionHeader. If a heading is ambiguous, leave it and note it.
5. **Presentational only:** preserve the heading text and the surrounding markup exactly.

After each file: `git diff <file>` (confirm only the heading element/classes changed), then `npx tsc --noEmit` (no NEW errors referencing the file).

---

## Task 1: SectionHeader primitive

**Files:**
- Create: `src/platform/ui/section-header.tsx`
- Test: `src/platform/ui/section-header.test.ts`

**Interfaces:**
- Produces: `SectionHeader({ level?: "eyebrow" | "title"; className?: string; children: ReactNode }): ReactElement` (an `<h2>`).

- [ ] **Step 1: Write the failing test**

Create `src/platform/ui/section-header.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SectionHeader } from "./section-header";

describe("SectionHeader", () => {
  it("defaults to the uppercase muted eyebrow on an h2", () => {
    const el = SectionHeader({ children: "Profile" });
    expect(el.type).toBe("h2");
    expect(el.props.className).toContain("uppercase");
    expect(el.props.className).toContain("tracking-wider");
    expect(el.props.className).toContain("text-muted-foreground");
    expect(el.props.children).toBe("Profile");
  });

  it("renders the non-uppercase title level", () => {
    const el = SectionHeader({ level: "title", children: "Assignment" });
    expect(el.props.className).toContain("text-base");
    expect(el.props.className).toContain("font-semibold");
    expect(el.props.className).toContain("text-foreground");
    expect(el.props.className).not.toContain("uppercase");
  });

  it("merges a caller className for margin", () => {
    const el = SectionHeader({ className: "mb-4", children: "X" });
    expect(el.props.className).toContain("mb-4");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/ui/section-header.test.ts`
Expected: FAIL with "Failed to resolve import ./section-header" or "SectionHeader is not a function".

- [ ] **Step 3: Write the implementation**

Create `src/platform/ui/section-header.tsx`:

```tsx
import type { ReactNode } from "react";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

type SectionHeaderLevel = "eyebrow" | "title";

const levelClasses: Record<SectionHeaderLevel, string> = {
  // Small uppercase label above a group (the dominant section style).
  eyebrow: "text-sm font-semibold uppercase tracking-wider text-muted-foreground",
  // Larger non-uppercase subsection heading.
  title: "text-base font-semibold text-foreground",
};

/**
 * Section heading beneath a page's PageHeader. `eyebrow` is the small uppercase
 * label; `title` is the larger non-uppercase subsection heading. Renders an h2
 * and sets no outer spacing: pass margin (e.g. mb-4) via className.
 */
export function SectionHeader({
  level = "eyebrow",
  className,
  children,
}: {
  level?: SectionHeaderLevel;
  className?: string;
  children: ReactNode;
}) {
  return <h2 className={cx(levelClasses[level], className)}>{children}</h2>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/ui/section-header.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ui/section-header.tsx src/platform/ui/section-header.test.ts
git commit -m "feat(ui): add two-level SectionHeader primitive"
```

---

## Task 2: PageHeader consolidation (hand-rolled app h1s)

**Files (migrate the hand-rolled `<h1>` to `<PageHeader>`):**
- `src/app/(app)/training/page.tsx` (`text-[26px]` h1 -> `<PageHeader title="Training" />`)
- `src/app/(app)/clinic/page.tsx` and `src/app/(app)/clinic/avs/page.tsx` (if the title is a plain h1; otherwise normalize the h1 classes)
- `src/app/(app)/schedule/page.tsx`, `src/app/(app)/schedule/full/page.tsx`, `src/app/(app)/schedule/builder/page.tsx`: these pair a title/selected-date with date-nav controls. Use `<PageHeader title={...} action={<controls/>}/>` where it fits the title+action shape. Where it does not fit, keep the custom layout but normalize the `<h1>` to `className="text-2xl font-bold tracking-tight"` (drop `mb-1`).

**Excluded (do NOT touch):** `src/app/(app)/page.tsx` home greeting hero and next-shift hero; `src/app/(app)/no-access/page.tsx` (centered); all auth/public pages.

- [ ] **Step 1: Migrate each hand-rolled h1**

Import `PageHeader` from `@/platform/ui/page-header`. Replace the plain `<h1>` (+ any adjacent description `<p>`) with `<PageHeader title=... description=... action=... />`, preserving the exact title text and any controls (moved into `action`). For schedule date-nav headers that do not fit title+action, normalize the h1 classes instead. Do not change page logic.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff "src/app/(app)/training/" "src/app/(app)/schedule/" "src/app/(app)/clinic/"`
Confirm: title text and any control wiring preserved; home/no-access untouched.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors beyond the known stale-client set.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/training/" "src/app/(app)/schedule/" "src/app/(app)/clinic/"
git commit -m "refactor(ui): migrate hand-rolled app page titles to PageHeader"
```

---

## Task 3: Fix issue #112 (next-shift hero dark-mode contrast)

**Files:**
- Modify: `src/app/(app)/page.tsx` (the next-shift hero, the `bg-gradient-to-br from-brand to-brand-deep ... text-white` panel)

- [ ] **Step 1: Swap the four `text-brand-light` usages to `text-white/70`**

In the next-shift hero only, change `text-brand-light` to `text-white/70` on the four elements: the "Your next shift" eyebrow, the "days away"/"day away" caption, the Stethoscope icon, and the Repeat icon. Change nothing else. Confirm there are no remaining `text-brand-light` usages in the file afterward:

Run: `grep -n "text-brand-light" "src/app/(app)/page.tsx"`
Expected: no matches.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors beyond the known stale-client set.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/page.tsx"
git commit -m "fix(ui): next-shift hero labels use non-flipping text-white/70 (#112)"
```

---

## Task 4: SectionHeader migration: local helpers (training + admin)

**Files (apply the SectionHeader Migration Recipe):**
- `src/app/(app)/training/page.tsx` (replace the local `SectionHead` component + its usages; migrate the 6 inline eyebrows here; the home/training PageHeader was Task 2, do not redo it)
- `src/modules/admin/components/assignment-form.tsx` (replace local `SectionHeading`)
- `src/modules/admin/components/roles-panel.tsx` (replace local `SectionHeading` + its 2 inline eyebrows)
- `src/modules/admin/components/roster-panel.tsx` (replace local `SectionHeading` + its 3 inline eyebrows)

- [ ] **Step 1: Apply the recipe (delete local helpers, migrate eyebrows/titles)**

Delete each local `SectionHead`/`SectionHeading` definition, import `SectionHeader`, replace usages, and migrate inline eyebrows/titles per the recipe. Leave any brand-colored eyebrow hand-rolled.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff "src/app/(app)/training/page.tsx" src/modules/admin/components/assignment-form.tsx src/modules/admin/components/roles-panel.tsx src/modules/admin/components/roster-panel.tsx`
Confirm: heading text preserved; the local helper definitions are gone; no logic changes.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors beyond the known stale-client set.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/training/page.tsx" src/modules/admin/components/assignment-form.tsx src/modules/admin/components/roles-panel.tsx src/modules/admin/components/roster-panel.tsx
git commit -m "refactor(ui): replace duplicated section-heading helpers with SectionHeader"
```

---

## Task 5: SectionHeader migration: my-info area

**Files (apply the recipe):**
- `src/app/(app)/my-info/page.tsx` (5 eyebrows)
- `src/modules/my-info/components/hipaa-panel.tsx` (3)
- `src/modules/my-info/components/epic-panel.tsx` (2)
- `src/modules/my-info/components/clearance-card.tsx` (2)

- [ ] **Step 1: Apply the recipe to each file**

Migrate eyebrows to `<SectionHeader>` and any non-uppercase subsection titles to `level="title"`, preserving heading text and passing baked margins via `className`.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff "src/app/(app)/my-info/page.tsx" src/modules/my-info/`
Confirm: heading text preserved; only heading element/classes changed.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors beyond the known stale-client set.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/my-info/page.tsx" src/modules/my-info/
git commit -m "refactor(my-info): migrate section headings to SectionHeader"
```

---

## Task 6: SectionHeader migration: recruitment area

**Files (apply the recipe):**
- `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx` (5)
- `src/app/(app)/recruitment/cycles/[id]/page.tsx` (4)
- `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` (4)
- `src/app/(app)/recruitment/cycles/[id]/onboarding/page.tsx` (1)
- `src/app/(app)/recruitment/cycles/[id]/decisions/page.tsx` (1)
- `src/app/(app)/recruitment/cycles/[id]/builder/section-card.tsx` (1)
- `src/app/(app)/recruitment/cycles/[id]/builder/quiz/quiz-builder.tsx` (1)
- `src/app/(app)/recruitment/cycles/[id]/builder/type-picker.tsx` (1: this is inside a popover; migrate only if it is a plain muted eyebrow, else leave and note)

- [ ] **Step 1: Apply the recipe to each file**

Migrate eyebrows/titles; leave any brand-colored or popover-specific label that is not a standard muted eyebrow, and note it.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff "src/app/(app)/recruitment/"`
Confirm: heading text preserved; only heading element/classes changed.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors beyond the known stale-client set.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/recruitment/"
git commit -m "refactor(recruitment): migrate section headings to SectionHeader"
```

---

## Task 7: SectionHeader migration: admin pages, schedule, home, misc

**Files (apply the recipe):**
- `src/app/(app)/admin/terms/[id]/page.tsx` (2)
- `src/app/(app)/admin/people/[id]/page.tsx` (2)
- `src/modules/admin/components/epic-request-form.tsx` (5)
- `src/modules/admin/components/person-memberships-panel.tsx` (1)
- `src/modules/schedule/components/readiness-panel.tsx` (1)
- `src/modules/schedule/components/pending-requests.tsx` (1)
- `src/app/(app)/page.tsx` (the "Modules" heading at ~1 eyebrow: migrate ONLY if it is the muted eyebrow; the next-shift "Your next shift" brand eyebrow stays hand-rolled, already handled by Task 3)
- `src/app/apply/page.tsx` (2: portal listing eyebrows; migrate the muted ones)
- `src/app/not-found.tsx` (1)

Leave `src/app/(app)/clinic-channel-card.tsx` (its label is a brand-tinted on-card eyebrow; out of scope) unless it is a plain muted eyebrow.

- [ ] **Step 1: Apply the recipe to each file**

Migrate the muted eyebrows + non-uppercase titles; leave brand-colored eyebrows (home next-shift, clinic-channel-card) hand-rolled.

- [ ] **Step 2: Verify no behavior changed**

Run: `git diff "src/app/(app)/admin/" src/modules/admin/components/epic-request-form.tsx src/modules/admin/components/person-memberships-panel.tsx src/modules/schedule/components/readiness-panel.tsx src/modules/schedule/components/pending-requests.tsx "src/app/(app)/page.tsx" src/app/apply/page.tsx src/app/not-found.tsx`
Confirm: heading text preserved; next-shift hero (Task 3) and brand eyebrows untouched.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors beyond the known stale-client set.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/admin/" src/modules/admin/components/epic-request-form.tsx src/modules/admin/components/person-memberships-panel.tsx src/modules/schedule/components/readiness-panel.tsx src/modules/schedule/components/pending-requests.tsx "src/app/(app)/page.tsx" src/app/apply/page.tsx src/app/not-found.tsx
git commit -m "refactor(ui): migrate remaining section headings to SectionHeader"
```

---

## Task 8: Final sweep and verification

**Files:** none expected to change unless the sweep finds a straggler.

- [ ] **Step 1: Straggler grep for inline eyebrow/title headings**

Run:
```bash
grep -rnE 'uppercase tracking-wider' src/app src/modules --include="*.tsx"
grep -rn "SectionHead\b\|SectionHeading\b" src/ --include="*.tsx"
```
Triage each remaining hit. LEGITIMATE (leave): brand-colored eyebrows (`text-brand-fg` / on-brand white like the next-shift hero), the AppShell/nav chrome, any deliberately-excluded surface. ILLEGITIMATE: a plain muted eyebrow still inline, or a remaining `SectionHead`/`SectionHeading` local helper. Migrate any illegitimate straggler with the recipe. List each remaining hit with a LEGIT/ILLEGIT verdict in the report.

- [ ] **Step 2: Confirm no `text-brand-light` remains anywhere**

Run: `grep -rn "text-brand-light" src/ --include="*.tsx"`
Expected: no matches (the only usages were the #112 hero, fixed in Task 3).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: only the known stale-Prisma-client errors; none referencing files this branch changed.

- [ ] **Step 5: Build (compile)**

Run: `npm run build`
Expected: compiles. Page-data collection may fail on missing `DATABASE_URL` (known infra limitation). A real type/import/JSX error introduced here is ILLEGIT: fix it.

- [ ] **Step 6: Run the primitive test**

Run: `npx vitest run src/platform/ui/section-header.test.ts`
Expected: 3 passing.

- [ ] **Step 7: Commit any stragglers**

```bash
git add -A
git commit -m "refactor(ui): final page-chrome cohesion sweep and verification"
```
(If nothing changed, do not create an empty commit; just report.)

---

## Self-Review (completed by plan author)

**Spec coverage:**
- SectionHeader primitive (two levels, h2, no margin): Task 1. ✓
- PageHeader consolidation (training, clinic, schedule; home heroes / no-access / auth excluded): Task 2. ✓
- Issue #112 (4 `text-brand-light` -> `text-white/70` on next-shift hero): Task 3. ✓
- Replace the 4 local helpers: Task 4. ✓
- Migrate eyebrow + title families across my-info / recruitment / admin / schedule / home / apply / not-found: Tasks 5, 6, 7. ✓
- Leave 5 brand-colored eyebrows hand-rolled (no className color override): Global Constraints + recipe step 4 + Task 7 notes + Task 8 triage. ✓
- Content width / vertical rhythm: explicitly no work (spec); not a task. ✓
- Testing (section-header.test.ts) + presentational-only + stale-client caveat: Task 1, per-task diff+tsc, Task 8. ✓

**Placeholder scan:** Task 1 has complete code. Migration tasks use the shared recipe + exact per-file lists and counts; no "TBD"/"handle headings"/"similar to Task N".

**Type consistency:** `SectionHeader({ level, className, children })` used consistently in Task 1 and the recipe. Import path `@/platform/ui/section-header`. `PageHeader` from `@/platform/ui/page-header` (existing, unchanged).
