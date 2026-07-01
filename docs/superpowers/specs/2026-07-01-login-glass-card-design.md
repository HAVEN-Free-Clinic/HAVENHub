# Login page: centered glass card over a softened brand backdrop

Date: 2026-07-01
Status: Design (awaiting user review)

## Problem

The current login page (`src/app/login/page.tsx`) is a two-column layout: a left brand panel (the Yale Physicians Building photo under a heavy Yale-blue overlay, the `HavenLogo` lockup, and a marketing tagline plus org line) and a right panel holding the sign-in content. The user wants the page restyled into a single centered card that floats over a soft, airy background (in the spirit of a reference mockup), while keeping app-wide styling consistent and keeping the login content the same.

The app already has the material this needs: a Liquid Glass system (`glass-panel`, defined in `src/app/globals.css`) used on modals, nav, and popovers, which is exactly the frosted floating-card look the reference shows, with a built-in dark-mode variant.

## Goal

Transform the login page into a single centered glass card floating over a softened, airy version of the existing brand photo background, reusing the app's glass material, primitives, and design tokens. Preserve the sign-in content and behavior. Drop the marketing tagline (and its footer caption) as unnecessary.

## The design

### Layout

One full-screen container replaces the two-column grid:

- **Background:** the existing `/brand/login-building.webp`, full-bleed (`fill`, `object-cover`), re-tuned to read airy rather than heavy: a lighter brand tint (well below the current `bg-brand/70`) plus a soft gradient that brightens the vertical center so the glass card reads clearly, with gentle Yale-blue at the edges. This is a fixed brand scrim, so it does not flip between light and dark mode. Reuses the existing asset and the existing overlay approach (inline Tailwind layers), just tuned lighter.
- **Brand mark:** `HavenLogo` (white) pinned top-left over the background, echoing the reference's top-left brand lockup. (`HavenLogo` is a wide lockup, so it stays a lockup, not a square badge.)
- **The card:** vertically and horizontally centered, about `max-w-sm`, built on `glass-panel` plus `rounded-2xl` and a soft shadow. Card padding roughly `p-8`. Content sits solid on top of the glass (no glass-on-glass, per the Liquid Glass rule).

### Card contents (same content, restyled and centered)

Top to bottom, all centered:

1. A small rounded badge (about `h-12 w-12`, `rounded-xl`, a solid/near-white surface with a subtle border or shadow) containing a Lucide `LogIn` icon, mirroring the reference's sign-in glyph. Decorative (`aria-hidden`).
2. Title: `Sign in to {appName}` (`h1`, bold, centered). `appName` from `getSetting("branding.appName")` as today.
3. Subtitle: `Use your Yale account to continue.` (muted, centered).
4. Error alert when `error` is present: the same critical-tone message the page shows today (`role="alert"`), full width inside the card.
5. Primary action: the `SignInButton` ("Sign in with Yale") inside the existing Entra sign-in `form` (unchanged server action). When `AZURE_AD_CLIENT_ID` is unset, the existing "Entra ID is not configured" warning shows instead, as today.
6. Support link: `Trouble signing in? {support.label}` via `SupportLink`, shown only when a support email is configured (unchanged condition), centered and muted.
7. Dev-only local-credentials form: kept, at the bottom of the card behind its subtle top divider, gated on `NODE_ENV !== "production" || DEMO_MODE` exactly as today (the "Local development" label, the email `Field`/`Input`, and the outline "Dev sign in" `Button`).

No footer caption below the card: the marketing tagline (`One platform for the clinic.` / `Scheduling, volunteer management, and compliance in one place.`) and the org line are removed. Brand identity remains via the top-left `HavenLogo` and the `{appName}` in the title.

### Responsive

The centered single card is inherently responsive and replaces today's separate mobile brand band. On small screens the card goes near full width with comfortable padding; the top-left logo shrinks. No separate mobile layout branch is needed.

### Theming (light and dark)

