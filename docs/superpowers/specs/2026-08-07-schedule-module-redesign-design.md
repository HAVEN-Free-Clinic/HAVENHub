# Schedule Module Redesign

**Date:** 2026-08-07
**Status:** Approved for planning
**Branch:** `feat/schedule-redesign`

## Problem

The schedule module looks and reads as though it belongs to a different, older
application than the rest of HAVEN Hub. The complaint is about layout and look
across the whole module, not about a specific broken workflow.

## Root cause

This is not an accumulation of bad taste calls. The schedule module is the only
part of the application that never got the UI cohesion pass. It hand-rolls
markup for which shared components already exist and are used everywhere else.

Audit of the current tree:

| Hand-rolled in schedule | Count | Shared component that exists |
| --- | --- | --- |
| `rounded-2xl bg-brand` hero block | 3 pages | `PageHeader`, used by **75** pages app-wide |
| Raw `<h2 className=...>` headings | 16 | `SectionHeader` |
| Uppercase `tracking-wide` micro-labels | 18 | `SectionHeader level="eyebrow"` |
| Hand-rolled `rounded-full` chips | 12 | `Badge` (count chips only, see below) |
| "This Term" figures as flex rows | 1 | `StatCard` |
| Clinic-date strip markup | 2 pages | none yet, must be created |

The three pages carrying the maroon hero are exactly the three surfaces flagged
as looking wrong: My Schedule, Full Schedule, Builder. The two schedule pages
that already use `PageHeader` (Approvals, Attendings) were not flagged.

The maroon hero also sits directly beneath the maroon `ModuleNav` tab row, so
the top of every one of those pages is two stacked brand-coloured bands.

Note on the pills: `Badge` renders a `rounded-md` chip with a status dot, not a
pill. It is the right replacement for count chips, but **not** for the clinic
date strips, which are navigation controls. Those need a new shared component.

## Scope

Cohesion pass plus relayout across all five surfaces. This is the middle of
three options considered; the rejected third option additionally introduced a
calendar view and person search on Full Schedule, which is deferred (see Out of
Scope).

## Design

### 1. Shared primitive adoption

Applies to every surface:

- Replace the three hand-rolled heroes with `PageHeader`.
- Replace raw headings with `SectionHeader` (`title` or `eyebrow` level),
  choosing `as` so the document outline never skips or reverses a level.
- Replace count chips with `Badge`.
- Use `Card` / `cardClasses` rather than hand-rolled `rounded-2xl border
  bg-surface`.
- Every surface must render correctly in both light and dark themes and meet
  the WCAG contrast requirements the neutral tokens encode. The maroon hero
  hardcoded `text-white`; replacements use semantic tokens.

### 2. New shared component: `ClinicDateStrip`

**File:** `src/modules/schedule/components/clinic-date-strip.tsx`

The date strip is currently duplicated between `full/page.tsx` and
`builder/page.tsx` as copy-pasted class strings. Extract one component.

- Groups dates by month with a small month label, replacing the current single
  undifferentiated wrap of 15 to 20 pills.
- Props: `dates`, `selectedKey`, `hrefFor(key)`, `ariaLabel`.
- `ariaLabel` stays a prop rather than a constant. The two call sites currently
  use different labels (`"Schedule dates"` on Full Schedule, `"Clinic dates"` on
  Builder) and those labels remain accurate to their pages.
- Preserves `aria-current="page"` on the selected date and the existing
  `min-h-11` touch target.

### 3. My Schedule (`/schedule`)

The largest layout change.

- `PageHeader` with title `"My Schedule"`, description `"<Term> - <department
  list>"`, and an "Add to calendar" action-slot control. It is an in-page anchor
  to the existing `CalendarSubscribeSection` rather than a second copy of the
  subscribe controls, so the token-issuing and reset server actions keep exactly
  one call site.
- The `1fr / 320px` two-column split is removed. The right column held a single
  "This Term" card whose contents (shift count, role, departments) restated the
  hero. Content becomes a single full-width column, which also improves the
  narrow-viewport rendering.
