# Navigation IA and User-Friendliness Pass: Design

**Date:** 2026-07-26
**Status:** Approved (design); pending spec review
**Branch:** design/nav-ia-user-friendliness

Extends `2026-06-09-app-navigation-wayfinding-design.md`, which introduced the
three-layer model (global module switcher, breadcrumb, section tabs). That model
still holds. This spec fixes what it did not anticipate: the app has since grown
from 4 modules to 9, and from two levels of depth to four.

## Problem

Features are buried deep enough that people cannot find them. Four distinct
causes, all confirmed with the product owner:

### 1. Pages with no navigation entry at all

- **`/training`** appears in no module's `nav` and in no `MODULES` entry. The only
  ways in are the dashboard action card and a "Your status" row
  (`src/app/(app)/page.tsx:116`). A member already inside another module must
  return to the hub to reach their own training.
- **`/admin/contract`** (the onboarding contract editor) is reachable only from
  the Admin overview's `quickLinks` row (`src/app/(app)/admin/page.tsx:65`). It
  is absent from the Admin module nav, so it disappears the moment you leave the
  overview page.

### 2. The top nav hides modules from exactly the users with the most to do

`GlobalNav` measures its items and collapses the overflow into a "More" dropdown
(`src/platform/ui/global-nav.tsx:48-78`). The nine module titles total 104
characters, so a director or admin who can access everything sees four or five
of their modules pushed behind a dropdown. Access breadth is inversely related
to nav visibility.

### 3. Depth beyond two levels has no navigation at all

A recruitment cycle is a workspace with eleven sub-pages, but there is no
`cycles/[id]/layout.tsx`. The cycle overview instead renders a flat wall of nine
visually identical outline buttons (`cycles/[id]/page.tsx:93-117`), and every
sub-page requires bouncing back to the overview to reach a sibling. Speed route
is worse still: it is linked only from the applicants page
(`cycles/[id]/applicants/page.tsx:108`), one level below the workspace it
belongs to.

### 4. No way to jump directly to anything

There is no global search and no command palette. Nothing in `src/platform/ui/`
provides one and there is no `cmdk` dependency. Reaching any of roughly 60 pages
means clicking down through the hierarchy.

### 5. Three competing tab idioms

Users learn one and then meet another:

| Idiom | Example |
|---|---|
| Registry `nav` rendered by `ModuleNav` | Admin, Schedule, Volunteers |
| Inline button row | Cycle overview, Admin overview |
| `?tab=` query param | `/support/epic` |

## Goal

Every feature reachable in at most two deliberate actions from anywhere, using
one consistent navigation idiom, without abandoning the floating glass pill
(`2026-06-14-liquid-glass-design.md`) or the persistent app shell
(`2026-06-13-persistent-app-shell-design.md`).

## Non-goals

- No left sidebar. Rejected in the 2026-06-09 spec and rejected again here; the
  glass pill stays the primary nav surface.
- No entity search (people, cycles, requests) in this pass. See Stage 2.
- No regrouping of the Admin tab row, which is overloaded independently of this
  work. Noted as follow-up.

## Approach

Four stages, each landing as its own reviewable PR. Work can stop cleanly after
any stage.

---

## Stage 1: the pill

### 1a. Shorten module titles

The row is 104 characters, which is why "More" fires. Renaming in
`src/platform/modules/registry.ts`:

| Current | New |
|---|---|
| Clinic Schedule | Schedule |
| Volunteer Management | Volunteers |
| Incident Reports | Incidents |
| Clinic Tools | Clinic |
| IT Support | Support |

Recruitment, Learning, Admin, and My Info are unchanged. With My Info moving to
the account menu (1c), the row becomes 8 items totalling 64 characters, roughly
610px rendered at `text-sm`, inside the roughly 820px the pill has after the logo
and the right-hand controls. "More" stops firing on a laptop for a full admin.
It remains implemented as the safety net for narrow viewports.

