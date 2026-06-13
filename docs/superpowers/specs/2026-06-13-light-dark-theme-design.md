# Light / dark / system theming — design

Date: 2026-06-13
Branch context: feat/theme-dark-mode (worktree)

## Problem

The hub renders light-only. Every surface is built from hardcoded Tailwind
slate/white utilities, so there is no way for a user to choose a dark
appearance, and no token layer that could flip if we wanted one. We want a
proper light/dark/system theme that each user controls and that persists with
their account.

Current state:

- Tailwind **v4** (`@import "tailwindcss"` + `@theme` in `src/app/globals.css`).
  Brand and a `--color-canvas` token are defined there; module accent hues live
  in `:root`.
- Brand color is injected at runtime as CSS variables via `brandStyleVars()`
  (`src/platform/ui/brand-style.ts`), written into a `<style>` tag in the root
  layout. This is the established "variables flip the look" pattern.
- **~989 hardcoded** `bg/text/border/...-{white,black,slate-*,gray-*}` utilities
  across **~104 of 146** `.tsx` files. **Zero** existing `dark:` usage.
- Admin settings use a typed **registry** (`src/platform/settings/registry.ts`)
  that auto-renders fields in `/admin/settings`; it already supports `select`,
  `boolean`, and `color` input types. `getSetting<T>(key)` resolves DB override →
  env default (`src/platform/settings/service.ts`).
- `Person` (`prisma/schema.prisma`) is the per-user record; the session carries
  `personId`. `AppShell` (server component) renders the header user area
  (avatar + name + Sign out) and already mounts client components.

## Goals

- Each signed-in user picks **Light**, **Dark**, or **System**; the choice is
  saved to their `Person` record and follows them across devices.
- An admin **default theme** for surfaces with no per-user preference
  (logged-out pages, and users who never chose).
- **System** follows `prefers-color-scheme` and updates live when the OS flips.
- **No flash** of the wrong theme on load.
- A cohesive dark palette across the whole app via a **semantic token layer** —
  not a scattering of `dark:` variants.

## Non-goals

- Per-module or per-page theme overrides.
- Theming the brand color itself (admin branding is unchanged; we only adjust
  how brand surfaces read on dark).
- High-contrast / additional named themes beyond light & dark.
- A `next-themes` dependency (see Mechanism).
- Theming transactional email HTML (emails stay light).

## Mechanism — hand-rolled, no new dependency

The source of truth is the **DB (per-user)**, not `localStorage`. `next-themes`
is built around `localStorage` as its store, so adopting it would create a dual
source of truth and an awkward sync. The app already hand-rolls CSS-variable
injection (`brandStyleVars`) and avoids unnecessary deps, so we add a small
theme module in the same spirit. A mirror **cookie** is used only as a
render-time hint for SSR/no-flash; the DB stays authoritative.

## Design

### Layer 1 — Semantic token layer (`globals.css`)

Add semantic role tokens to `@theme` (light values) and override them in a
`.dark` block. Tailwind v4 generates utilities (`bg-surface`, `text-foreground`,
…) from these `--color-*` names automatically.

Roles and mapping (the finite set the ~989 utilities collapse into):

| Current utility(s)            | New token        | Light            | Dark (target)     |
| ----------------------------- | ---------------- | ---------------- | ----------------- |
| `bg-white`                    | `surface`        | `#ffffff`        | ~`slate-900`      |
| `bg-canvas` (exists)          | `canvas`         | `#eef1f5`        | ~`slate-950`      |
| `bg-slate-50` / `bg-slate-100`| `muted`          | `slate-50/100`   | ~`slate-800`      |
| `text-slate-900` / `-800`     | `foreground`     | `slate-900`      | ~`slate-100`      |
| `text-slate-700` / `-600`     | `foreground-soft`| `slate-700/600`  | ~`slate-300`      |
| `text-slate-500`              | `muted-fg`       | `slate-500`      | ~`slate-400`      |
| `text-slate-400`              | `subtle-fg`      | `slate-400`      | ~`slate-500`      |
| `border-slate-200` / `-300`   | `border-default` | `slate-200/300`  | ~`slate-700/600`  |

Notes:

- The exact dark hex values are tuned during implementation for contrast
  (WCAG AA on text). The table gives the intended mapping, not final hex.
- Brand tokens already flip via variables. Add `.dark` adjustments for
  `--color-brand-faint` / `--color-brand-light` so brand-tinted chips/links stay
  legible on a dark surface.