- Those figures become a row of `StatCard`s directly under the header, changed
  to carry information the header does not: **Shifts** (count of this term's
  assignments), **Available dates** (how many clinic dates the member has marked
  themselves available for, over the total), **Pending requests**. Role and
  department move into the header description.
- Shifts split into three groups:
  - **Next shift**: the first upcoming shift, in an emphasised `Card`, showing
    the clinic window and address. Both are already available as settings from
    the calendar feed work (`schedule.clinicStartTime`, `schedule.clinicEndTime`,
    `schedule.clinicAddress`). The address is omitted for a shift tagged remote,
    matching the rule the ICS feed already applies.
  - **Later this term**: remaining upcoming shifts, ascending.
  - **Past shifts**: collapsed into a `<details>` fold, descending, labelled
    with a count. Today past shifts sit inline between upcoming ones.
- Availability keeps its month grouping and gains a count in the section header
  (`"My availability - 5 of 11 dates"`), so a member can see at a glance whether
  they have actually set anything.

The availability editor's guard rails are behaviour and are preserved exactly:
the director-override read-only block, the `allDepartmentsOverridden` case that
withholds the editor, and the empty-`clinicDates` case that refuses to offer a
destructive Save.

### 4. Full Schedule (`/schedule/full`)

- `PageHeader` replaces the hero. The date being viewed moves from the page
  title to a `SectionHeader` above the department grid, so the page title is
  stable rather than changing every time a date is clicked.
- `ClinicDateStrip` replaces the flat pill wrap.
- Department cards lose their `bg-brand` cap. The header row becomes a neutral
  surface with the department name spelled out and the code plus headcount as
  `Badge`s. Brand colour returns to meaning "selected" rather than doing
  structural work.
- Directors / Volunteers / Shadows group labels become `SectionHeader`
  eyebrows.

### 5. Builder (`/schedule/builder`)

**The state model is the core fix.** The Builder has one department, one term,
and the user is doing exactly one of three jobs. Today that single choice is
spread across two independent URL params, with a third that only has meaning
inside one of them:

- `?view=grid` selects Grid, absent selects Day
- `?mode=availability` shows the availability editor over either view
- `?gmode=shadow` applies only in Grid, and changes what clicking a cell does

Changes:

- `PageHeader` with title `"Schedule Builder"`, description `"<Department> -
  <Term> - <publication status>"`, and the Publish / Unpublish control in the
  action slot. It is currently a bare button floating between the term switcher
  and the date strip.
- A single labelled toolbar (one `Card`) replaces the five controls crammed
  into the hero: **Department** (the existing `NavForm` select plus Go),
  **Term** (the existing `TermSwitcher`), and **View**.
- **View** is one segmented control with three values, Day / Grid /
  Availability, replacing two params the user had to know about.

**URLs do not change.** The control emits exactly the params already in use:

| Control value | Emitted params |
| --- | --- |
| Day | neither `view` nor `mode` |
| Grid | `?view=grid` |
| Availability | `?mode=availability` |

Reading stays tolerant of the current combinations: `mode=availability` selects
Availability regardless of `view`, exactly as today, so an existing bookmark or
emailed deep link of the form `?view=grid&mode=availability` still resolves to
the same screen.

- **Grid assign-role announcement.** `gmode=shadow` silently changes what every
  click does, signalled only by a small grey strip that is easy to leave set and
  not notice. When and only when `gmode=shadow` is active, render an `Alert`
  above the grid stating that clicks assign a Shadow, give the segmented control
  the warning tone, and tint the grid. The Volunteer default stays quiet with no
  banner, so nothing is added to the common path.

### 6. Approvals and Attendings

Light touch. Both already use `PageHeader`. Bring their supporting components in
line: `pending-requests.tsx` (2 raw headings), `capacity-panel.tsx`,
`readiness-panel.tsx`, and `calendar/subscribe-card.tsx` (1 each). That last one
also renders on My Info, so its heading level must stay correct on both hosts.

### 7. File decomposition

`src/app/(app)/schedule/builder/page.tsx` is 1,165 lines and holds an entire
availability sub-view at the bottom. Any real layout change there requires
splitting it. The page retains data loading and the server-action definitions;
presentation moves into `src/modules/schedule/components/`:

- `builder-toolbar.tsx`
- `builder-day-view.tsx` (the Assigned and Available columns)
- `builder-availability-view.tsx` (current `AvailabilityView`)
- `intake-notes.tsx` (current `IntakeNotes`, used by both of the above)

Server actions continue to be defined in the page and passed as props, matching
the existing pattern already used by `BuilderGrid`, `CapacityPanel`, and
`ReadinessPanel`. This keeps the module-boundary rules satisfied:
`src/modules/schedule` may import `src/platform` and may not import another
module.

## What does not change

This is deliberately a presentation-layer project. Out of the roughly 12,700
lines in the module, the parts carrying the business rules are untouched:

- **No changes** to `src/modules/schedule/services/**` or
  `src/modules/schedule/engine/**`.
- No changes to any server action's signature or behaviour.
- No changes to URL routes or query parameters.
- No changes to permissions, gates, or the `ScheduleLayout` dynamic tab
  filtering.
- No database or Prisma schema changes.

Their existing unit tests (the bulk of the module's test lines) therefore stay
untouched and green throughout, and are the safety net proving the redesign is
presentation-only.

## Testing

### Unit

Component-level tests follow the codebase convention of
`renderToStaticMarkup`. There is no `@testing-library/react` in this repo.

New tests are needed for `ClinicDateStrip`: month grouping, selected state and
`aria-current`, and the `ariaLabel` prop.

### End-to-end: the main risk

`e2e/schedule.spec.ts` is 653 lines and is welded to the current markup. It will
break by construction, not by accident. Confirmed brittle selectors:

- `page.locator("p", { hasText: "Schedule Builder" })` and the same pattern for
  `"Full Schedule"`. These match only because the maroon hero has a `<p>`
  eyebrow above the `<h1>`. `PageHeader` has no eyebrow, so removing the hero
  breaks them.
- `div.rounded-2xl` used to find member cards. Breaks if a card moves to
  `size="compact"` (which is `rounded-xl`).
- `span.font-semibold` and `span.font-medium` used to find members by name.
  Breaks on any font-weight change.
- `h2` filters for `"Assigned"`, `"Available to assign"`, `"My shifts"`,
  `"My availability"`, `"Pending Requests"`. Break if a heading changes level.
- `nav[aria-label="Clinic dates"]` and `nav[aria-label="Schedule dates"]`.
  Preserved by keeping `ariaLabel` a prop on `ClinicDateStrip`.

Updating this spec file is a first-class task, not cleanup. Selectors should be
rewritten toward role and accessible name (`getByRole("heading", { name: ... })`),
with `data-testid` added only where role and text are genuinely ambiguous.
Rewriting them to assert on presentation classes again would rebuild the same
trap.

Other specs (`smoke`, `command-palette`, `global-nav`, `recruitment-interviews`,
`support-tech-requests`) reference `/schedule` only as a navigation target and
assert nothing about its internals. They should need no changes, which is worth
verifying rather than assuming.

### Full-suite gates

`npm run typecheck`, `npx eslint src e2e` (the plain `npm run lint` walks a
gitignored design-system directory), and the full vitest suite.

## Out of scope

- **Full Schedule calendar view and person search.** The earlier options
  included a month-grid term overview and a person search answering "when does
  person X work". Deferred to its own project.
- **Any change to how assignment works.** The per-person server-action round
  trip stays as it is.
- **The remaining lookup complaint on My Schedule** is addressed incidentally by
  the next-shift emphasis, but no new data or query is introduced for it.

## Risks

1. **E2E churn is the largest single piece of work after the Builder split.**
   It is mechanical but wide, and the suite runs serially in CI, so a broken
   selector costs a full run to discover.
2. **The Builder split touches a 1,165-line file** that holds the module's most
   intricate behaviour (remount keys on `selectedDateKey` and on the
   availability signature, both fixing real bugs). Those `key` props must
   survive the move; losing them silently reintroduces the stale-form bugs.
3. **Presentation-only is a claim that must stay true.** If a task finds itself
   editing a service or an engine file, that is a signal the change has grown
   beyond this spec and should be raised rather than absorbed.