`title` is changed outright rather than adding a separate `navTitle`. The nav,
the breadcrumb, the dashboard tile, and the page metadata all read from `title`,
so splitting them would reintroduce the naming inconsistency this pass exists to
remove.

### 1b. Module dropdowns

`NavModule` (`src/platform/modules/nav.ts`) grows a `nav: ModuleNavItem[]` field
carrying the already permission-filtered sub-items:

```ts
export type NavModule = {
  id: string;
  title: string;
  href: string;
  nav: { label: string; href: string }[];
};
```

`filterAccessibleModules` (`src/platform/modules/access.ts`) populates it by
running the existing `filterNavItems` against the same permission set it already
holds, so no second permission fetch is introduced.

`GlobalNav` renders each module as it does today (a link to the module root) plus
a chevron disclosure button beside it. The label still navigates; only the
chevron opens the panel. This mirrors the existing "More" pattern, including its
accessibility posture: a labelled `<nav>` of links rather than an APG menu
widget, because only Tab and Escape are implemented, not arrow-key roving focus
(see the comment at `global-nav.tsx:197`).

The chevron renders only when a module has two or more visible sub-items, so
My Info and single-tab modules do not get an empty or one-item dropdown.

Only one panel may be open at a time; opening a module dropdown closes "More"
and vice versa. Escape closes the open panel and restores focus to its trigger,
matching the existing handler at `global-nav.tsx:126-141`.

**Dynamic nav items.** Recruitment's "My interviews" tab is gated on interview
panel membership, not on a permission, so it cannot flow through the registry's
permission-based `filterNavItems`. It is resolved today in
`src/app/(app)/recruitment/layout.tsx` via `recruitmentNavItems`. For the global
dropdown to show it, `src/app/(app)/layout.tsx` must additionally call
`isInterviewPanelist` (alongside the `reviewScope` call it already makes) and
pass the result through `AppShell` as an `extraNavItems` map keyed by module id.
`getAccessibleModules` merges it after the permission-filtered staff nav, so the
staff ordering is preserved exactly as `recruitmentNavItems` does now.

### 1c. Account menu

New client component `src/platform/ui/account-menu.tsx`, replacing the static
avatar span at `app-shell.tsx:102-114`. The avatar becomes a disclosure button
opening a `glass-panel` containing:

- The person's name, and a term plus clearance line.
- **My Info** (`/my-info`)
- **Training** (`/training`)
- The theme control, moved here from the toolbar.
- **Sign out**, which stays a server-action `<form>` exactly as at
  `app-shell.tsx:115-131`.

This is where `/training` finally gets a permanent home, and it frees two slots
in the module row (My Info and the theme toggle).

Training is listed unconditionally. `/training` already renders a sensible state
for a member with nothing assigned, and a conditional entry would make the menu
shift shape between people, which is worse than one occasionally empty page.

**The notification bell stays where it is**, as a separate icon in the toolbar.
It carries an ambient unread badge that is visible without any click, it is only
36px wide so removing it buys no meaningful pill space (the module row is the
constraint, not the right-hand controls), and burying it would cost a real signal
for no gain.

**My Info keeps its dashboard tile.** It leaves the module row, not the hub. The
hub tile grid is a directory of everything available, and `e2e/my-info.spec.ts:8`
asserts the tile exists. This is expressed as an optional `personal?: boolean`
flag on `ModuleManifest`, meaning "render in the account menu, not the module
row"; `filterAccessibleModules` excludes flagged modules from `NavModule[]` while
the dashboard continues to read `MODULES` directly.

### 1d. Orphan homes

- `/training`: the account menu (1c).
- `/admin/contract`: a real Admin nav entry, `{ label: "Onboarding contract",
  href: "/admin/contract", permission: "admin.manage_settings" }`, mirroring the
  page's own gate. The now-redundant `quickLinks` row at `admin/page.tsx:60-67`
  and its rendering at `admin/page.tsx:84-96` are removed; the stat cards stay.

