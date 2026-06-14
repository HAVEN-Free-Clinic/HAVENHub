# Liquid Glass adoption — design

**Date:** 2026-06-14
**Branch:** `feat/liquid-glass` (worktree off `origin/main`)
**Status:** Approved design, pending implementation plan

## Goal

Adopt Apple's Liquid Glass material where appropriate in HAVEN Hub, following
Apple's guidance ([Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/liquid-glass),
[Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)):
glass is a **floating navigation / control layer that sits above content — never
the content itself**. Apply it tastefully to the app's chrome and floating
overlays, keep all content surfaces solid, and never let it cost legibility or
accessibility in a clinical tool.

## Decisions (from brainstorming)

- **Intensity: Moderate.** Glass on the top bar plus floating layers (modals,
  dropdown popovers, secondary nav). Content cards / tables / stat tiles stay
  solid.
- **Fidelity: Frosted + specular edge.** Blur + saturation, a bright inset top
  highlight, a light gradient body, a soft diagonal edge sheen. Static — no
  animated sheen. No SVG displacement refraction (fragile and costly in a
  browser; the specular treatment gets ~90% of the feel).
- **Architecture: glass utility classes in `globals.css`** (Approach 1). One
  source of truth, light/dark via existing tokens, accessibility fallbacks
  written once.

## Material spec

Two component classes, defined in `src/app/globals.css` under
`@layer components`:

### `.glass-bar` — sticky horizontal bars (header, module nav, breadcrumbs)

- Translucent gradient background (light: white at ~0.5–0.62 alpha).
- `backdrop-filter: blur(18px) saturate(190%)` (+ `-webkit-` prefix).
- Hairline border (`rgba(255,255,255,.7)` light).
- Inset top **specular highlight** (`box-shadow: 0 1px 0 rgba(255,255,255,.95) inset`)
  + a thin inset edge line + a soft drop shadow.
- Faint diagonal edge sheen via `::before` (static gradient, `pointer-events:none`).
- Emphasis on the bottom edge since the bar is pinned.

### `.glass-panel` — floating overlays (modal panel, combobox popover)

- Same material recipe, fully rounded corners.
- Stronger drop shadow so it reads as lifted above content.

### Dark mode

Under `html.dark`, derive the tint from the existing `--color-surface` token via
`color-mix` (surface at ~0.55 alpha) so it tracks the admin-chosen brand/theme.
Border becomes a low-alpha white (`rgba(255,255,255,.10–.12)`); the specular
highlight is subtler. Same blur.

## Per-surface treatment

| Surface | File | Change |
|---|---|---|
| Top app bar | `src/platform/ui/app-shell.tsx` | Replace `bg-surface/85 backdrop-blur-md backdrop-saturate-150` with `.glass-bar`. Brand accent line above it stays. |
| Module nav | `src/platform/ui/module-nav.tsx` | Apply `.glass-bar`, forming a continuous glass stack under the header. |
| Breadcrumbs | `src/platform/ui/breadcrumbs.tsx` | Apply `.glass-bar` but lighter (reduced shadow) so two stacked translucent bars don't read muddy. |
| Modal + scrim | `src/platform/ui/modal.tsx` | Panel → `.glass-panel`; backdrop → blurred translucent scrim (e.g. `backdrop-blur` + `bg-black/40`). |
| Combobox popover | `src/platform/ui/combobox.tsx` | Floating menu → `.glass-panel`. |

### Out of scope

- `src/platform/ui/select.tsx` is a native `<select>`; its dropdown is
  OS-rendered and cannot be glassed.
- Content surfaces: `card.tsx`, `stat-card.tsx`, `alert.tsx`, `badge.tsx`,
  `table.tsx`, page bodies — remain solid.
- No animated sheen, no SVG refraction, no new/invented segmented control.

## Accessibility (non-negotiable)

- `@media (prefers-reduced-transparency: reduce)` → drop `backdrop-filter`, fall
  back to **solid `--color-surface`** background; keep border + shadow.
- Same solid fallback under `forced-colors` (Windows High Contrast) and
  `prefers-contrast: more`.
- Text always uses token foreground colors; the translucent background keeps a
  high enough opacity floor to preserve AA contrast for bar/panel text.
- Because all *content* stays solid, data and table legibility are unaffected.
- Fidelity is static, so there is no motion to gate — but if any transition is
  added later it must respect `prefers-reduced-motion`.

## Testing

- **Guard unit tests** (in the style of `app-shell.importer.test.ts`):
  - `globals.css` defines `.glass-bar` and `.glass-panel`.
  - `globals.css` includes a `prefers-reduced-transparency` solid fallback.
  - The five touched components reference the glass classes
    (`app-shell`, `module-nav`, `breadcrumbs`, `modal`, `combobox`).
- **Manual verification** via browser screenshots: light theme, dark theme, and
  with reduced-transparency enabled (confirm the solid fallback). Verify the
  stacked header + module-nav + breadcrumb bars read cleanly.

## Files touched (summary)

- `src/app/globals.css` — new `@layer components` glass classes + dark overrides
  + a11y fallbacks.
- `src/platform/ui/app-shell.tsx`
- `src/platform/ui/module-nav.tsx`
- `src/platform/ui/breadcrumbs.tsx`
- `src/platform/ui/modal.tsx`
- `src/platform/ui/combobox.tsx`
- New test file(s) for the guard tests.

No logic changes — class swaps plus one CSS block.
