# Persistent App Shell + Navigation Performance

**Date:** 2026-06-13
**Branch:** worktree-feat+persistent-app-shell (off main)
**Status:** Approved design, pending implementation plan

## Problem

The app feels slow on tab switches. Two root causes:

1. **Toolbar remounts on every cross-module navigation.** `AppShell`
   (`src/platform/ui/app-shell.tsx`) is mounted in eight separate places — five
   module layouts (`schedule`, `learning`, `recruitment`, `admin`, `volunteers`)
   plus inlined directly in three pages (`app/page.tsx` hub, `my-info/page.tsx`,
   `training/page.tsx`). No common layout owns it. In the Next.js App Router a
   layout only persists while you stay inside its segment, so jumping between
   modules unmounts one `AppShell` and mounts another, re-running `auth()`,
   `getAccessibleModules()`, and the active-term query server-side every time.
   This produces a visible toolbar flash and wasted server work.

2. **The onboarding gate runs ~6 DB queries on every page render.**
   `requirePersonSession()` is the universal page chokepoint and calls
   `enforceOnboarding()` -> `getOnboardingStatus()` on every render, including soft
   navigations, even for users already onboarded or exempt. `getOnboardingStatus`
   issues `can()`, `term.findFirst`, then a `Promise.all` of four more queries.
   Neither `getActivePerson()` nor `getOnboardingStatus()` is request-memoized.

## Goals

- The toolbar mounts once and stays mounted across all tab switches; only the
  page body (and a module's own sub-nav) reloads.
- Cut the per-navigation server cost so navigation is faster, not just smoother.
- No URL changes. No behavior regressions in auth/onboarding gating.

## Non-goals

- No redesign of the toolbar's appearance.
- No speculative bundle rewrites; measure first, fix only clear wins.
- No change to the offboarding security model (active-person check stays
  every-render).

## Design

### 1. Persistent shell via an `(app)` route group

Introduce a route group `app/(app)/` whose layout owns the toolbar. Route groups
do not affect URLs, and pages import via the `@/` alias, so moving directories
does not break imports.

```
app/layout.tsx                      root: fonts, brand vars, TopProgressBar (unchanged)
app/(app)/layout.tsx                NEW — AppShell: brand line, header, breadcrumbs, footer
  app/(app)/page.tsx                hub (AppShell removed from page body)
  app/(app)/schedule/layout.tsx     thin: requireModuleAccess + ModuleNav
  app/(app)/learning/layout.tsx     thin: requireModuleAccess + ModuleNav
  app/(app)/recruitment/layout.tsx  thin: requireModuleAccess + ModuleNav
  app/(app)/admin/layout.tsx        thin: requireModuleAccess + ModuleNav
  app/(app)/volunteers/layout.tsx   thin: requireModuleAccess + ModuleNav
  app/(app)/my-info/...             renders under shared shell (thin layout only if it has sub-nav)
  app/(app)/training/...            renders under shared shell (thin layout only if it has sub-nav)
```

**Routes that stay at `app/` root** (public or own chrome, must NOT get the
authenticated toolbar): `login`, `apply`, `onboard`, `welcome`, `get-started`,
`api`, plus root-level files (`layout.tsx`, `globals.css`, etc.).

**`app/(app)/layout.tsx` responsibilities (server component, runs once per hard
load, persists across soft nav):**
- Call `requirePersonSession()` for the signed-in person.
- Call `getAccessibleModules(personId)` for the global nav.
- Fetch the active term once for the term badge.
- Render `AppShell` with header, `BreadcrumbProvider`, `<main>`, footer.

**`AppShell` changes:** it currently fetches `getAccessibleModules` itself and
takes `userName`/`termLabel`/`personId` props. After the move it is rendered only
by the shared layout. Keep the component but ensure the shared layout supplies its
data; remove the duplicate nav fetch so it happens once in the layout. `AppShell`
no longer wraps `ModuleNav` — sub-nav moves down into each module's thin layout.

**Module layouts** shrink to: run `requireModuleAccess("<id>")` (gate stays
per-module) and render `<ModuleNav items={mod.nav} />` above `{children}`. They no
longer render `AppShell`. A module layout still remounts on cross-module nav, but
it is now trivial (an indexed access check + static sub-nav), not the full toolbar.

**Pages that inlined `AppShell`** (`app/page.tsx`, `my-info/page.tsx`,
`training/page.tsx`) drop the `AppShell` wrapper and return their body directly;
the shared layout now provides the chrome.

### 2. Term badge

Fetched once in `app/(app)/layout.tsx` (active term) and shown consistently in all
modules. This is a deliberate, minor behavior change: modules that previously hid
the badge (`learning`, `recruitment`, `admin`, `volunteers`) now show it. Chosen
for consistency and to avoid threading per-module term state into a shared toolbar.

### 3. Per-navigation cost reduction

- Wrap `getActivePerson()` and `getOnboardingStatus()` in React `cache()` so
  repeated calls within one render hit the DB once.
- Add a short-TTL (~60s) per-person cache for the onboarding-gate result, mirroring
  the existing settings-service TTL pattern (`src/platform/settings/service.ts`).
  Repeated navigations within the window skip the ~6 queries. Worst case: a
  just-cleared or newly-lapsed user sees stale gating for under a minute. The
  cache stores only the gate decision; the every-render `getActivePerson()`
  offboarding check is unaffected, so offboarding still revokes access immediately.

### 4. Bundle measurement

Capture one production build report (`npm run build`) and inspect the client JS
summary. Act only on clear wins (e.g. a heavy component that should be a server
component, an oversized import). No speculative refactors.

## Component boundaries

- `app/(app)/layout.tsx` — owns all chrome + global session/nav data. Depends on
  `requirePersonSession`, `getAccessibleModules`, term query, `AppShell`.
- `AppShell` — pure presentational shell given its data. No longer self-fetches nav.
- Module `layout.tsx` — owns one module's access gate + sub-nav. Depends on
  `requireModuleAccess`, registry `nav`, `ModuleNav`.
- Onboarding gate cache — owns gate-result memoization. Depends on
  `getOnboardingStatus`; exposes a test-only reset like the settings cache.

## Risks

- **Directory move breaks something subtle.** Loading/error files
  (`loading.tsx`) under moved segments move with them; verify each moved segment
  still resolves. `app/loading.tsx` (root) behavior re-checked since the hub page
  moves under `(app)`.
- **Double session resolution.** Shared layout and the page both call
  `requirePersonSession`; React `cache()` dedups it per request.
- **Stale gating** from the TTL cache — bounded to ~60s and only affects the
  /get-started redirect, never the offboarding/active check.

## Verification

- `npm test` (vitest) passes; add a test for the onboarding-gate TTL cache.
- `npm run typecheck` and `npm run lint` clean.
- Manual: cross-module navigation keeps the toolbar mounted (no flash, no nav
  re-fetch); public routes (`login`, `get-started`) render without the toolbar; an
  uncleared user is still redirected to `/get-started`; an offboarded user loses
  access immediately.
- `npm run build` succeeds; review client bundle summary.