This makes Admin an 11-tab row. `ModuleNav` already scrolls horizontally and
keeps the active tab in view (`module-nav.tsx:32-34`), so this is functional but
confirms the Admin nav is itself overloaded. Grouping it is deliberately out of
scope; see Follow-ups.

### Files touched

| File | Change |
|---|---|
| `src/platform/modules/registry.ts` | Short titles; `/admin/contract` nav entry; `personal: true` on my-info |
| `src/platform/modules/types.ts` | `personal?: boolean` on `ModuleManifest` |
| `src/platform/modules/nav.ts` | `nav` field on `NavModule` |
| `src/platform/modules/access.ts` | Populate `nav`; honour `personal`; accept `extraNavItems` |
| `src/platform/ui/global-nav.tsx` | Per-module dropdowns |
| `src/platform/ui/account-menu.tsx` | New |
| `src/platform/ui/app-shell.tsx` | Mount `AccountMenu`; drop the standalone `ThemeToggle`; thread `extraNavItems` |
| `src/app/(app)/layout.tsx` | Resolve `isInterviewPanelist`; pass `extraNavItems` |
| `src/app/(app)/admin/page.tsx` | Remove `quickLinks` |
| `e2e/login.spec.ts` | Tile aria-labels at lines 12-13 |

---

## Stage 2: command palette

A new client component mounted in `AppShell`, opened by `Cmd+K` / `Ctrl+K` **and**
by a visible Search affordance in the pill. The visible trigger is not optional:
a keyboard-only shortcut is just another buried feature.

**v1 indexes navigation targets only:** every accessible module, every one of its
permission-filtered sub-items, and the personal pages. That data is already
computed server-side for the Stage 1 dropdowns, so the palette costs no new query
surface, no new API route, and no new permission-leak risk. It fully solves
"jump straight to a page", which is the confirmed pain.

Matching is a simple subsequence match over `label` plus the owning module title,
so "spdrt" finds "Speed route" and "cyc" finds "Recruitment / Cycles". Results
group by module. Arrow keys move, Enter navigates, Escape closes.

**Entity search is explicitly deferred.** Searching people, cycles, and support
requests needs a new `/api/search` route with per-entity permission scoping done
server-side, which is a materially larger and riskier piece of work than the nav
index. It ships as its own follow-up PR rather than being bolted onto this one.

---

## Stage 3: cycle workspace

Add `src/app/(app)/recruitment/cycles/[id]/layout.tsx`, which does not exist
today, rendering a persistent secondary nav across every cycle sub-page:

Overview, Form, Contract, Applicants, Speed route, Waitlist, Decisions,
Subcommittees or Interviews (by track), Onboarding, Emails, Training.

Visibility is exactly the logic already inlined at `cycles/[id]/page.tsx:93-117`
and `237-245`: `canManage` (`recruitment.manage_cycles`), `canReviewAll`
(`recruitment.review_all`), and `cycle.track`. That logic is lifted into a new
pure module `src/modules/recruitment/cycle-nav.ts`, mirroring the existing
`src/modules/recruitment/nav.ts` pattern, with unit tests over the permission and
track combinations.

