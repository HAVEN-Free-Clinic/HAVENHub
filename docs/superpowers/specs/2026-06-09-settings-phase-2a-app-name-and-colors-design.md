# Admin-Configurable Settings — Phase 2a: App Name + Brand Color

**Date:** 2026-06-09
**Status:** Design for approval
**Depends on:** Phase 0 foundation + Phase 1 (PR #20). Uses the same registry/resolver/auto-rendered page.

## Goal

Make the application name and primary brand color editable from `/admin/settings`,
so the app stops reading "HAVEN Hub" / Yale Blue as hardcoded identity. This is the
"values" half of branding; uploadable logo + favicon are Phase 2b.

## Scope

- `branding.appName` (text) — the product name shown in the browser tab, the login
  screen, and admin page copy.
- `branding.brandColor` (color/hex) — the primary brand color. Overrides the
  Tailwind `--color-brand` CSS variable at runtime; the four shade variants
  (`-hover`, `-deep`, `-light`, `-faint`) are derived with CSS `color-mix()`.

### Out of scope (deliberate)

- **Email branding.** The email layout (header text, footer "HAVEN Hub platform",
  `#00356b` header) lives in the **admin-editable email template** (`layout`
  descriptor, PR #10). Admins rebrand email via the existing template editor, not
  this settings system. Not touched here.
- **Logo, favicon** — Phase 2b (needs file-upload infra).
- **Org name strings that are not the product name** (e.g. "HAVEN Free Clinic",
  "Yale School of Medicine") — those are organization identity in editorial copy,
  not the app name; left as-is unless a later phase generalizes them.

## Design

### 1. Registry: a `color` input type + two entries

Add a `color` variant to `SettingInput` (the settings page renders `<input
type="color">`). Then two entries:

```ts
define<string>({
  key: "branding.appName",
  category: "Branding",
  label: "Application name",
  help: "Shown in the browser tab, on the sign-in screen, and in admin copy.",
  input: { type: "text" },
  schema: z.string().min(1),
  envDefault: () => "HAVEN Hub",   // current product name; no env var today
  secret: false,
}),
define<string>({
  key: "branding.brandColor",
  category: "Branding",
  label: "Primary brand color",
  help: "Main brand color. Buttons, links, and accents derive from it. Shade variants are computed automatically.",
  input: { type: "color" },
  schema: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a 6-digit hex color like #00356b"),
  envDefault: () => "#00356b",     // current Yale Blue (globals.css default)
  secret: false,
}),
```

Note: these have no env var today, so `envDefault` returns the current literal.
That is consistent with the registry contract (env default is the seed value).

### 2. Settings page: render the `color` input

The auto-rendered form gains one branch: `input.type === "color"` →
`<input type="color" defaultValue={String(value)} ...>`. Everything else
(server action, validation, audit, reset) already works unchanged — the color
value is just a string the registry schema validates.

### 3. App name consumers

Resolve `branding.appName` via `getSetting<string>("branding.appName")` at these
user-facing sites (all server components / async):

- `src/app/layout.tsx` — convert `export const metadata` to
  `export async function generateMetadata(): Promise<Metadata>` reading the name
  for `title` and `description` (`"<name>"` / `"The unified platform for <name>"`).
- `src/app/login/page.tsx` — "Sign in to {appName}".
- `src/app/admin/page.tsx` — `description={\`${appName} operations: ...\`}`.
- `src/app/admin/people/new/page.tsx` — the description string mentioning the name.

(Comments and dev-only strings that say "HAVEN Hub" are not user-facing and are
left alone.)

### 4. Brand color: runtime CSS-variable override

In `src/app/layout.tsx`, resolve `branding.brandColor` and inject a `<style>` into
`<head>` that overrides the brand CSS variables. Variants use `color-mix()` so the
browser computes the shades — no JS color math, no new dependency:

```tsx
const brand = await getSetting<string>("branding.brandColor");
// rendered in <head>, after globals.css, so it wins the cascade:
<style>{`:root{
  --color-brand:${brand};
  --color-brand-hover:color-mix(in srgb, ${brand} 88%, black);
  --color-brand-deep:color-mix(in srgb, ${brand} 75%, black);
  --color-brand-light:color-mix(in srgb, ${brand} 18%, white);
  --color-brand-faint:color-mix(in srgb, ${brand} 6%, white);
}`}</style>
```

`brand` is validated to a strict `#rrggbb` hex by the registry schema before it is
ever stored, so the interpolation cannot inject arbitrary CSS (defense-in-depth:
the resolver also falls back to the default on a schema mismatch). Tailwind v4
`@theme` utilities reference these variables via `var(--color-brand)`, so existing
`text-brand` / `bg-brand` / `outline-brand` utilities pick up the override
live. `globals.css` keeps its current `@theme` values as the bundled fallback.

### 5. config.ts

Unchanged. These settings have no env vars; their seed defaults are literals in the
registry.

## Testing

- **Registry test:** the two `branding.*` entries are valid; `branding.brandColor`
  default passes its hex regex; `branding.appName` default passes `min(1)`.
- **Resolver tests:** each key resolves env default → DB override (extend the
  table-driven approach). A bad stored color (e.g. `"red"`) falls back to the
  default (Phase 0 invalid-value behavior).
- **Color-style helper:** if the `<style>` string is built by a small pure helper
  `brandStyleVars(hex): string`, unit-test it emits the 5 variables with the hex
  interpolated and the `color-mix` expressions. (Keeps layout.tsx thin and the
  string testable.)
- **Settings page:** the `color` input renders for `branding.brandColor` (a light
  render assertion is optional given the repo does not unit-test server
  components; covered by manual smoke).
- **Manual smoke:** change app name → browser tab + login reflect it; change brand
  color → buttons/links/accents recolor, including the derived hover/light shades.

## Risks & mitigations

- **CSS injection via brandColor** — prevented by the strict hex schema on write +
  resolver fallback on read. Only `#rrggbb` ever reaches the `<style>`.
- **`color-mix` browser support** — supported in all current evergreen browsers
  (2023+). The clinic app targets modern browsers; acceptable. Fallback: the raw
  `--color-brand` still applies even if a browser ignores `color-mix` (variants
  would be unset and inherit, a cosmetic degradation only).
- **Metadata going dynamic** — `generateMetadata` runs per request; it reads one
  cached setting (30s TTL), negligible cost.

## Files (anticipated)

- `src/platform/settings/registry.ts` — `color` input type + 2 entries.
- `src/app/admin/settings/page.tsx` — render the `color` input branch.
- `src/app/layout.tsx` — `generateMetadata` for app name + `<style>` brand override.
- `src/platform/ui/brand-style.ts` (new, small) — `brandStyleVars(hex)` helper + test.
- `src/app/login/page.tsx`, `src/app/admin/page.tsx`, `src/app/admin/people/new/page.tsx` — app-name reads.
- `src/platform/settings/*.test.ts` — registry + resolver + helper tests.
