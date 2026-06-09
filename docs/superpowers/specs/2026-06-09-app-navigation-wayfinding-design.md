# App Navigation & Wayfinding — Design

**Date:** 2026-06-09
**Status:** Approved (design); pending spec review
**Branch:** worktree-login-redesign

## Problem

Once a user is inside a module there is no obvious way to tell where they are or
to get back out, and no way to move between modules without returning to the hub
home. Concretely:

- Deep pages (`/admin/people/[id]`, `/admin/people/new`, `/admin/terms/[id]`,
  `/admin/terms/new`) have no breadcrumb and no back link. Escaping requires
  noticing the right tab in the section nav or using the browser Back button.
- The only route to the hub home is the logo, which is not an obvious affordance.
- There is no global navigation between modules; switching from Admin to
  Volunteers means going back to the hub and picking a tile.

This is worst in Admin, which has the deepest pages.

## Goal

Give every page a clear sense of place and an easy escape upward, and let users
move between modules from anywhere — without a large redesign of the existing
centered, top-nav layout.

## Approach (chosen)

Three navigation layers, all derived from the existing module registry
(`src/platform/modules/registry.ts`) so they cannot drift from each other:

| Layer | What | Where it renders |
|---|---|---|
| **Global module switcher** | Links to the modules the user can access (Schedule, Volunteers, Admin, My Info), active module highlighted | `AppShell` header — appears on every page automatically |
| **Breadcrumb trail** | `Hub › Admin › People › …`, every crumb a link except the current page | `AppShell`, directly below the header |
| **Section tabs** | Existing `ModuleNav` (Overview / People / Terms …) | Module layouts — unchanged |

Desktop layout (matches the approved mockup):

```
┌────────────────────────────────────────────┐
│ [HAVEN]  Schedule  Volunteers  Admin   Jane · Sign out │  global modules
├────────────────────────────────────────────┤
│ Hub › Admin › People › …                    │  breadcrumb
│ Overview  People  Terms  Roles  Audit  …     │  section tabs (existing)
│ <page H1>                                    │
└────────────────────────────────────────────┘
```

### Rejected alternatives

- **Left sidebar nav:** strongest sense of place, but a real redesign of the app
  shell and a departure from the current centered layout. Out of scope.
- **Top bar that drops the section tabs (sections in a dropdown):** cleaner
  header but makes section switching one click less direct, and discards a nav
  pattern that already works. Not chosen.
- **Minimal back links only:** doesn't show full location and doesn't help at
  mid depth.

## Components

### `getAccessibleModules(personId)` — shared helper
- New server helper at `src/platform/modules/access.ts`.
- Returns the modules the user may see in the global nav: `status: "active"` AND
  (`accessPermission` absent OR the user holds it). This is the SAME filter the
  hub page already applies to its tiles — extract it so the hub and the global
  nav share one implementation and cannot diverge.
- Returns a serializable, icon-free shape: `{ id, title, href }[]` where
  `href = "/" + id`.
- The hub page (`src/app/page.tsx`) is refactored to consume this helper for its
  tile list (keeping its coming-soon tiles, which it already handles separately).

### `GlobalNav` (client) — `src/platform/ui/global-nav.tsx`
- Props: `items: { id, title, href }[]` (from `getAccessibleModules`).
- Uses `usePathname()` to mark the active module: a module is active when
  `pathname === href` or `pathname.startsWith(href + "/")`.
- Desktop (`sm` and up): inline horizontal links in the header.
- Mobile (below `sm`): collapses to a menu button (hamburger) that toggles a
  dropdown panel listing the modules. Local `useState` for open/closed; closes
  on navigation.
- Accessibility: wrapped in `<nav aria-label="Modules">`, active link gets
  `aria-current="page"`, brand focus rings, the menu button has an
  `aria-expanded` / `aria-controls` pair and an accessible label.
- The logo remains the "Hub" home link (unchanged); the global nav lists modules
  only (no duplicate Hub link).

### `Breadcrumbs` (client) — `src/platform/ui/breadcrumbs.tsx`
- Props: `modules: { id, title, nav: { label, href }[] }[]` (icon-free registry
  data passed from `AppShell`), and optional `leafLabel?: string` (override for
  the final crumb — unused in option A, present so the entity-name enhancement
  is a trivial follow-up).
