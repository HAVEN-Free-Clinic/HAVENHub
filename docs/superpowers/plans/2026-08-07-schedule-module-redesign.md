# Schedule Module Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the schedule module onto the shared design system and fix the layouts the hand-rolled maroon hero was compensating for, without changing any behaviour.

**Architecture:** Presentation-layer only. Every change is in a page component or a component under `src/modules/schedule/components/`. Services, engine, server actions, routes, query params, permissions, and the Prisma schema are untouched, so the module's existing service and engine tests stay green throughout and are the proof the redesign changed nothing but pixels.

**Tech Stack:** Next.js App Router (server components), React 19, Tailwind, Vitest (`renderToStaticMarkup` for components), Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-08-07-schedule-module-redesign-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **No em-dash (U+2014) anywhere in `src/**/*.{ts,tsx}`.** CI-enforced by `local/no-em-dash`, which scans raw source text so it catches comments and strings too. Use a comma, colon, parentheses, or a hyphen.
- **Do not modify** `src/modules/schedule/services/**` or `src/modules/schedule/engine/**`. If a task appears to require it, stop and report rather than absorbing the change.
- **Do not change** any server action's name, signature, or behaviour; any route; any query parameter; any permission or gate.
- **No `className` on a raw `button`, `input`, `select`, or `textarea`.** Enforced by `no-restricted-syntax`. Use the `Button`, `Input`, `Select`, `Checkbox` primitives from `@/platform/ui/`.
- **Module boundaries:** `src/modules/schedule` may import `@/platform/*` and its own files. It may not import another module. `src/platform` may not import any module.
- **No `tailwind-merge`.** Compose classes with `cx` from `@/platform/ui/cx`.
- **Both themes.** Every surface must render correctly in light and dark. Use semantic tokens (`text-foreground`, `text-muted-foreground`, `text-subtle-foreground`, `bg-surface`, `bg-muted`, `border-border`). Never hardcode `text-white` outside a brand-filled element.
- **Lint command is `npx eslint src e2e`**, not `npm run lint`. The latter walks a gitignored design-system directory and reports false failures.
- **Unit test command:**
  ```bash
  TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_sched_redesign npm test
  ```
  This database is already created and migrated for this worktree. Do not point tests at any other database, and never at Neon.
- **E2E command** (a single spec file runs in about 20 seconds, so there is no excuse for guessing):
  ```bash
  DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
  DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
  AUTH_SECRET=ci-only-secret \
  npx playwright test e2e/schedule.spec.ts --workers=1 --reporter=line
  ```
  Seed once first with the same two URLs plus `npm run db:seed`.
- **Every task that changes user-facing markup must update `e2e/schedule.spec.ts` in the same commit** and leave that spec passing. Rewrite selectors toward role and accessible name (`getByRole("heading", { name: ... })`). Do not re-pin a selector to a presentation class; that rebuilds the trap this plan is removing.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/modules/schedule/components/clinic-date-strip.tsx` | The month-grouped clinic date navigation, shared by Full Schedule and Builder |
| `src/modules/schedule/components/clinic-date-strip.test.tsx` | Its unit tests |
| `src/modules/schedule/components/intake-notes.tsx` | Training-intake preferences block, moved out of the Builder page |
| `src/modules/schedule/components/builder-availability-view.tsx` | The availability-override editor, moved out of the Builder page |
| `src/modules/schedule/components/builder-day-view.tsx` | The Assigned and Available-to-assign columns, moved out of the Builder page |
| `src/modules/schedule/components/builder-toolbar.tsx` | Department, term, and view controls |
| `src/modules/schedule/components/builder-toolbar.test.tsx` | Its unit tests |

**Modified:**

| File | Change |
| --- | --- |
| `src/app/(app)/schedule/page.tsx` | PageHeader, StatCards, next/later/past shift grouping, availability count |
| `src/app/(app)/schedule/full/page.tsx` | PageHeader, ClinicDateStrip, neutral department cards |
| `src/app/(app)/schedule/builder/page.tsx` | Shrinks from 1,165 lines to data loading plus actions plus composition |
| `src/modules/schedule/components/builder-grid.tsx` | Shadow-mode announcement and tint |
| `src/modules/schedule/components/pending-requests.tsx` | SectionHeader |
| `src/modules/schedule/components/capacity-panel.tsx` | SectionHeader |
| `src/modules/schedule/components/readiness-panel.tsx` | SectionHeader |
| `src/modules/schedule/calendar/subscribe-card.tsx` | SectionHeader |
| `e2e/schedule.spec.ts` | Selectors rewritten toward role and accessible name |

---

## Task 1: ClinicDateStrip

The date strip is copy-pasted between `full/page.tsx` and `builder/page.tsx` as identical class strings. Extract one component and give it month grouping.

**Files:**
- Create: `src/modules/schedule/components/clinic-date-strip.tsx`
- Test: `src/modules/schedule/components/clinic-date-strip.test.tsx`

**Interfaces:**
- Consumes: `displayDate(key: string): string` from `@/modules/schedule/engine/display`; `isoDateKey(d: Date): string` and `formatCalendarDate(d: Date, opts: Intl.DateTimeFormatOptions): string` from `@/platform/dates`.
- Produces: `ClinicDateStrip(props: ClinicDateStripProps)` where
  ```ts
  export type ClinicDateStripProps = {
    dates: Date[];
    selectedKey: string | null;
    hrefFor: (key: string) => string;
    ariaLabel: string;
  };
  ```
  Tasks 2 and 5 consume this exact signature.

**Why `ariaLabel` is a prop and not a constant:** the two call sites use different labels today (`"Schedule dates"` on Full Schedule, `"Clinic dates"` on Builder). Both are accurate to their page, and `e2e/schedule.spec.ts` selects on both. Hardcoding either one breaks a passing test for no benefit.

- [ ] **Step 1: Write the failing test**

Create `src/modules/schedule/components/clinic-date-strip.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { ClinicDateStrip } = await import("./clinic-date-strip");

