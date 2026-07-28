# Navigation IA Stages 3 and 4 (Cycle Workspace + TabRow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a recruitment cycle a persistent workspace nav instead of a wall of identical buttons, and collapse the app's three competing tab idioms onto one primitive.

**Architecture:** Stage 4's `TabRow` primitive is built FIRST so Stage 3's cycle nav consumes it rather than inventing a one-off that later needs refactoring. `ModuleNav` and `/support/epic` then migrate onto the same primitive, which also removes an existing `no-restricted-syntax` eslint suppression.

**Tech Stack:** Next.js App Router (RSC + "use client"), TypeScript, Tailwind, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-26-nav-ia-user-friendliness-design.md` (Stages 3 and 4)

**Branch:** continue on `design/nav-ia-user-friendliness` (extends PR #465).

## Global Constraints

- **No em-dashes anywhere**, including comments and strings. CI-enforced by the `local/no-em-dash` ESLint rule; this repo writes `--` where prose wants a dash.
- **A nav item must never dead-end at `/no-access`.** This has been the recurring defect of this whole program, caught four times. Verify BOTH the destination page's own gate AND the module layout gate above it, by reading them. Do not assume.
- `src/platform/**` must never import from `src/modules/**`. The reverse is allowed.
- The house style rule in `docs/ui-house-style.md` restricts raw controls in `src/app/**` and `src/modules/**` via `no-restricted-syntax`. A new primitive belongs in `src/platform/ui/`.
- **Verification:** `npx vitest run src/platform/ src/modules/recruitment/`, `npm run typecheck`, `npx eslint src e2e`. Do NOT run bare `npx vitest run`. Do NOT run `npm run lint` (walks a gitignored scratch dir). Playwright cannot run locally.
- **Known failing at origin/main, NOT yours:** `src/platform/branding/assets.test.ts` (2), `src/platform/airtable/import/certificates.test.ts` (1).

---

### Task 1: The `TabRow` primitive

**Files:**
- Create: `src/platform/ui/tab-row.tsx`
- Test: `src/platform/ui/tab-row.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export type TabItem = { label: string; href: string; badge?: number };
export function TabRow(props: {
  items: TabItem[];
  /** Active-state test. Supplied by the caller because the three consumers
   *  disagree: module nav prefix-matches sub-paths, query-param tabs compare a
   *  search param, and the cycle nav exact-matches. */
  isActive: (item: TabItem) => boolean;
  /** "underline" is the existing module-tab look. "segmented" is a pill row for
   *  a nav nested under another tab row. */
  variant?: "underline" | "segmented";
  /** Accessible name for the nav landmark. */
  label: string;
}): JSX.Element;
```

Note `TabRow` takes `isActive` as a prop rather than computing it, and takes `href` strings rather than click handlers, so it stays a presentational component with no router dependency. It is NOT a "use client" component itself; consumers that need `usePathname` stay client components and pass the result down.

- [ ] **Step 1: Write the failing test**

Create `src/platform/ui/tab-row.test.tsx`, following the house pattern in `src/platform/ui/env-banner.test.tsx` (`renderToStaticMarkup`, no jsdom):

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TabRow, type TabItem } from "./tab-row";

const ITEMS: TabItem[] = [
  { label: "Overview", href: "/x" },
  { label: "Applicants", href: "/x/applicants" },
];

describe("TabRow", () => {
  it("renders one link per item", () => {
    const out = renderToStaticMarkup(
      <TabRow items={ITEMS} isActive={() => false} label="Cycle" />,
    );
    expect(out).toContain('href="/x"');
    expect(out).toContain('href="/x/applicants"');
  });

  it("marks the active item with aria-current so it is not colour-only", () => {
    const out = renderToStaticMarkup(
      <TabRow items={ITEMS} isActive={(i) => i.href === "/x/applicants"} label="Cycle" />,
    );
    expect(out).toContain('aria-current="page"');
  });

  it("names the nav landmark, so stacked rows are distinguishable to a screen reader", () => {
    const out = renderToStaticMarkup(
      <TabRow items={ITEMS} isActive={() => false} label="Cycle sections" />,
    );
    expect(out).toContain('aria-label="Cycle sections"');
  });

  it("renders nothing when there are no items", () => {
    expect(renderToStaticMarkup(<TabRow items={[]} isActive={() => false} label="Empty" />)).toBe("");
  });

  it("renders a badge count when supplied", () => {
    const out = renderToStaticMarkup(
      <TabRow items={[{ label: "Approvals", href: "/a", badge: 3 }]} isActive={() => false} label="X" />,
    );
    expect(out).toContain("3");
  });

  it("uses distinct markup for the two variants", () => {
    const underline = renderToStaticMarkup(
      <TabRow items={ITEMS} isActive={(i) => i.href === "/x"} label="X" variant="underline" />,
    );
    const segmented = renderToStaticMarkup(
      <TabRow items={ITEMS} isActive={(i) => i.href === "/x"} label="X" variant="segmented" />,
    );
    expect(underline).not.toBe(segmented);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/ui/tab-row.test.tsx`