- Uses `usePathname()` to build the trail:
  - Always starts with `Hub` → `/`.
  - If the path is under a module, add `<module.title>` → `/<id>`.
  - If the remaining path matches one of that module's `nav` hrefs, add that
    section's `<label>` → its href.
  - **Leaf handling (option A):**
    - A trailing `new` segment → append a non-link "New" crumb, marked current.
    - A trailing dynamic id segment (e.g. `/admin/people/<id>`) → append NO extra
      crumb; the trail ends at the section (e.g. People), which doubles as the
      escape link, and the entity name appears as the page H1 immediately below.
    - The live entity name is NOT looked up. (Option B — real entity name in the
      crumb — would pass `leafLabel` from each of the 4 detail pages; deferred.)
- The current page's crumb is rendered as plain text (not a link).
- Accessibility: `<nav aria-label="Breadcrumb">` containing an ordered list, the
  last item marked `aria-current="page"`, separators `aria-hidden`.
- Mobile: collapse to the last one or two crumbs to avoid wrapping (e.g. show
  only `… › People › New`), full trail at `sm` and up.

### `AppShell` changes — `src/platform/ui/app-shell.tsx`
- New prop: `personId: string` (the five callers already have the person).
- Computes `getAccessibleModules(personId)` once and renders `GlobalNav` in the
  header row (alongside logo / term badge / user / sign out).
- Renders `Breadcrumbs` directly under the header, above `main`. Passes the
  icon-free registry data (a small `MODULES`-derived map) to it.
- `ModuleNav` continues to render inside each module layout (below the
  breadcrumb), unchanged.

## Data flow

```
registry.ts (source of truth)
   │
   ├── getAccessibleModules(personId) ──▶ GlobalNav.items   (permission-filtered)
   │                                   └▶ hub page tiles    (same filter)
   │
   └── icon-free module map ───────────▶ Breadcrumbs.modules
                                          (usePathname picks the trail)
```

`AppShell` is the single integration point: all five existing callers
(`src/app/page.tsx`, `src/app/my-info/page.tsx`, and the `schedule` / `admin` /
`volunteers` layouts) pass `personId`; the nav appears everywhere with no
per-page work for the standard cases.

## Accessibility

- Global nav and breadcrumb are each `<nav>` landmarks with distinct
  `aria-label`s.
- Active/current items use `aria-current="page"`.
- The mobile menu button exposes `aria-expanded` and `aria-controls` and has an
  accessible name ("Open navigation menu").
- All links use the existing brand focus-visible rings.
- Tab/focus order follows visual order (logo → modules → user actions →
  breadcrumb → section tabs → content).

## Testing

- Unit-test the trail derivation: given a `pathname` and the registry data,
  `Breadcrumbs` produces the expected crumb list (root, section, `new`, and
  detail-id cases), and `getAccessibleModules` filters by status + permission.
- Existing module-layout and page tests must continue to pass (the added
  `personId` prop and chrome must not break rendering).
- Manual/visual check at 375px, 768px, 1024px, 1440px: hamburger opens/closes,
  breadcrumb collapses, no horizontal overflow, active states correct across
  hub, my-info, and each module including a deep detail page.

## Out of scope

- Left-sidebar redesign.
- Option B (entity name in the breadcrumb leaf) — supported by the `leafLabel`
  prop but not wired up now.
- Changes to coming-soon modules (excluded from the global nav).
- Any change to `ModuleNav` / section-tab behavior.

## Files

**New**
- `src/platform/modules/access.ts` — `getAccessibleModules`.
- `src/platform/ui/global-nav.tsx` — `GlobalNav` (client).
- `src/platform/ui/breadcrumbs.tsx` — `Breadcrumbs` (client).

**Edited**
- `src/platform/ui/app-shell.tsx` — add `personId`, render `GlobalNav` +
  `Breadcrumbs`.
- `src/app/page.tsx` — pass `personId`; consume `getAccessibleModules` for tiles.
- `src/app/my-info/page.tsx` — pass `personId`.
- `src/app/schedule/layout.tsx`, `src/app/admin/layout.tsx`,
  `src/app/volunteers/layout.tsx` — pass `personId`.