- A short curated alias set keeps the migration honest: where a slate shade is
  used for a one-off purpose, it maps to the nearest role rather than inventing a
  new token. New tokens are only added if a genuine role has no home.

### Layer 2 — Token migration sweep

Replace hardcoded slate/white utilities with the role tokens across the ~104
files. This is a **semantic** sweep (each replacement checked in context), not a
blind find-replace, done in dependency order so review stays tractable:

1. **Primitives** (`src/platform/ui/*`): `card`, `button`, `input`, `select`,
   `checkbox`, `badge`, `alert`, `modal`, `table`, `stat-card`, etc.
2. **Shell & nav**: `app-shell`, `global-nav`, `module-nav`, `breadcrumbs`,
   `page-header`, `page-loading`, footer, plus the root layout body classes.
3. **Pages**: each route segment, segment by segment.

The root layout `<body>` class `text-slate-900` and `bg-canvas` become
`text-foreground` / `bg-canvas` (token-backed).

### Layer 3 — Data model, resolution, no-flash

**Schema.** Add to `Person`:

```prisma
themePreference String? // null = use app default; "light" | "dark" | "system"
```

Plus an admin registry setting `ui.defaultTheme` (`select`: light/dark/system,
env default `system`).

**Resolution helper** (`src/platform/ui/theme.ts`, unit-tested, pure):

- `resolvePreference(personPref, adminDefault): "light" | "dark" | "system"`
  → `personPref ?? adminDefault ?? "system"`.
- `effectiveClass(pref, prefersDark): "" | "dark"` → for `system`, depends on
  `prefersDark`; for explicit values, ignores it.
- The literal pure constants (cookie name, valid values) live here so both the
  inline script contents and the server share one definition.

**No-flash strategy.**

- Root layout reads the user's resolved preference server-side (from
  `personId` → `Person.themePreference`, falling back to the `ui.defaultTheme`
  setting; logged-out → setting). It renders `<html data-theme-pref="…">` and,
  for explicit `light`/`dark`, the correct `class` directly — zero flash, fully
  server-known.
- For `system`, the server cannot know the OS at render time, so a tiny
  **blocking inline `<head>` script** (string built from the constants in
  `theme.ts`) resolves `prefers-color-scheme` and toggles
  `documentElement.classList` before first paint.
- `<html suppressHydrationWarning>` because the class may be script-managed.
- A small client `ThemeListener` keeps `system` live by subscribing to the
  `matchMedia('(prefers-color-scheme: dark)')` change event.

### Layer 4 — UI controls

- **`ThemeToggle`** (client) in the `AppShell` header user area, beside the
  name: cycles Light → Dark → System with sun / moon / monitor icons
  (`lucide-react`, already a dep) and an accessible label. On change it:
  1. optimistically sets `documentElement.classList` + writes the mirror cookie,
  2. calls a server action that persists `Person.themePreference`.
- **Admin default** needs no new UI — adding `ui.defaultTheme` to the registry
  auto-renders it in `/admin/settings`.

### Layer 5 — Server action & persistence

- `setThemePreference(pref)` server action (in the platform UI/auth area):
  validates `pref` against the shared constant set, resolves `personId` from the
  session, updates `Person`, and sets the mirror cookie. Rejects unknown values.

## Testing

- **Unit** (`theme.test.ts`, mirroring `brand-style.test.ts`):
  `resolvePreference` precedence (person > admin > system) and
  `effectiveClass` for all (pref × prefersDark) combinations; assert the inline
  script string references only the shared constants.
- **Unit**: the registry gains `ui.defaultTheme`; cover its schema (rejects
  values outside light/dark/system) alongside existing registry tests.
- **E2E** (Playwright): sign in, toggle to Dark, assert `<html class="dark">`;
  reload, assert it persists (DB-backed); toggle to System and assert it tracks
  the emulated `prefers-color-scheme`.

## Migration / rollout

- One Prisma migration adds the nullable `themePreference` column (safe,
  backward-compatible; existing users resolve to the admin default).
- The token sweep is mechanical-but-reviewed; it changes class names only, so
  light-mode appearance is unchanged when tokens carry today's values.

## Risks

- **Missed surfaces.** A page that keeps a raw slate utility won't flip. Mitigated
  by the primitives-first order (most surfaces inherit) and a final grep for
  residual `-(white|slate-)` utilities before completion.
- **Contrast regressions** in dark. Mitigated by tuning dark hex against AA and
  spot-checking dense pages (tables, schedule builder).
- **Flash on `system`.** Mitigated by the blocking inline script; explicit
  light/dark never flash because they're server-rendered.