Expected: FAIL, cannot resolve `./tab-row`.

- [ ] **Step 3: Implement**

Create `src/platform/ui/tab-row.tsx`. Requirements:

- Renders `<nav aria-label={label}>` containing one `next/link` per item.
- Active item gets `aria-current="page"` (meaning must not be colour-only).
- `variant="underline"` reproduces the CURRENT `ModuleNav` look exactly: `flex gap-6 overflow-x-auto border-b border-border text-sm`, active item `shrink-0 whitespace-nowrap border-b-2 border-brand pb-2 text-brand-fg font-medium`, inactive `shrink-0 whitespace-nowrap pb-2 text-muted-foreground hover:text-foreground`. Copy these from `src/platform/ui/module-nav.tsx` verbatim so Task 2 is a pure refactor with zero visual change.
- `variant="segmented"` is a pill row: a rounded container with `bg-muted p-1`, each item `rounded-lg px-3 py-1.5 text-sm`, active item `bg-surface text-foreground shadow-sm`, inactive `text-muted-foreground hover:text-foreground`. It must scroll horizontally on narrow screens the same way underline does.
- Both variants hide the scrollbar with `[scrollbar-width:none] [&::-webkit-scrollbar]:hidden`, matching `module-nav.tsx`.
- Returns `null` when `items` is empty.
- Badge, when present, renders as a small count pill beside the label.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/ui/tab-row.test.tsx`
Expected: PASS, all six cases.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npx eslint src`

```bash
git add src/platform/ui/tab-row.tsx src/platform/ui/tab-row.test.tsx
git commit -m "feat(ui): add the shared TabRow primitive"
```

---

### Task 2: `ModuleNav` becomes a thin wrapper over `TabRow`

Proves the primitive against the existing consumer. This is a PURE REFACTOR: rendered output and behaviour must not change.

**Files:**
- Modify: `src/platform/ui/module-nav.tsx`
- Test: `src/platform/ui/module-nav.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `TabRow` from Task 1.
- Produces: `ModuleNav({ items }: { items: { label: string; href: string }[] })`, signature UNCHANGED. Every existing caller must keep working untouched.

- [ ] **Step 1: Write the characterization test first**

Before changing `module-nav.tsx`, create `src/platform/ui/module-nav.test.tsx` capturing its CURRENT behaviour, so the refactor is provably safe:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModuleNav } from "./module-nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/people" }));

const ITEMS = [
  { label: "Overview", href: "/admin" },
  { label: "People", href: "/admin/people" },
  { label: "Terms", href: "/admin/terms" },
];

describe("ModuleNav active matching", () => {
  it("marks the deep sub-page active, not the module root", () => {
    const out = renderToStaticMarkup(<ModuleNav items={ITEMS} />);
    // Exactly one aria-current in the row.
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    // And it is on the People link.
    const peopleSegment = out.slice(out.indexOf('href="/admin/people"') - 200, out.indexOf('href="/admin/people"') + 200);
    expect(peopleSegment).toContain('aria-current="page"');
  });

  it("renders every item", () => {
    const out = renderToStaticMarkup(<ModuleNav items={ITEMS} />);
    for (const i of ITEMS) expect(out).toContain(`href="${i.href}"`);
  });
});
```

