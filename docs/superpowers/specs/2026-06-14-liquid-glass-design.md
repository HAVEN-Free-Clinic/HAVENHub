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

- **Intensity: Moderate, narrowed to Apple's guidance.** Glass on the top
  navigation bar plus floating overlays (modals/sheets and the combobox
  popover). **Secondary nav (breadcrumbs + module tabs) stays solid** — see
  "Apple guidance applied" below. Content cards / tables / stat tiles stay solid.
- **Fidelity: Frosted + specular edge.** Blur + saturation, a bright inset top
  highlight, a light gradient body, a soft diagonal edge sheen. Static — no
  animated sheen. No SVG displacement refraction (fragile and costly in a
  browser; the specular treatment gets ~90% of the feel).
- **Architecture: glass utility classes in `globals.css`** (Approach 1). One
  source of truth, light/dark via existing tokens, accessibility fallbacks
  written once.

## Apple guidance applied

From Apple's [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass):

- *"Liquid Glass applies to the topmost layer of the interface, where you define
  your navigation."* → glass = the floating top navigation bar.
- *"Avoid overcrowding or layering Liquid Glass elements on top of each other."*
  → do **not** stack a glass breadcrumb bar directly beneath the glass header.
  Breadcrumbs stay solid.
- *"Clearly separate your content from navigation elements... a distinct
  functional layer above the content layer."* → ModuleNav lives in the content
  column, so it stays solid.
- *"Avoid overusing Liquid Glass effects... do so sparingly... Limit these
  effects to the most important functional elements."* → keep the surface set
  small.
- Menus, popovers, and sheets *"adopt Liquid Glass"* → combobox popover + modal.
- *"When a half sheet expands to full height, it transitions to a more opaque
  appearance to help maintain focus."* → the modal panel leans **opaque** (high
  alpha), showing the material mainly at the edges.
- *"Audit the backgrounds of sheets and popovers... remove those custom
  background views"* → replace the modal/popover `bg-surface` with the glass
  material.
- *"Test your interface with... settings that reduce transparency or motion."*
  → the accessibility fallbacks below are mandatory.

## Material spec

Two component classes, defined in `src/app/globals.css` under
`@layer components`:

### `.glass-bar` — the floating nav pill (header only)

- Translucent gradient background (light: white at ~0.45–0.62 alpha).
- `backdrop-filter: blur(18px) saturate(190%)` (+ `-webkit-` prefix).
- **Full** hairline border (`rgba(255,255,255,.6)` light) — it's a detached island,
  not a pinned edge-to-edge bar.
- Inset top **specular highlight** + a soft **lift** drop shadow
  (`0 10px 30px rgba(15,23,42,.16)`) so it reads as floating.
- Faint diagonal edge sheen via `::before` (static gradient, `pointer-events:none`,
  `z-index:-1` so it sits behind content).

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
| Top app bar | `src/platform/ui/app-shell.tsx` | Becomes a **centered floating glass pill**: a transparent `sticky top-0 px-4 pt-3` wrapper holds a `max-w-6xl` `.glass-bar rounded-full` island (nav left, account controls right). Replaces the old `bg-surface/85 backdrop-blur-md` recipe; the edge-to-edge brand accent line is removed (the floating pill is the brand moment). |
| Modal + scrim | `src/platform/ui/modal.tsx` | Panel → `.glass-panel` (opaque-leaning, per Apple); backdrop scrim gains `backdrop-blur-sm` while keeping the fixed dark tint. |
| Combobox popover | `src/platform/ui/combobox.tsx` | Floating `<ul>` menu → `.glass-panel`. |

### Out of scope (deliberately, per Apple guidance)

- **Breadcrumbs** (`breadcrumbs.tsx`): stays solid — would be glass-on-glass
  directly under the header, which Apple says to avoid.
- **ModuleNav** (`module-nav.tsx`): stays solid — it's a content-layer tab
  strip, not a floating navigation surface.
- `src/platform/ui/select.tsx` is a native `<select>`; its dropdown is
  OS-rendered and cannot be glassed.
- Content surfaces: `card.tsx`, `stat-card.tsx`, `alert.tsx`, `badge.tsx`,
  `table.tsx`, page bodies — remain solid.
- No animated sheen, no SVG refraction, no scroll-edge effect (an enhancement we
  can revisit), no new/invented segmented control.

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
  - The three touched components reference the glass classes
    (`app-shell` → `.glass-bar`; `modal` and `combobox` → `.glass-panel`).
- **Manual verification** via browser screenshots: light theme, dark theme, and
  with reduced-transparency enabled (confirm the solid fallback). Verify the
  glass header reads cleanly above the solid breadcrumb bar (no glass-on-glass)
  and that the modal/combobox material is legible.

## Files touched (summary)

- `src/app/globals.css` — new `@layer components` glass classes + dark overrides
  + a11y fallbacks.
- `src/platform/ui/app-shell.tsx`
- `src/platform/ui/modal.tsx`
- `src/platform/ui/combobox.tsx`
- New test file(s) for the guard tests.

No logic changes — class swaps plus one CSS block.