/** Noon-UTC anchored calendar date, matching how the schema stores clinicDate. */
function d(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

const DATES = [d(2026, 9, 6), d(2026, 9, 20), d(2026, 10, 4)];

describe("ClinicDateStrip", () => {
  it("labels the nav with the caller's aria-label", () => {
    const out = renderToStaticMarkup(
      <ClinicDateStrip dates={DATES} selectedKey={null} hrefFor={(k) => `/x?date=${k}`} ariaLabel="Clinic dates" />,
    );
    expect(out).toContain('aria-label="Clinic dates"');
  });

  it("groups consecutive dates under one month label and starts a new group at a month change", () => {
    const out = renderToStaticMarkup(
      <ClinicDateStrip dates={DATES} selectedKey={null} hrefFor={(k) => `/x?date=${k}`} ariaLabel="Clinic dates" />,
    );
    expect(out).toContain("September 2026");
    expect(out).toContain("October 2026");
    // September appears once even though it holds two dates.
    expect(out.match(/September 2026/g)).toHaveLength(1);
  });

  it("marks only the selected date with aria-current", () => {
    const out = renderToStaticMarkup(
      <ClinicDateStrip dates={DATES} selectedKey="2026-09-20" hrefFor={(k) => `/x?date=${k}`} ariaLabel="Clinic dates" />,
    );
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("builds each link with the caller's hrefFor", () => {
    const out = renderToStaticMarkup(
      <ClinicDateStrip dates={DATES} selectedKey={null} hrefFor={(k) => `/schedule/full?date=${k}`} ariaLabel="Schedule dates" />,
    );
    expect(out).toContain('href="/schedule/full?date=2026-09-06"');
    expect(out).toContain('href="/schedule/full?date=2026-10-04"');
  });

  it("renders one link per date", () => {
    const out = renderToStaticMarkup(
      <ClinicDateStrip dates={DATES} selectedKey={null} hrefFor={(k) => `/x?date=${k}`} ariaLabel="Clinic dates" />,
    );
    expect(out.match(/<a /g)).toHaveLength(3);
  });

  it("renders nothing when there are no clinic dates", () => {
    const out = renderToStaticMarkup(
      <ClinicDateStrip dates={[]} selectedKey={null} hrefFor={(k) => `/x?date=${k}`} ariaLabel="Clinic dates" />,
    );
    expect(out).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_sched_redesign \
  npx vitest run src/modules/schedule/components/clinic-date-strip.test.tsx
```

Expected: FAIL, cannot resolve `./clinic-date-strip`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/schedule/components/clinic-date-strip.tsx`:

```tsx
/**
 * Month-grouped clinic date navigation.
 *
 * Shared by Full Schedule and the Builder, which previously carried identical
 * copy-pasted markup. Grouping by month replaces a single undifferentiated wrap
 * of 15 to 20 pills, which is hard to scan across a whole term.
 *
 * Server component: no "use client" directive.
 */

import Link from "next/link";
import { isoDateKey, formatCalendarDate } from "@/platform/dates";
import { displayDate } from "@/modules/schedule/engine/display";

export type ClinicDateStripProps = {
  dates: Date[];
  /** ISO date key of the currently selected date, or null when none is. */
  selectedKey: string | null;
  hrefFor: (key: string) => string;
  /**
   * Accessible name for the nav landmark. A prop, not a constant: the two call
   * sites describe different things ("Schedule dates" vs "Clinic dates") and
   * both labels are accurate to their page.
   */
  ariaLabel: string;
};

type MonthGroup = { month: string; dates: Date[] };

/**
 * Group an already-ordered date list into runs of the same month. Runs, not a
 * keyed map, so the caller's ordering is preserved exactly and a term spanning
 * a year boundary cannot collapse two Januaries onto one heading.
 */
function groupByMonth(dates: Date[]): MonthGroup[] {
  const groups: MonthGroup[] = [];
  for (const date of dates) {
    const month = formatCalendarDate(date, { month: "long", year: "numeric" });
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.dates.push(date);
    else groups.push({ month, dates: [date] });
  }
  return groups;
}

export function ClinicDateStrip({ dates, selectedKey, hrefFor, ariaLabel }: ClinicDateStripProps) {
  if (dates.length === 0) return null;

  return (
    <nav aria-label={ariaLabel} className="flex flex-col gap-3">
      {groupByMonth(dates).map((group) => (
        <div key={group.month} className="flex flex-wrap items-center gap-2">
          {/*
            A span, not a SectionHeader: these label a run of links inside a nav
            landmark rather than opening a document section, and promoting them
            to headings would put month names into the page outline.
          */}
          <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
            {group.month}
          </span>
          {group.dates.map((date) => {
            const key = isoDateKey(date);
            const isSelected = key === selectedKey;
            return (
              <Link
                key={key}
                href={hrefFor(key)}
                aria-current={isSelected ? "page" : undefined}
                className={
                  isSelected
                    ? "inline-flex items-center justify-center min-h-11 rounded-full px-3 py-1 text-sm font-medium bg-brand text-white"
                    : "inline-flex items-center justify-center min-h-11 rounded-full px-3 py-1 text-sm font-medium bg-muted text-foreground-soft hover:bg-muted-strong transition-colors"
                }
              >
                {displayDate(key)}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_sched_redesign \
  npx vitest run src/modules/schedule/components/clinic-date-strip.test.tsx
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and lint**

```bash
npm run typecheck && npx eslint src e2e
```

Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/modules/schedule/components/clinic-date-strip.tsx src/modules/schedule/components/clinic-date-strip.test.tsx
git commit -m "feat(schedule): add a shared month-grouped clinic date strip"
```

---

## Task 2: Full Schedule

**Files:**
- Modify: `src/app/(app)/schedule/full/page.tsx`
- Modify: `e2e/schedule.spec.ts`

**Interfaces:**
- Consumes: `ClinicDateStrip` from Task 1.
- Produces: nothing later tasks depend on.

Three changes: the hero becomes `PageHeader`, the date wrap becomes `ClinicDateStrip`, and the department cards lose their `bg-brand` cap.

The selected date moves out of the page title. Today the `<h1>` is the date, so the page title changes every time a date is clicked. The title becomes the stable `"Full Schedule"` and the date becomes a `SectionHeader` above the grid.

- [ ] **Step 1: Replace the hero with PageHeader**

In `src/app/(app)/schedule/full/page.tsx`, add these imports:

```tsx
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { ClinicDateStrip } from "@/modules/schedule/components/clinic-date-strip";
```

Delete the `Link` import (`ClinicDateStrip` now owns the links) and the `displayDate` import if it becomes unused after Step 2.

Replace the whole hero block (the `<div className="rounded-2xl bg-brand px-8 py-6 text-white mb-8">` element and its contents) with:

```tsx
<PageHeader
  title="Full Schedule"
  description={
    term
      ? `${term.name}${
          selectedDate && departments.length > 0
            ? ` · ${totalDirectors} director${totalDirectors !== 1 ? "s" : ""}, ${totalVolunteers} volunteer${
                totalVolunteers !== 1 ? "s" : ""
              }, ${totalShadows} shadow${totalShadows !== 1 ? "s" : ""} across ${departments.length} department${
                departments.length !== 1 ? "s" : ""
              }`
            : ""
        }`
      : undefined
  }
/>
```

The `term` variable already exists from `fullSchedule(sp.date)`. Wrap the `PageHeader` in `<div className="mb-8">` so it keeps the bottom spacing the hero's own `mb-8` provided.

- [ ] **Step 2: Replace the date wrap with ClinicDateStrip**

Replace the entire `{clinicDates.length > 0 && (<nav className="mb-8 flex flex-wrap gap-2" aria-label="Schedule dates">...</nav>)}` block with:

```tsx
<div className="mb-8">
  <ClinicDateStrip
    dates={clinicDates}
    selectedKey={selectedKey}
    hrefFor={(key) => `/schedule/full?date=${key}`}
    ariaLabel="Schedule dates"
  />
</div>
```

Then add the selected date as a section heading directly above the department grid:

```tsx
{selectedDisplay && <SectionHeader className="mb-4">{selectedDisplay}</SectionHeader>}
```

- [ ] **Step 3: Neutralise the department card headers**

Replace the card header block:

```tsx
{/* Card header */}
<div className="bg-brand px-4 py-3 flex items-center justify-between">
  <span className="text-sm font-black uppercase tracking-widest text-white">
    {department.code}
  </span>
  ...
</div>
```

with:

```tsx
{/* Card header. Neutral surface, not bg-brand: the brand colour means
    "selected" everywhere else in this module, and a grid of brand-capped
    cards spends it on decoration. */}
<div className="border-b border-border bg-muted px-4 py-3 flex flex-wrap items-center justify-between gap-2">
  <SectionHeader as="h3" level="title" className="min-w-0 truncate">
    {department.name}
  </SectionHeader>
  <div className="flex items-center gap-1.5">
    <Badge>{department.code}</Badge>
    {directors.length > 0 && <Badge tone="brand">{directors.length} director{directors.length === 1 ? "" : "s"}</Badge>}
    {volunteers.length > 0 && <Badge tone="success">{volunteers.length} volunteer{volunteers.length === 1 ? "" : "s"}</Badge>}
    {shadows.length > 0 && <Badge tone="warning">{shadows.length} shadow{shadows.length === 1 ? "" : "s"}</Badge>}
  </div>
</div>
```

- [ ] **Step 4: Convert the role group labels to SectionHeader**

Replace each of the three `<p className="text-xs font-semibold uppercase tracking-widest text-subtle-foreground mb-1.5">` labels (`Directors`, `Volunteers`, `Shadows`) with:

```tsx
<SectionHeader as="h4" className="mb-1.5">Directors</SectionHeader>
```

and likewise for `Volunteers` and `Shadows`. `as="h4"` keeps the outline ordered beneath the `h3` department name.

- [ ] **Step 5: Update the e2e selector this task breaks**

In `e2e/schedule.spec.ts`, line 82 currently reads:

```ts
await expect(page.locator("p").filter({ hasText: "Full Schedule" }).first()).toBeVisible();
```

This matched only because the maroon hero rendered `Full Schedule` in a `<p>` eyebrow above the `<h1>`. `PageHeader` has no eyebrow, so it must become:

```ts
await expect(page.getByRole("heading", { name: "Full Schedule" })).toBeVisible();
```

The `nav[aria-label="Schedule dates"]` selector at line 86 and the `dateNav.getByRole("link")` at line 91 both still work: `ClinicDateStrip` preserves the label and still renders one link per date.

- [ ] **Step 6: Run the checks**

```bash
npm run typecheck && npx eslint src e2e
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
AUTH_SECRET=ci-only-secret \
npx playwright test e2e/schedule.spec.ts --workers=1 --reporter=line
```

Expected: typecheck and lint clean, e2e passing.

- [ ] **Step 7: Commit**

```bash
git add src/app/\(app\)/schedule/full/page.tsx e2e/schedule.spec.ts
git commit -m "refactor(schedule): move Full Schedule onto PageHeader and the shared date strip"
```

---

## Task 3: My Schedule

**Files:**
- Modify: `src/app/(app)/schedule/page.tsx`
- Modify: `e2e/schedule.spec.ts`

**Interfaces:**
- Consumes: `MyTermSchedule` from `@/modules/schedule/services/schedule` (read only, unchanged). `mySchedule` already returns `shifts` ordered `clinicDate` ascending, so no sorting is needed for the upcoming groups; the past group is reversed for display.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Replace the hero with PageHeader**

Add imports:

```tsx
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { StatCard } from "@/platform/ui/stat-card";
import Link from "next/link";
```

Replace the hero `<div className="rounded-2xl bg-brand px-8 py-6 text-white mb-8">` block with:

```tsx
<div className="mb-8">
  <PageHeader
    title="My Schedule"
    description={
      primary
        ? `${primary.term.name}${
            primary.shifts.length > 0
              ? ` · ${[...new Set(primary.shifts.map((s) => s.department.name))].join(", ")}`
              : " · No shifts assigned yet"
          }`
        : undefined
    }
    action={
      <Link
        href="#calendar-subscription"
        className="inline-flex items-center min-h-11 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-foreground-soft hover:border-border-strong transition-colors"
      >
        Add to calendar
      </Link>
    }
  />
</div>
```

Give the existing calendar section that anchor id. Change:

```tsx
<section className="mt-10">
  <CalendarSubscribeSection
```

to:

```tsx
<section id="calendar-subscription" className="mt-10 scroll-mt-8">
  <CalendarSubscribeSection
```

The action is an in-page anchor, not a second copy of the subscribe controls, so `generateFeedAction` and `resetFeedAction` keep exactly one call site.

- [ ] **Step 2: Replace the two-column layout with a stats row**

The `<div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_320px]">` split exists only to park a sidebar card whose contents (shift count, role, departments) restate the header. Delete the grid wrapper and the entire `{/* Right column: quick info sidebar */}` block, promoting the left column's contents to full width.

Directly beneath the term heading, add:

```tsx
{/* Figures the header does not already state. Shift count and departments
    live in the PageHeader description, so these carry availability and
    request state instead of repeating it. */}
<div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
  <StatCard label="Shifts this term" value={t.shifts.length} />
  <StatCard
    label="Dates available"
    value={
      t.availability && t.clinicDates.length > 0
        ? `${t.availability.dates.length} of ${t.clinicDates.length}`
        : "-"
    }
  />
  <StatCard
    label="Pending requests"
    value={t.pendingRequests.size}
    tone={t.pendingRequests.size > 0 ? "warning" : "default"}
  />
</div>
```

- [ ] **Step 3: Group shifts into next, later, and past**

Inside the `termSections.map(...)` callback, before the returned JSX, add:

```tsx
// Ordering comes from the service (clinicDate ascending), so upcoming keeps
// that order and past is reversed to put the most recent first.
const upcoming = t.shifts.filter((s) => isoDateKey(s.clinicDate) >= todayKey);
const past = t.shifts.filter((s) => isoDateKey(s.clinicDate) < todayKey).reverse();
const nextShift = upcoming[0] ?? null;
const laterShifts = upcoming.slice(1);
```

`todayKey` is already resolved once for the page. The `>=` comparison matches the existing `isPast` guard exactly: today is not past, so a same-day shift still gets the full change form.

Extract the existing shift-card JSX into a local function so all three groups render identically.

**This is a move, not a rewrite.** The card body in the current file (the block starting `const dateKey = isoDateKey(shift.clinicDate);` through the closing `</Card>`) moves verbatim into the function body. Every existing branch must survive unchanged: the `pendingReq` panel with its 5-day "Remind directors" gate and Cancel form, the `isPast` message, and the `<details>` disclosure containing both the drop form and the swap form with its `swapPartners` empty case. The `swapPartnersByKey` lookup and the `t.term.id` hidden inputs must keep working, so the function is declared inside the `termSections.map` callback where both are in scope.

Immediately inside the `termSections.map` callback, define:

```tsx
function shiftCard(shift: (typeof t.shifts)[number], emphasised: boolean) {
  const dateKey = isoDateKey(shift.clinicDate);
  const isPast = dateKey < todayKey;
  const cardKey = `${dateKey}|${shift.department.id}`;
  const pendingReq = t.pendingRequests.get(cardKey);
  const swapPartners = swapPartnersByKey.get(cardKey) ?? [];

  return (
    /* the existing <Card> ... </Card> block, moved verbatim apart from the
       container change below */
  );
}
```

The card body itself does not change. Only its container does:

```tsx
<Card
  key={cardKey}
  pad={false}
  className={emphasised ? "px-5 py-4 border-brand shadow-md" : "px-5 py-4"}
>
```

Then replace the `My Shifts` section's body. Keep the wrapping `<section>` and its `h2`, because it is the anchor `e2e/schedule.spec.ts` uses to scope its shift-request test, and because a single section with three subgroups is the honest structure:

```tsx
<section>
  <div className="flex items-center gap-3 mb-5">
    <SectionHeader as="h2" level="title">My shifts</SectionHeader>
    <Badge>{t.shifts.length} total</Badge>
  </div>

  {!hasShifts ? (
    <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-subtle-foreground">
      {noShiftsMessage}
    </div>
  ) : (
    <div className="flex flex-col gap-6">
      {nextShift && (
        <div>
          <SectionHeader as="h3" className="mb-2">Next shift</SectionHeader>
          {shiftCard(nextShift, true)}
        </div>
      )}
      {laterShifts.length > 0 && (
        <div>
          <SectionHeader as="h3" className="mb-2">Later this term</SectionHeader>
          <div className="flex flex-col gap-3">{laterShifts.map((s) => shiftCard(s, false))}</div>
        </div>
      )}
      {past.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm text-subtle-foreground hover:text-foreground-soft list-none [&::-webkit-details-marker]:hidden">
            <span className="underline underline-offset-2">
              {past.length} past shift{past.length === 1 ? "" : "s"}
            </span>
          </summary>
          <div className="mt-3 flex flex-col gap-3">{past.map((s) => shiftCard(s, false))}</div>
        </details>
      )}
    </div>
  )}
</section>
```

- [ ] **Step 4: Add the availability count**

Replace the availability section's heading block:

```tsx
<div className="flex items-center gap-3 mb-2">
  <h2 className="text-lg font-bold text-foreground">My Availability</h2>
</div>
```

with:

```tsx
<div className="flex items-center gap-3 mb-2">
  <SectionHeader as="h2" level="title">My availability</SectionHeader>
  {t.availability && t.clinicDates.length > 0 && (
    <Badge>{t.availability.dates.length} of {t.clinicDates.length} dates</Badge>
  )}
</div>
```

The heading text stays `"My availability"` as a substring, which is what `e2e/schedule.spec.ts` filters on. Leave every guard below it untouched: the `directorOverrides` read-only block, the `allDepartmentsOverridden` branch that withholds the editor, and the `clinicDates.length === 0` branch that refuses to offer a destructive Save.

- [ ] **Step 5: Convert the remaining raw headings**

Replace the term heading `<h2 className="text-xl font-bold tracking-tight text-foreground">{t.term.name}</h2>` with:

```tsx
<SectionHeader as="h2" level="title" className="text-xl">{t.term.name}</SectionHeader>
```

- [ ] **Step 6: Verify the e2e selectors still resolve**

No changes should be needed in `e2e/schedule.spec.ts` for this task, but each of these must be confirmed by running the suite rather than assumed:

- `getByRole("heading", { name: "My Schedule" })` still matches: `PageHeader` renders an `h1`.
- `page.locator("h2").filter({ hasText: "My availability" })` still matches: `hasText` is a case-insensitive substring, and the heading is still an `h2` containing that text.
- `page.locator("section").filter({ has: page.locator("h2", { hasText: "My shifts" }) })` still matches: the wrapping section and its `h2` are deliberately preserved.
- `myShiftsSection.locator("div.rounded-2xl").first()` still resolves to the next-shift card, which is a default-size `Card`.

If any of these fail, fix the selector toward role and accessible name rather than reverting the markup.

- [ ] **Step 7: Run the checks**

```bash
npm run typecheck && npx eslint src e2e
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
AUTH_SECRET=ci-only-secret \
npx playwright test e2e/schedule.spec.ts --workers=1 --reporter=line
```

- [ ] **Step 8: Commit**

```bash
git add src/app/\(app\)/schedule/page.tsx e2e/schedule.spec.ts
git commit -m "refactor(schedule): rebuild My Schedule on PageHeader, StatCards, and next-shift grouping"
```

---

## Task 4: Split the Builder page (no visual change)

**Files:**
- Create: `src/modules/schedule/components/intake-notes.tsx`
- Create: `src/modules/schedule/components/builder-availability-view.tsx`
- Create: `src/modules/schedule/components/builder-day-view.tsx`
- Modify: `src/app/(app)/schedule/builder/page.tsx`

**Interfaces:**
- Consumes: `builderView`, `BuilderMemberIntake`, `compareBuilderMembers` from `@/modules/schedule/services/builder` (read only).
- Produces:
  ```ts
  export function IntakeNotes(props: { intake: BuilderMemberIntake; className?: string }): ReactNode
  export function BuilderAvailabilityView(props: AvailabilityViewProps): ReactNode
  export function BuilderDayView(props: BuilderDayViewProps): ReactNode
  ```
  Task 5 composes all three.

**This task changes no rendered output.** It is a pure move, isolated from Task 5 so a reviewer can verify the extraction independently of the redesign. The `e2e/schedule.spec.ts` suite must pass **unchanged** at the end of this task; that is the proof the move was clean.

**The critical hazard.** Two `key` props in this file exist because losing them caused real stale-form bugs (issue #9):

1. `<CapacityPanel key={selectedDateKey} .../>` and `<ReadinessPanel key={selectedDateKey} .../>`. A date-strip click is a search-params-only soft navigation, which Next reconciles rather than remounts, so without the key the uncontrolled `defaultValue` inputs keep the previous date's typed value and Save writes it onto the new date.
2. The availability form's `key={`${member.availability.tier}:${[...availKeys].sort().join(",")}`}`. Without it, "Clear override" leaves the director's old ticks showing.

Both must survive the move verbatim.

- [ ] **Step 1: Move IntakeNotes**

Create `src/modules/schedule/components/intake-notes.tsx` and move the `IntakeNotes` function from the bottom of `builder/page.tsx` into it verbatim, adding:

```tsx
import type { BuilderMemberIntake } from "@/modules/schedule/services/builder";
```

and exporting it. Delete it from `builder/page.tsx` and import it there instead.

- [ ] **Step 2: Move AvailabilityView**

Create `src/modules/schedule/components/builder-availability-view.tsx`. Move the `AvailabilityViewProps` type and the `AvailabilityView` function into it verbatim, renaming the export to `BuilderAvailabilityView`. It needs these imports:

```tsx
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { isoDateKey } from "@/platform/dates";
import { displayDate } from "@/modules/schedule/engine/display";
import { compareBuilderMembers } from "@/modules/schedule/services/builder";
import type { builderView } from "@/modules/schedule/services/builder";
import { IntakeNotes } from "./intake-notes";
```

Keep the form `key` expression and both explanatory comments exactly as they are.

- [ ] **Step 3: Move the day view**

Create `src/modules/schedule/components/builder-day-view.tsx`. Move the Column 1 (`Assigned`) and Column 2 (`Available to assign`) sections and the `assignCard`, `assigneeInfo`, and `flagBadges` helpers they depend on. Define its props explicitly:

```tsx
export type BuilderDayViewProps = {
  members: Awaited<ReturnType<typeof builderView>>["members"];
  data: Awaited<ReturnType<typeof builderView>>;
  dept: { id: string; code: string; name: string };
  selectedDateKey: string | null;
  editable: boolean;
  assignAction: (fd: FormData) => Promise<void>;
  unassignAction: (fd: FormData) => Promise<void>;
  toggleTagAction: (fd: FormData) => Promise<void>;
};
```

Keep the sidebar (`CapacityPanel`, `ReadinessPanel`, `PendingRequests`) in `builder/page.tsx` for now. It is composed from data and actions the page owns, and moving it in the same task would widen the diff a reviewer has to check for the `key` hazard.

Preserve the `<h2>` text `Assigned` and `Available to assign` exactly. `e2e/schedule.spec.ts` scopes three separate assertions on them.

- [ ] **Step 4: Verify no output changed**

```bash
npm run typecheck && npx eslint src e2e
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
AUTH_SECRET=ci-only-secret \
npx playwright test e2e/schedule.spec.ts --workers=1 --reporter=line
```

Expected: e2e passes with **zero changes to the spec file**. If a selector broke, the move was not clean; fix the component, not the test.

- [ ] **Step 5: Confirm the remount keys survived**

```bash
grep -n "key={selectedDateKey}" src/app/\(app\)/schedule/builder/page.tsx
grep -n "member.availability.tier" src/modules/schedule/components/builder-availability-view.tsx
```

Expected: the first returns two lines (CapacityPanel, ReadinessPanel), the second returns the form `key` expression. If either is missing, the #9 bugs have been reintroduced.

- [ ] **Step 6: Commit**

```bash
git add src/modules/schedule/components/intake-notes.tsx \
        src/modules/schedule/components/builder-availability-view.tsx \
        src/modules/schedule/components/builder-day-view.tsx \
        src/app/\(app\)/schedule/builder/page.tsx
git commit -m "refactor(schedule): split the builder page into components, no output change"
```

---

## Task 5: Builder chrome and the unified View control

**Files:**
- Create: `src/modules/schedule/components/builder-toolbar.tsx`
- Create: `src/modules/schedule/components/builder-toolbar.test.tsx`
- Modify: `src/app/(app)/schedule/builder/page.tsx`
- Modify: `e2e/schedule.spec.ts`

**Interfaces:**
- Consumes: `ClinicDateStrip` (Task 1); `BuilderDayView`, `BuilderAvailabilityView` (Task 4); the existing `TermSwitcher` from `@/platform/ui/term-switcher`.
- Produces:
  ```ts
  export type BuilderView = "day" | "grid" | "availability";
  export function builderViewHref(base: string, params: BuilderHrefParams, view: BuilderView): string
  export function BuilderToolbar(props: BuilderToolbarProps): ReactNode
  ```

**The URL contract, which must not change.** The Builder has one department, one term, and the user is doing one of three jobs, but that single choice is currently spread across two independent params. The control unifies the UI while emitting exactly the params already in use:

| View value | Emitted params |
| --- | --- |
| `day` | neither `view` nor `mode` |
| `grid` | `view=grid` |
| `availability` | `mode=availability` |

Reading stays tolerant of today's combinations: `mode=availability` selects Availability regardless of `view`, exactly as the page behaves now, so an existing bookmark of the form `?view=grid&mode=availability` still resolves to the same screen.

- [ ] **Step 1: Write the failing test**

Create `src/modules/schedule/components/builder-toolbar.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { resolveBuilderView, builderViewHref } = await import("./builder-toolbar");

describe("resolveBuilderView", () => {
  it("selects Day when neither param is present", () => {
    expect(resolveBuilderView(undefined, undefined)).toBe("day");
  });

  it("selects Grid for view=grid", () => {
    expect(resolveBuilderView("grid", undefined)).toBe("grid");
  });

  it("selects Availability for mode=availability", () => {
    expect(resolveBuilderView(undefined, "availability")).toBe("availability");
  });

  // Preserves today's behaviour: the availability editor shows "over either
  // view", so an existing bookmark carrying both params must still resolve to
  // Availability rather than Grid.
  it("lets mode=availability win over view=grid, so old deep links still resolve", () => {
    expect(resolveBuilderView("grid", "availability")).toBe("availability");
  });

  it("ignores an unrecognised view value and falls back to Day", () => {
    expect(resolveBuilderView("banana", undefined)).toBe("day");
  });
});

describe("builderViewHref", () => {
  const base = { dept: "d1", date: "2026-09-20", term: "t1" };

  it("emits neither view nor mode for Day", () => {
    const href = builderViewHref("/schedule/builder", base, "day");
    expect(href).not.toContain("view=");
    expect(href).not.toContain("mode=");
    expect(href).toContain("dept=d1");
  });

  it("emits only view=grid for Grid", () => {
    const href = builderViewHref("/schedule/builder", base, "grid");
    expect(href).toContain("view=grid");
    expect(href).not.toContain("mode=");
  });

  it("emits only mode=availability for Availability", () => {
    const href = builderViewHref("/schedule/builder", base, "availability");
    expect(href).toContain("mode=availability");
    expect(href).not.toContain("view=");
  });

  it("carries the selected department, date, and term through every view change", () => {
    for (const view of ["day", "grid", "availability"] as const) {
      const href = builderViewHref("/schedule/builder", base, view);
      expect(href).toContain("dept=d1");
      expect(href).toContain("term=t1");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_sched_redesign \
  npx vitest run src/modules/schedule/components/builder-toolbar.test.tsx
```

Expected: FAIL, cannot resolve `./builder-toolbar`.

- [ ] **Step 3: Write the toolbar**

Create `src/modules/schedule/components/builder-toolbar.tsx`:

```tsx
/**
 * Builder toolbar: department, working term, and the view selector.
 *
 * The Builder has one department, one term, and the user is doing exactly one
 * of three jobs. That single choice used to be spread across two independent
 * URL params (`view` and `mode`) with nothing on screen saying so. This control
 * presents it as one selector while emitting the params unchanged, so every
 * existing bookmark and emailed deep link still resolves.
 *
 * Server component: no "use client" directive.
 */

import Link from "next/link";
import { Button } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { NavForm } from "@/platform/ui/nav-form";
import { TermSwitcher } from "@/platform/ui/term-switcher";
import type { TermOption } from "@/platform/terms/term-options";
import { cx } from "@/platform/ui/cx";

export type BuilderView = "day" | "grid" | "availability";

export type BuilderHrefParams = {
  dept?: string | null;
  date?: string | null;
  term?: string | null;
  gmode?: string | null;
};

/**
 * Map the raw query params onto the single view the user is in.
 *
 * `mode=availability` wins over `view` because that is how the page behaves
 * today (the availability editor renders "over either view"), and changing it
 * would silently redirect existing links.
 */
export function resolveBuilderView(view: string | undefined, mode: string | undefined): BuilderView {
  if (mode === "availability") return "availability";
  if (view === "grid") return "grid";
  return "day";
}

/** Build a href that selects `view` while preserving department, date, and term. */
export function builderViewHref(base: string, p: BuilderHrefParams, view: BuilderView): string {
  const params = new URLSearchParams();
  if (p.dept) params.set("dept", p.dept);
  if (p.date) params.set("date", p.date);
  if (view === "grid") params.set("view", "grid");
  if (view === "availability") params.set("mode", "availability");
  // gmode only means anything inside Grid; dropping it elsewhere keeps a stale
  // shadow mode from riding along into a view that ignores it.
  if (view === "grid" && p.gmode) params.set("gmode", p.gmode);
  if (p.term) params.set("term", p.term);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

const VIEW_LABELS: Array<{ value: BuilderView; label: string }> = [
  { value: "day", label: "Day" },
  { value: "grid", label: "Grid" },
  { value: "availability", label: "Availability" },
];

export type BuilderToolbarProps = {
  departments: Array<{ id: string; code: string; name: string }>;
  selectedDeptId: string;
  hrefParams: BuilderHrefParams;
  view: BuilderView;
  termOptions: TermOption[];
  workingTermId: string;
  liveTermId: string | null;
  hrefForTerm: (termId: string | null) => string;
};

export function BuilderToolbar({
  departments,
  selectedDeptId,
  hrefParams,
  view,
  termOptions,
  workingTermId,
  liveTermId,
  hrefForTerm,
}: BuilderToolbarProps) {
  return (
    <div className="mb-6 flex flex-wrap items-end gap-x-6 gap-y-4 rounded-2xl border border-border bg-muted px-4 py-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Department</span>
        <NavForm action="/schedule/builder" className="flex items-center gap-2">
          {hrefParams.date && <input type="hidden" name="date" value={hrefParams.date} />}
          {view === "grid" && <input type="hidden" name="view" value="grid" />}
          {view === "availability" && <input type="hidden" name="mode" value="availability" />}
          {view === "grid" && hrefParams.gmode && <input type="hidden" name="gmode" value={hrefParams.gmode} />}
          {hrefParams.term && <input type="hidden" name="term" value={hrefParams.term} />}
          <Select name="dept" aria-label="Department" defaultValue={selectedDeptId}>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.code} - {d.name}</option>
            ))}
          </Select>
          <Button type="submit" variant="outline" size="sm">Go</Button>
        </NavForm>
      </div>

      {/*
        No label wrapper here. TermSwitcher already renders its own "Term"
        eyebrow inside a nav[aria-label="Working term"], so adding one would
        print the word twice.
      */}
      <TermSwitcher
        options={termOptions}
        selectedId={workingTermId}
        liveTermId={liveTermId}
        hrefForTerm={hrefForTerm}
      />

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">View</span>
        <div className="inline-flex overflow-hidden rounded-lg border border-border bg-surface">
          {VIEW_LABELS.map(({ value, label }) => (
            <Link
              key={value}
              href={builderViewHref("/schedule/builder", hrefParams, value)}
              aria-current={view === value ? "page" : undefined}
              className={cx(
                "inline-flex items-center min-h-11 px-3 py-1.5 text-sm font-medium transition-colors border-l border-border first:border-l-0",
                view === value ? "bg-brand text-white" : "text-muted-foreground hover:text-foreground-soft",
              )}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_sched_redesign \
  npx vitest run src/modules/schedule/components/builder-toolbar.test.tsx
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Wire the page to PageHeader and the toolbar**

In `src/app/(app)/schedule/builder/page.tsx`, replace the hero block, the standalone `TermSwitcher` wrapper, and the standalone publish-control block with:

```tsx
<div className="mb-6">
  <PageHeader
    title="Schedule Builder"
    description={`${dept.name} · ${workingTerm.name}${
      showPublishControl ? (deptPublished ? " · Published" : " · Not published") : ""
    }`}
    action={
      showPublishControl ? (
        deptPublished ? (
          <form action={unpublishAction}>
            <ConfirmButton
              label="Unpublish"
              confirmLabel={`Unpublish ${dept.code}'s ${workingTerm.name} schedule?`}
            />
          </form>
        ) : (
          <form action={publishAction}>
            <Button type="submit" variant="primary" size="sm">
              {`Publish ${dept.code}'s ${workingTerm.name} schedule`}
            </Button>
          </form>
        )
      ) : undefined
    }
  />
</div>

<BuilderToolbar
  departments={data.departments}
  selectedDeptId={dept.id}
  hrefParams={{ dept: dept.id, date: dateParam, term: termParam, gmode: gmode === "assign" ? null : gmode }}
  view={builderView}
  termOptions={termOptions}
  workingTermId={workingTerm.id}
  liveTermId={liveTerm?.id ?? null}
  hrefForTerm={(termId) => buildHref("/schedule/builder", { dept: dept.id, view, mode, gmode, term: termId ?? undefined })}
/>
```

Add `const builderView = resolveBuilderView(sp.view, sp.mode);` near the existing param parsing, and keep the existing `view`, `mode`, and `gmode` variables: the rest of the page and `buildHref` still read them, and this task must not change what the page does with them.

Replace the date-strip block with `ClinicDateStrip`, keeping the existing condition that hides it in Grid and Availability views:

```tsx
{clinicDates.length > 0 && builderView === "day" && (
  <div className="mb-6">
    <ClinicDateStrip
      dates={clinicDates}
      selectedKey={selectedDateKey}
      hrefFor={(key) => href({ date: key })}
      ariaLabel="Clinic dates"
    />
  </div>
)}
```

Keep the archived read-only banner exactly as it is.

- [ ] **Step 6: Update the e2e selector this task breaks**

In `e2e/schedule.spec.ts`, line 210 currently reads:

```ts
await expect(page.locator("p", { hasText: "Schedule Builder" })).toBeVisible();
```

This matched only the maroon hero's `<p>` eyebrow. Replace with:

```ts
await expect(page.getByRole("heading", { name: "Schedule Builder" })).toBeVisible();
```

`select[name="dept"]`, the `Go` button, and `nav[aria-label="Clinic dates"]` are all preserved by the toolbar and `ClinicDateStrip`, so their selectors need no change. Confirm by running the suite.

- [ ] **Step 7: Run the checks**

```bash
npm run typecheck && npx eslint src e2e
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
AUTH_SECRET=ci-only-secret \
npx playwright test e2e/schedule.spec.ts --workers=1 --reporter=line
```

- [ ] **Step 8: Manually confirm the URL contract**

Load each of these and confirm the expected view renders:

| URL | Expected |
| --- | --- |
| `/schedule/builder?dept=<id>` | Day view |
| `/schedule/builder?dept=<id>&view=grid` | Grid view |
| `/schedule/builder?dept=<id>&mode=availability` | Availability view |
| `/schedule/builder?dept=<id>&view=grid&mode=availability` | Availability view (the old combination still resolves) |

- [ ] **Step 9: Commit**

```bash
git add src/modules/schedule/components/builder-toolbar.tsx \
        src/modules/schedule/components/builder-toolbar.test.tsx \
        src/app/\(app\)/schedule/builder/page.tsx e2e/schedule.spec.ts
git commit -m "feat(schedule): unify the builder's view controls into one labelled toolbar"
```

---

## Task 6: Announce Grid shadow mode

**Files:**
- Modify: `src/app/(app)/schedule/builder/page.tsx`
- Modify: `src/modules/schedule/components/builder-grid.tsx`

**Interfaces:**
- Consumes: `Alert` from `@/platform/ui/alert`.
- Produces: nothing later tasks depend on.

`gmode=shadow` changes what every empty-cell click does, and the only thing saying so is a small grey `Assigning as:` strip that is easy to leave set and not notice. The default (Volunteer) stays completely quiet; only the non-default mode announces itself, so nothing is added to the common path.

- [ ] **Step 1: Replace the Grid mode strip**

In `builder/page.tsx`, replace the `{/* View toggle */}` block above `<BuilderGrid>` (the `Assigning as:` row) with:

```tsx
<div className="mb-4 flex flex-col gap-3">
  {gmode === "shadow" && (
    <Alert tone="warning">
      Clicking an empty cell assigns a <strong>Shadow</strong>, not a volunteer.
    </Alert>
  )}
  <div className="flex items-center gap-3">
    <span className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Clicks assign</span>
    <div className="inline-flex overflow-hidden rounded-lg border border-border bg-surface">
      <Link
        href={href({ gmode: "assign" })}
        aria-current={gmode === "assign" ? "page" : undefined}
        className={cx(
          "inline-flex items-center min-h-11 px-3 py-1.5 text-sm font-medium transition-colors",
          gmode === "assign" ? "bg-brand text-white" : "text-muted-foreground hover:text-foreground-soft",
        )}
      >
        Volunteer
      </Link>
      <Link
        href={href({ gmode: "shadow" })}
        aria-current={gmode === "shadow" ? "page" : undefined}
        className={cx(
          "inline-flex items-center min-h-11 border-l border-border px-3 py-1.5 text-sm font-medium transition-colors",
          gmode === "shadow" ? "bg-warning text-warning-foreground" : "text-muted-foreground hover:text-foreground-soft",
        )}
      >
        Shadow
      </Link>
    </div>
  </div>
</div>
```

Add `import { Alert } from "@/platform/ui/alert";` and `import { cx } from "@/platform/ui/cx";`.

- [ ] **Step 2: Tint the grid while shadow mode is active**

In `src/modules/schedule/components/builder-grid.tsx`, the `BuilderGrid` component's returned wrapper is:

```tsx
<div className="overflow-x-auto rounded-2xl border border-border">
```

Change it to carry the mode, so the grid itself shows the state rather than only the control above it:

```tsx
<div
  className={cx(
    "overflow-x-auto rounded-2xl border",
    mode === "shadow" ? "border-warning bg-warning/5" : "border-border",
  )}
>
```

`BuilderGrid` already destructures `mode: "assign" | "shadow"` from its props, so no signature change is needed. This file does **not** currently import `cx`, so add `import { cx } from "@/platform/ui/cx";`.

Leave the early return for the empty case (`<p>No members in this department.</p>`) untouched: there is no grid to tint.

- [ ] **Step 3: Run the checks**

```bash
npm run typecheck && npx eslint src e2e
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_sched_redesign \
  npx vitest run src/modules/schedule
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
AUTH_SECRET=ci-only-secret \
npx playwright test e2e/schedule.spec.ts --workers=1 --reporter=line
```

- [ ] **Step 4: Manually confirm both modes**

Load `/schedule/builder?dept=<id>&view=grid` and confirm no banner appears. Load `/schedule/builder?dept=<id>&view=grid&gmode=shadow` and confirm the banner, the warning-toned control, and the tinted grid all appear together.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/schedule/builder/page.tsx src/modules/schedule/components/builder-grid.tsx
git commit -m "feat(schedule): make grid shadow mode announce itself"
```

---

## Task 7: Supporting component cohesion

**Files:**
- Modify: `src/modules/schedule/components/pending-requests.tsx`
- Modify: `src/modules/schedule/components/capacity-panel.tsx`
- Modify: `src/modules/schedule/components/readiness-panel.tsx`
- Modify: `src/modules/schedule/calendar/subscribe-card.tsx`

**Interfaces:** none. Each change is local to its file.

These four components carry the module's last raw headings. Each keeps its heading level and visible text, so no e2e selector moves.

- [ ] **Step 1: pending-requests.tsx**

There are two raw `<h2 className="text-sm font-semibold text-foreground-soft">Pending Requests</h2>` headings, one in the empty-state early return and one in the main body. Replace both with:

```tsx
<SectionHeader as="h2" level="title" className="text-sm">Pending Requests</SectionHeader>
```

`SectionHeader` is already imported in this file. Keep the text exactly `Pending Requests`: `e2e/schedule.spec.ts` scopes two assertions on an `h2` with that text. In the main body, keep the `Badge` sibling inside the same flex row rather than nested inside the heading.

- [ ] **Step 2: capacity-panel.tsx**

Replace `<h2 className="text-sm font-semibold text-foreground-soft">Capacity</h2>` with:

```tsx
<SectionHeader as="h2" level="title" className="text-sm">Capacity</SectionHeader>
```

Add `import { SectionHeader } from "@/platform/ui/section-header";`.

- [ ] **Step 3: readiness-panel.tsx**

Replace `<h2 className="text-sm font-semibold text-foreground-soft">RHD Clinic Readiness</h2>` (line 78) with:

```tsx
<SectionHeader as="h2" level="title" className="text-sm">RHD Clinic Readiness</SectionHeader>
```

Add `import { SectionHeader } from "@/platform/ui/section-header";`.

- [ ] **Step 4: subscribe-card.tsx**

Replace `<h3 className="text-base font-semibold text-foreground">Your shifts in your calendar</h3>` (line 39) with:

```tsx
<SectionHeader as="h3" level="title">Your shifts in your calendar</SectionHeader>
```

Add `import { SectionHeader } from "@/platform/ui/section-header";`.

Note the level: this heading is an `h3` today, and `as="h3"` keeps it there. This card renders on **My Info as well as My Schedule**, and changing its level would shift the outline on two pages at once for no visual gain. `level="title"` reproduces its current `text-base font-semibold` styling exactly.

- [ ] **Step 5: The Builder's two early-return heroes**

Added after the Task 5 review found these: the main Builder return lost its hero in Task 5, but two early returns still carry one, and Task 8 Step 1 greps for `rounded-2xl bg-brand` expecting no matches.

In `src/app/(app)/schedule/builder/page.tsx` there are two blocks at roughly lines 154 and 179, the "No active term" and "No departments" early returns, each of the shape:

```tsx
<div className="rounded-2xl bg-brand px-8 py-6 text-white mb-8">
  <p className="text-xs font-semibold uppercase tracking-widest text-white/60 mb-1">Schedule Builder</p>
  <h1 className="text-2xl font-bold tracking-tight">No active term</h1>
</div>
```

Replace each with the shared header, preserving its own message:

```tsx
<div className="mb-8">
  <PageHeader title="Schedule Builder" description="No active term" />
</div>
```

and correspondingly `description="No departments"` for the second. `PageHeader` is already imported in this file from Task 5. Keep whatever body each early return renders beneath its hero unchanged.

- [ ] **Step 6: The Approvals term heading**

In `src/app/(app)/schedule/requests/page.tsx` line 113, replace:

```tsx
<h2 className="text-xl font-bold tracking-tight text-foreground">{term.name}</h2>
```

with:

```tsx
<SectionHeader as="h2" level="title" className="text-xl">{term.name}</SectionHeader>
```

`SectionHeader` is already imported in this file.

- [ ] **Step 7: The day view's two column headings**

In `src/modules/schedule/components/builder-day-view.tsx`, replace line 167:

```tsx
<h2 className="text-base font-bold text-foreground">Assigned</h2>
```

with:

```tsx
<SectionHeader as="h2" level="title">Assigned</SectionHeader>
```

and line 313 the same way for `Available to assign`. Add `import { SectionHeader } from "@/platform/ui/section-header";`.

**The visible text of both must stay exactly `Assigned` and `Available to assign`.** `e2e/schedule.spec.ts` scopes five separate assertions on `h2` elements with those texts, including an anchored `/^Assigned$/`. `SectionHeader as="h2"` still renders an `h2` element with the same children, so those selectors keep resolving, but a reworded label would break them.

- [ ] **Step 8: Run the checks**

```bash
npm run typecheck && npx eslint src e2e
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_sched_redesign \
  npx vitest run src/modules/schedule src/app
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
AUTH_SECRET=ci-only-secret \
npx playwright test e2e/schedule.spec.ts e2e/my-info.spec.ts --workers=1 --reporter=line
```

`my-info.spec.ts` is included because the subscribe card renders there too.

- [ ] **Step 9: Confirm the sweep greps Task 8 will run now pass**

```bash
grep -rn "rounded-2xl bg-brand" src/ || echo "CLEAN: no hand-rolled heroes remain"
grep -rn '<h[123] className' "src/app/(app)/schedule" src/modules/schedule || echo "CLEAN: no raw headings remain"
```

Both must print their `CLEAN` line. If either still reports a match, this task is not finished.

- [ ] **Step 10: Commit**

```bash
git add src/modules/schedule/components/pending-requests.tsx \
        src/modules/schedule/components/capacity-panel.tsx \
        src/modules/schedule/components/readiness-panel.tsx \
        src/modules/schedule/calendar/subscribe-card.tsx \
        src/modules/schedule/components/builder-day-view.tsx \
        src/app/\(app\)/schedule/builder/page.tsx \
        src/app/\(app\)/schedule/requests/page.tsx
git commit -m "refactor(schedule): move the remaining headings onto the shared primitives"
```

---

## Task 8: Divergence sweep and full verification

**Files:**
- Modify: any file the sweep finds still diverging.

**Interfaces:** none.

The spec's audit gave exact counts. This task proves they reached zero and that nothing outside the presentation layer moved.

- [ ] **Step 1: Confirm the hand-rolled heroes are gone**

```bash
grep -rn "rounded-2xl bg-brand" src/ || echo "CLEAN: no hand-rolled heroes remain"
```

Expected: `CLEAN`. The spec counted three, all in the schedule module.

- [ ] **Step 2: Confirm the raw headings are gone from the schedule module**

```bash
grep -rn '<h[123] className' "src/app/(app)/schedule" src/modules/schedule || echo "CLEAN: no raw headings remain"
```

Expected: `CLEAN`. The spec counted 16.

- [ ] **Step 3: Confirm the date strip is no longer duplicated**

```bash
grep -rn 'aria-label="Clinic dates"\|aria-label="Schedule dates"' src/
```

Expected: exactly two matches, both passing the label as a prop to `ClinicDateStrip`, and neither one a `<nav>` literal in a page file.

- [ ] **Step 4: Confirm the presentation-only claim held**

```bash
git diff --stat origin/main -- src/modules/schedule/services src/modules/schedule/engine prisma/
```

Expected: **empty output**. Any change here means the work outgrew the spec and must be raised before merging.

- [ ] **Step 5: Run the full unit suite**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_sched_redesign npm test
```

Expected: zero failures. Record the file and test counts and compare them against the baseline captured before Task 1: the totals should differ only by the tests this plan added (6 in Task 1, 9 in Task 5).

- [ ] **Step 6: Run the full e2e suite**

```bash
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_test \
AUTH_SECRET=ci-only-secret \
npx playwright test --workers=1 --reporter=line
```

The whole suite, not just `schedule.spec.ts`: `smoke`, `command-palette`, and `global-nav` all navigate to `/schedule`, and the spec predicted they need no changes. Verify that rather than assuming it.

- [ ] **Step 7: Check both themes**

Load `/schedule`, `/schedule/full`, and `/schedule/builder` in light and dark. Confirm no element relies on a hardcoded `text-white` outside a brand-filled control, and that text on the `bg-muted` toolbar and card headers stays legible in both.

- [ ] **Step 8: Final gates and commit**

```bash
npm run typecheck && npx eslint src e2e && npm run build
```

```bash
git add -A
git commit -m "chore(schedule): verify the redesign left services, engine, and schema untouched"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: shared primitive adoption (Tasks 2, 3, 5, 7); `ClinicDateStrip` (Task 1, consumed in 2 and 5); My Schedule (Task 3); Full Schedule (Task 2); Builder state model and chrome (Task 5); Grid announcement (Task 6); Approvals and Attendings supporting components (Task 7); file decomposition (Task 4); the "what does not change" guarantees (Task 8, Steps 1 to 4); e2e churn (distributed across Tasks 2, 3, 5, and verified whole in Task 8).

**Type consistency.** `ClinicDateStripProps` is defined once in Task 1 and consumed with the same four props in Tasks 2 and 5. `BuilderView`, `BuilderHrefParams`, `resolveBuilderView`, and `builderViewHref` are defined in Task 5 and used only there. `IntakeNotes`, `BuilderAvailabilityView`, and `BuilderDayView` are produced in Task 4 and composed in Task 5.

**Ordering.** Task 4 (pure move, no output change) deliberately precedes Task 5 (redesign) so a reviewer can verify the risky extraction against an unchanged e2e suite before any markup shifts underneath it.