Run it against the UNCHANGED component first and confirm it PASSES. That is the point: it characterizes current behaviour. If it fails, your understanding of the component is wrong; investigate before refactoring.

The active-matching rule to preserve is at `module-nav.tsx:20-27`: exact match, OR prefix match but only for hrefs that have a sub-segment, so the module root does not match every sub-page.

- [ ] **Step 2: Refactor**

Rewrite `module-nav.tsx` so it keeps `"use client"`, keeps `usePathname`, keeps its `isActive` logic and its scroll-into-view effect, and delegates rendering to `<TabRow variant="underline" label="Module" items={items} isActive={isActive} />`.

Keep the `aria-label="Module"` landmark name it has today.

The `activeRef` scroll-into-view effect (`module-nav.tsx:32-34`) keeps the active tab visible on narrow screens. If `TabRow` cannot expose a ref for that, either add an optional `activeRef` prop to `TabRow` or keep the effect by querying `[aria-current="page"]` within the nav. Do not silently drop the behaviour; say in your report which approach you took.

- [ ] **Step 3: Verify the refactor changed nothing**

Run: `npx vitest run src/platform/ui/`
Expected: PASS, including the characterization test written in Step 1 and every existing UI test.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npx eslint src`

```bash
git add src/platform/ui/module-nav.tsx src/platform/ui/module-nav.test.tsx
git commit -m "refactor(ui): render ModuleNav through TabRow"
```

---

### Task 3: `cycle-nav.ts`, the pure visibility logic

Lifts the cycle workspace's tab visibility out of the page and into a testable module, mirroring the existing `src/modules/recruitment/nav.ts` pattern.

**Files:**
- Create: `src/modules/recruitment/cycle-nav.ts`
- Test: `src/modules/recruitment/cycle-nav.test.ts`

**Interfaces:**
- Consumes: `TabItem` type shape from Task 1 (import the type, or restate it locally if the eslint boundary makes importing awkward; `src/modules/**` may import `@/platform/**`, so importing is fine).
- Produces:
```ts
export function cycleNavItems(opts: {
  cycleId: string;
  track: "VOLUNTEER" | "DIRECTOR";
  canManage: boolean;      // recruitment.manage_cycles
  canReviewAll: boolean;   // recruitment.review_all
}): { label: string; href: string }[];
```

- [ ] **Step 1: Write the failing test**

The visibility rules, lifted verbatim from `src/app/(app)/recruitment/cycles/[id]/page.tsx` (the button wall at lines 93-117 and the Training card at 237-245). Read that file and confirm each rule before writing the test:

| Tab | Href suffix | Shown when |
|---|---|---|
| Overview | (none) | always |
| Form | `/builder` | `canManage` |
| Contract | `/builder/contract` | `canManage` |
| Applicants | `/applicants` | always |
| Speed route | `/speed-route` | always |
| Waitlist | `/waitlist` | always |
| Decisions | `/decisions` | `canReviewAll` |
| Subcommittees | `/subcommittees` | `track === "VOLUNTEER" && (canReviewAll or canManage)` |
| Interviews | `/interviews` | `track === "DIRECTOR"` |
| Onboarding | `/onboarding` | `canReviewAll` |
| Emails | `/emails` | `canManage` |
| Quiz | `/builder/quiz` | `canManage` |
| Training | `/training` | always |

Create `src/modules/recruitment/cycle-nav.test.ts` covering:
- a full-permission VOLUNTEER cycle shows Subcommittees and not Interviews
- a full-permission DIRECTOR cycle shows Interviews and not Subcommittees
- `canManage: false` hides Form, Contract, Emails, and Quiz
- `canReviewAll: false` hides Decisions and Onboarding
- a viewer with neither still gets Overview, Applicants, Speed route, Waitlist, Training (the always-on set)
- every href starts with `/recruitment/cycles/<cycleId>`
- Overview is always first

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/cycle-nav.test.ts`
Expected: FAIL, cannot resolve `./cycle-nav`.

- [ ] **Step 3: Implement**

Create `src/modules/recruitment/cycle-nav.ts` as a pure function, no Prisma, no `can()`, no async. The caller resolves permissions and passes booleans, exactly as `recruitmentNavItems` does in `nav.ts`.

Add a file comment stating that this mirrors the page gates and that the two must move together, naming the page file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/cycle-nav.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npx eslint src`

```bash
git add src/modules/recruitment/cycle-nav.ts src/modules/recruitment/cycle-nav.test.ts
git commit -m "feat(recruitment): extract cycle workspace nav visibility"
```

---

### Task 4: The cycle workspace layout, and retiring the button wall

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/layout.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/page.tsx` (remove the button wall and the Training card's two links)
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx:108` (remove the now-duplicate Speed route link)

**Interfaces:**
- Consumes: `cycleNavItems` from Task 3, `TabRow` from Task 1.
- Produces: no new exports.

- [ ] **Step 1: Create the layout**

Create `cycles/[id]/layout.tsx`. It must:
- `await requirePersonSession()` and resolve `canManage` (`recruitment.manage_cycles`) and `canReviewAll` (`recruitment.review_all`) via `can()`, in a single `Promise.all`.
- Load the cycle to get its `track` and title. Use the existing `getCycle` from `@/modules/recruitment/services/cycles`. If it returns null, call `notFound()`.
- Render `<TabRow variant="segmented" label="Cycle sections" items={...} isActive={...} />` above `{children}`.
- The active test must exact-match the pathname, EXCEPT that Overview (the cycle root) must not match every sub-page. Reuse the same shape of rule `ModuleNav` uses.

Note the subtree gate already runs in `cycles/layout.tsx` (`requireRecruitmentStaff`), so this layout does not need to re-gate access; it only needs the two booleans for tab visibility. Do not weaken or duplicate that gate.

`TabRow` is not a client component, but `isActive` needs the pathname. Make the cycle nav a small `"use client"` wrapper (like `ModuleNav`) that takes the resolved items and does its own `usePathname`. Put it at `src/modules/recruitment/components/cycle-nav-tabs.tsx`.

- [ ] **Step 2: Strip the button wall from the overview**

In `cycles/[id]/page.tsx`, delete the `<div className="flex flex-wrap gap-2">` block containing the nine navigation links (around lines 93-117), and delete the two links inside the Training card (`Edit quiz` and `Training roster`, around lines 241-245). Keep everything else: status badge, public link, departments, application window, lifecycle actions, and the quiz settings form.

Delete `navLink`/`buttonClasses` if they become unused. Verify with a grep before deleting.

The overview should now read as an overview rather than a launcher.

- [ ] **Step 3: Remove the duplicate Speed route link**

`applicants/page.tsx:108` links to speed-route. The cycle nav now carries it persistently, so this button is redundant.

**This is not optional tidying.** `e2e/recruitment-speed-routing.spec.ts:115` does an unscoped `page.getByRole("link", { name: /speed route/i }).click()`. With both the nav tab and this button on the applicants page, that selector matches two elements and Playwright strict mode throws. This exact class of failure has already cost this branch two CI cycles.

Delete the link. The e2e selector then resolves to the nav tab and keeps working unchanged.

- [ ] **Step 4: Verify**

Run:
```
npx vitest run src/platform/ src/modules/recruitment/
npm run typecheck
npx eslint src e2e
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]" src/modules/recruitment/components/cycle-nav-tabs.tsx
git commit -m "feat(recruitment): give a cycle a persistent workspace nav"
```

---

### Task 5: `/support/epic` renders through `TabRow`

**Files:**
- Modify: `src/modules/support/components/epic-request-tabs.tsx` (the `TabNav` function only)

**Interfaces:**
- Consumes: `TabRow` from Task 1.
- Produces: no signature change to `EpicRequestTabs`.

- [ ] **Step 1: Replace `TabNav`'s internals**

The current `TabNav` (around lines 88-115) renders raw `<button>` elements driven by `router.push`, and carries an eslint suppression:

```
// eslint-disable-next-line no-restricted-syntax -- tab control with border-b-2 active-state indicator; segmented toggle pattern
```

Replace it with `TabRow`, `variant="underline"`, `label="Epic sections"`.

Two things to preserve exactly:
- **The URLs stay `?tab=<x>` and stay shareable.** Build each item's `href` from the CURRENT search params with `tab` replaced, so any other query param on the URL survives, which is what the existing `goTo` does via `new URLSearchParams(searchParams.toString())`.
- **Navigation stays soft.** `TabRow` uses `next/link`, which soft-navigates, matching the current `router.push`. Do not emit a raw `<a href>`: per this repo's convention that causes a full reload.

`isActive` compares against the `activeTab` prop the component already receives.

The eslint suppression must be DELETED, not moved. Its removal is the point: the primitive exists so raw controls are unnecessary. If eslint still complains after the change, that is a signal the migration is incomplete; do not re-add a suppression without telling me why.

Keep the `<Suspense>` wrapper around `TabNav`: it exists because `useSearchParams` suspends.

- [ ] **Step 2: Verify**

Run:
```
npx vitest run src/platform/ src/modules/
npm run typecheck
npx eslint src e2e
```
Expected: PASS, with no new eslint suppressions anywhere.

- [ ] **Step 3: Commit**

```bash
git add src/modules/support/components/epic-request-tabs.tsx
git commit -m "refactor(support): render the Epic tabs through TabRow"
```

---

### Task 6: e2e coverage and house-style documentation

**Files:**
- Create: `e2e/cycle-workspace.spec.ts`
- Modify: `docs/ui-house-style.md`

- [ ] **Step 1: Write the e2e spec**

Create `e2e/cycle-workspace.spec.ts`, following `e2e/global-nav.spec.ts` conventions (the `devSignIn` helper shape, role-scoped selectors, `waitForURL` with a pathname predicate). Reuse the cycle-creation helpers in `e2e/recruitment-helpers.ts` if they fit; read that file first.

Cover:
- the cycle nav is present on the overview AND persists on a sub-page (navigate to Applicants, assert the nav is still rendered)
- clicking a tab navigates and marks it current
- a sub-page is reachable from another sub-page WITHOUT returning to the overview, which is the entire point of the stage
- the overview no longer renders the old button wall (assert the nav landmark exists and that the overview does not contain a duplicate set of the same links outside it)

**Scope every tab lookup to the nav landmark** (`page.getByRole("navigation", { name: "Cycle sections" }).getByRole("link", { name: ... })`). Sub-page content frequently repeats these words, and unscoped selectors are how this branch has broken CI twice.

- [ ] **Step 2: Document the primitive**

In `docs/ui-house-style.md`, add `TabRow` to the page-chrome primitive table alongside the others, with its two variants and a one-line note that `ModuleNav` and the Epic tabs both render through it, and that a nested tab row should use `segmented` so two identical underline rows never stack.

- [ ] **Step 3: Verify what can be verified**

Run: `npm run typecheck && npx eslint src e2e`
Expected: PASS.

Playwright CANNOT run locally (needs CI Postgres and seeded fixtures). Do not attempt it and do not claim these specs pass.

- [ ] **Step 4: Commit**

```bash
git add e2e/cycle-workspace.spec.ts docs/ui-house-style.md
git commit -m "test(e2e): cover the cycle workspace nav; document TabRow"
```

---

## Verification checklist

- [ ] `npx vitest run src/platform/ src/modules/` passes (minus the 3 known pre-existing failures).
- [ ] `npm run typecheck` passes.
- [ ] `npx eslint src e2e` passes, with one FEWER suppression than before (the Epic tab one is gone).
- [ ] CI Playwright green, including `recruitment-speed-routing.spec.ts` which depends on the duplicate link being removed.
- [ ] Manual: the cycle nav persists across every cycle sub-page and does not stack two identical underline rows.
- [ ] Manual: the overview reads as an overview, not a launcher.
- [ ] Manual: `/support/epic?tab=tracker` still deep-links correctly and preserves other query params.

## Risk

The largest is Task 2: `ModuleNav` renders on most authenticated pages, so a visual regression there is broad. That is why it ships as a pure refactor guarded by a characterization test written BEFORE the change, and why `TabRow`'s underline variant copies the existing class strings verbatim rather than reinterpreting them.
