# App-wide loading feedback — design

Date: 2026-06-12
Branch context: feat/avs-generator (worktree)

## Problem

When the app is doing work (navigating to a new route, submitting a form,
rendering a data-heavy page) it often gives no visible feedback. Users sit on a
blank or unchanged screen with no signal that anything is happening, which reads
as "frozen" and invites double-clicks. We want consistent loading feedback
applied broadly across the app.

There is currently no shared spinner primitive and no `loading.tsx` route files
anywhere. The only loading affordances are:

- An inline spinner SVG copy-pasted into `src/app/login/sign-in-button.tsx`.
- A text-only pending state ("Saving…") in `src/platform/ui/submit-button.tsx`.

## Goals

- A single reusable spinner used everywhere "something is happening" inline.
- Instant feedback on every navigation, before the server responds.
- A consistent loading screen in the page body while a route renders.
- Forms keep their existing pending mechanism but gain a visible animation.

## Non-goals

- Bespoke content skeletons per route (centered spinner first; specific pages
  can be upgraded to content skeletons later).
- Changing how server actions or data fetching work.
- Optimistic UI.

## Framework context

- Next.js 16.2.7, React 19.2.4, App Router.
- Root `src/app/layout.tsx` is a server component that already mounts a client
  component (`InactivityTracker`) — the established pattern for global client
  behavior.
- Brand color is exposed as the CSS variable `--color-brand` (see
  `src/platform/ui/brand-style.ts`); loading UI must use it rather than a
  hardcoded color so it tracks per-tenant branding.
- Top-level route segments: `admin`, `learning`, `recruitment`, `schedule`,
  `volunteers`, `clinic`, `my-info`, plus `get-started`, `training`, `welcome`,
  `login`, `onboard`, `apply`, and the root.
- Existing segment layouts: `schedule`, `learning`, `recruitment`, `admin`,
  `volunteers`, `clinic`.
- Note: layouts do NOT re-render on soft navigation. Any navigation-aware UI
  must manage its own client state, not rely on the layout re-rendering.

## Design

Three layers built on one shared primitive.

### Layer 1 — `Spinner` primitive

File: `src/platform/ui/spinner.tsx` (client-safe, presentational).

- Renders the branded animated SVG currently inlined in `sign-in-button.tsx`
  (circle track + spinning arc).
- Props: `size?: "sm" | "md" | "lg"` (mapping to `h-4 w-4`, `h-5 w-5`,
  `h-6 w-6` or similar), plus `className` passthrough.
- Uses `currentColor` so it inherits the surrounding text color.
- Accessibility: `role="status"` with an accessible label (e.g. `aria-label`,
  default "Loading"); `aria-hidden` is not used on the root since it conveys
  status. Animation class includes `motion-reduce:animate-none` to respect
  `prefers-reduced-motion`.

Refactors that consume it:

- `src/app/login/sign-in-button.tsx` — replace the inline SVG with `<Spinner>`.
- `src/platform/ui/submit-button.tsx` — render a `<Spinner size="sm">` next to
  the pending label so the pending state has a visible animation, not just text.

### Layer 2 — Global top progress bar

File: `src/platform/ui/top-progress-bar.tsx` (client component).

- Thin wrapper around `@bprogress/next` (App-Router-native, maintained successor
  to nprogress). Renders the library's app-router progress bar configured to:
  - color: `var(--color-brand)`
  - height: ~2–3px, fixed at the top of the viewport, above app chrome
  - no spinner dot (bar only), shallow-route options left at sensible defaults
- Mounted in `src/app/layout.tsx` alongside `InactivityTracker`. It shows the
  bar the moment a navigation starts (Link click or `router.push`) and completes
  it when the new route commits. Self-contained client state, so the
  no-soft-nav-rerender constraint does not apply.

New dependency: `@bprogress/next`.

### Layer 3 — Route loading screens

File: `src/platform/ui/page-loading.tsx`.

- `<PageLoading label?: string>` — a centered `Spinner size="lg"` filling the
  available content area (min height so it doesn't collapse), with an optional
  text label below it.

`loading.tsx` files, each rendering `export default () => <PageLoading />`:

- `src/app/loading.tsx` (root catch-all)
- `src/app/schedule/loading.tsx`
- `src/app/learning/loading.tsx`
- `src/app/recruitment/loading.tsx`
- `src/app/admin/loading.tsx`
- `src/app/volunteers/loading.tsx`
- `src/app/clinic/loading.tsx`
- `src/app/my-info/loading.tsx`

A segment's `loading.tsx` is the Suspense fallback for that segment and all its
nested routes, so this set covers the app with the root file as the fallback for
everything else.

## Data flow

1. User clicks a link or triggers `router.push`.
2. `@bprogress/next` immediately shows the top bar (`var(--color-brand)`).
3. Next.js streams the destination route; its nearest `loading.tsx`
   (`PageLoading`) renders in the page body while the server component resolves.
4. Route commits → progress bar completes and hides; real content replaces the
   `PageLoading` fallback.

For forms: `useFormStatus().pending` toggles the button into its pending state,
which now shows `<Spinner>` plus the pending label. Unchanged mechanism.

## Error handling / edge cases

- Interrupted or rapid successive navigations: handled by the bprogress library
  (it resets/completes its own bar). No app-level state to leak.
- Reduced motion: spinner animation disabled via `motion-reduce:animate-none`;
  the progress bar is a thin moving bar and is acceptable, but configure it to
  honor reduced-motion if the library supports it.
- The spinner is purely presentational and carries `role="status"` for screen
  readers; `PageLoading` exposes the same status semantics once (no nested
  duplicate status regions).

## Testing

Follows the existing `*.test.ts` vitest style in `src/platform/ui`.

- `spinner.test.ts(x)` — renders; applies the correct size classes for each
  `size`; sets `role="status"` and an accessible label; includes the
  reduced-motion class.
- `page-loading.test.ts(x)` — renders a spinner; renders the optional label when
  provided.
- `top-progress-bar.test.ts(x)` — render smoke test (mounts without throwing).

## Files summary

New:
- `src/platform/ui/spinner.tsx`
- `src/platform/ui/page-loading.tsx`
- `src/platform/ui/top-progress-bar.tsx`
- `src/app/loading.tsx`
- `src/app/{schedule,learning,recruitment,admin,volunteers,clinic,my-info}/loading.tsx`
- Tests for spinner, page-loading, top-progress-bar.

Modified:
- `src/app/layout.tsx` (mount `TopProgressBar`)
- `src/app/login/sign-in-button.tsx` (use `Spinner`)
- `src/platform/ui/submit-button.tsx` (use `Spinner`)
- `package.json` (add `@bprogress/next`)