- The background photo plus brand tint is a fixed brand scrim (non-flipping), correct in both modes, consistent with the theming non-flip rule.
- `glass-panel` already ships a dark-mode variant, so the card adapts automatically.
- All card text uses semantic tokens (`foreground`, `foreground-soft`, `muted-foreground`, `critical`, etc.), so it is theme-aware. The top-left logo is white on the dark-ish brand backdrop (non-flipping). The badge and icon use tokens.
- The airy background must keep the top-left white logo legible; if needed, weight the gradient slightly heavier in the top-left corner so the logo always has contrast.

### Primitives and tokens reused (app-wide consistency)

`glass-panel` (card material), Card radii (`rounded-2xl`), `Button` (the primary sign-in and the dev outline button), `Input` / `Field` / `FormActions` (dev form), `HavenLogo`, brand tokens (`bg-brand`, `bg-brand-deep`) and semantic text tokens, Lucide icons, the Hanken typeface, standard focus rings. No em-dashes. "HAVEN Hub" naming. The Liquid Glass rules: glass on the card container only, content solid, no glass-on-glass.

### Accessibility

The card is the page's main region with the `h1` title inside it. `HavenLogo` keeps its `aria-label`. The icon badge is decorative (`aria-hidden`). The error keeps `role="alert"`. The support link and buttons keep accessible text and focus-visible rings. Contrast: glass leans opaque so card text stays legible over the background; verify the "Sign in with Yale" button and body text meet contrast in both modes during QA.

## Non-goals

- No email plus password primary fields, and no Google / Facebook / Apple social buttons: the app authenticates via Yale SSO (Entra ID) plus a dev-only credentials form. These are not added.
- No "Ebolt" branding or "Make a new doc" style copy from the reference.
- The marketing tagline and org-line footer are removed (per the user), not relocated.
- No change to auth logic, the safe-callback-URL handling, the server actions, or the content strings that are kept.

## Files

- `src/app/login/page.tsx`: restructure the layout (single full-bleed softened photo background, top-left `HavenLogo`, one centered `glass-panel` card holding the existing content, no footer caption). Identical data loading (`auth`, `getSetting`, `getOrgIdentity` may no longer be needed if the tagline/org line are gone, so drop the now-unused `getOrgIdentity`/`formatOrgLine` import if nothing else uses them), identical server actions, identical kept content strings.
- `src/app/login/sign-in-button.tsx`: unchanged (already the `Button` primitive with a pending state).
- No new global CSS (the `glass-panel` class already exists). Background layers use inline Tailwind, matching the current file's approach.

## Testing and verification

- `npm run lint` green (em-dash rule and controls rule pass; no raw styled controls introduced). `npx tsc --noEmit` no new errors in the changed file.
- Preserve the existing accessible roles and text so the login e2e spec (`e2e/login.spec.ts`) still passes: the `Sign in to {appName}` heading, the "Sign in with Yale" button, the error path, the support link, and the dev sign-in form must remain findable by their current text/roles. If a selector depends on removed markup (the left panel), update the spec minimally to match the new single-card structure.
- Behavior unchanged: signing in via Entra, the error redirect, the support link, and the dev credentials sign-in all work exactly as before.
- Deferred to QA (needs the running app): a light and dark visual pass confirming the airy background, glass card legibility, and top-left logo contrast; a mobile-width check.

## Risks and mitigations

- **Background too light or too heavy:** the airy tint must balance the reference's soft feel against logo/card legibility. Mitigation: layer a base brand tint plus a center-brightening gradient plus a top-left contrast weight; tune during visual QA.
- **Dark mode:** relying on `glass-panel`'s built-in dark variant and semantic tokens avoids a bespoke dark path; the fixed brand backdrop does not flip.
- **e2e selectors:** the restructure could break a spec that keyed off the left panel; keep kept content's text/roles stable and adjust the spec only where markup genuinely moved.

## Open questions

None blocking.