**Visual treatment.** On a cycle page the module tab row ("Cycles", "My
interviews") is already on screen. Two identical underline tab rows stacked would
be worse than the current button wall, so the cycle nav renders as a segmented
pill row beneath the page header, visually subordinate to `ModuleNav`. The
breadcrumb already supplies `Hub > Recruitment > Cycles > <cycle title>` via
`cycleTrail`.

The overview page then sheds its button wall and becomes an actual overview:
status, public link, application window, departments, and lifecycle actions.

---

## Stage 4: tab idiom consistency

Extract a shared `TabRow` primitive into `src/platform/ui/`, and render all three
idioms through it so they are visually identical:

- `ModuleNav` becomes a thin wrapper over `TabRow`.
- `/support/epic` keeps its `?tab=` URLs, which are shareable and worth keeping,
  but renders them through `TabRow` instead of its own `EpicRequestTabs` styling.
- The cycle nav from Stage 3 uses the segmented variant.

Documented in `docs/ui-house-style.md` alongside the other page-chrome
primitives.

---

## Testing

Unit (vitest):

- `access.test.ts`: `filterAccessibleModules` populates `nav` from filtered
  items; `personal` modules are excluded from the nav row but not from `MODULES`;
  `extraNavItems` merges after staff nav.
- `registry.test.ts`: every nav `href` resolves to a real route; every nav
  `permission` is declared in its module's `permissions`.
- New `cycle-nav.test.ts`: tab visibility across `canManage` x `canReviewAll` x
  track.
- Existing `breadcrumb-trail.test.ts` and `help-context.test.ts` carry module
  titles in local fixtures and need the renamed values.

E2E (Playwright, CI only, cannot be run locally against Neon):

- `e2e/login.spec.ts:12-13` asserts `Open Clinic Schedule` and
  `Open Volunteer Management`. Both are dashboard tile aria-labels built from
  `title`, so they change with Stage 1a.
- `e2e/my-info.spec.ts:8` asserts the My Info tile still exists. It does; this is
  the reason `personal` hides the module from the nav row only.
- `e2e/recruitment-speed-routing.spec.ts:115` clicks
  `getByRole("link", { name: /speed route/i })`. Once Stage 3 adds a Speed route
  tab, that selector matches two elements on the applicants page and fails
  Playwright strict mode. Resolution: drop the now-redundant applicants-page link
  at `applicants/page.tsx:108`, since the tab supersedes it, and leave the
  selector alone.
- New coverage: open a module dropdown and navigate to a sub-page; open the
  account menu and reach `/training`; open the palette and navigate by search.

Accessibility:

- Dropdowns and the account menu are labelled `<nav>` / disclosure patterns with
  Escape-to-close and focus restoration, consistent with the existing "More"
  menu and `NotificationBell`.
- The palette traps focus while open and returns it to the trigger on close.

## Risks

- **The nav is load-bearing and the full e2e suite runs only in CI.** Every
  selector identified above is fixed in the same PR that breaks it, and no stage
  is merged on a red suite.
- **`GlobalNav` measurement.** The hidden measurement layer
  (`global-nav.tsx:224-242`) must include the chevron width, or the overflow
  calculation under-reserves space and items clip.
- **Glass containing block.** `.glass-bar` establishes a containing block for
  `backdrop-filter`, which previously broke fixed-position overlays
  (PR #304). The dropdowns are absolutely positioned
  inside the bar exactly as the existing "More" menu is, so they are safe; the
  command palette is a full-viewport overlay and must portal to `document.body`
  like `Modal` does.
- **Cached module gates.** `AppShell` gate caching (roughly 60s) means a
  permission change can leave a stale dropdown briefly, which is the existing
  behaviour for the module row itself and not a regression.

## Rejected alternatives

- **Left sidebar.** Structurally the strongest answer to overflow plus depth, and
  the option I originally recommended. Rejected by the product owner to preserve
  the floating glass pill, which is a deliberate design investment. Stages 1 and 3
  solve overflow and depth within that constraint instead.
- **A `navTitle` alias beside `title`.** Would avoid touching e2e and breadcrumb
  fixtures, but produces a nav reading "Schedule" over a breadcrumb reading
  "Clinic Schedule", which is precisely the inconsistency this pass removes.
- **Notifications inside the account menu.** Initially selected, then reversed:
  it costs the ambient unread badge and saves no space that matters.
- **Entity search in v1 of the palette.** Deferred as its own PR; needs a
  permission-scoped API route.

## Follow-ups (not in this spec)

- Entity search in the command palette.
- Grouping the 11-tab Admin nav.
- Dashboard module tiles surfacing live counts (pending approvals, open
  requests) rather than static descriptions.
