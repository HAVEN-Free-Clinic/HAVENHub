# Open Graph metadata: site-wide branded cards + per-module dynamic details

Date: 2026-07-12
Branch: `feat/open-graph-metadata`
Status: Approved design, pre-implementation

## Problem

The Hub currently ships **no** Open Graph or Twitter metadata. The root
`src/app/layout.tsx` `generateMetadata` sets only `title`, `description`, and
`icons`, and there is no `metadataBase`. When a Hub link is pasted into Slack,
Teams, iMessage, or posted anywhere that unfurls links, it renders a bare,
unbranded preview (or nothing). We want:

1. A consistent branded social card on every link, using the Yale Physicians
   Building photo as the image.
2. Dynamic per-page details (title + description) so pages read as themselves,
   both in the browser tab and, where the page is public, in the unfurled card.

## Reality that shapes scope

Almost the entire Hub sits behind a login gate. An unauthenticated unfurl
scraper hitting a deep link (for example `/learning`) is redirected to
`/login`, so it unfurls the **login** card, not the deep page. Therefore:

- The **image + app-name card** is the high-value, universal win: every shared
  link shows a branded card (gated links via the login redirect).
- **Per-page tab titles** improve everywhere (the browser always renders the
  real page's metadata for the signed-in user).
- **Per-page OG text** only reaches outside scrapers on genuinely public routes
  (`/login`, `/apply/*`, error pages). We still author it for the top-level
  modules because it is cheap (mostly reused copy) and correct.

Chosen scope (user-approved): **Foundation + per-module titles.** Not every deep
route; not a bare global card either.

## Design

### 1. Shared metadata helper

New module `src/platform/branding/metadata.ts`:

```ts
export async function buildPageMetadata(
  opts?: { title?: string; description?: string },
): Promise<Metadata>
```

It reads `branding.appName`, `branding.orgName`, and `app.baseUrl` from settings
(same source as the rest of branding) and returns a **complete** `Metadata`
object every call:

- `metadataBase: new URL(baseUrl)` so the relative image path resolves absolute.
- `title`:
  - **Root call** (no `title`): `{ default: appName, template: "%s · appName" }`
    so child pages that set a plain-string `title` get suffixed for the tab.
  - **Child call** (`title` given): the raw string (root template suffixes it).
- `description`: the given description, else `The unified platform for {appName}`.
- `openGraph`: `title` (pre-composed as `"{title} · {appName}"` for children,
  or `appName` for root), `description`, `siteName: appName`, `type: "website"`,
  and `images: [{ url: "/brand/og-image.jpg", width: 1200, height: 630, alt }]`.
- `twitter`: `card: "summary_large_image"`, `title`, `description`, same image.

**Why a helper that returns a complete card every call** (rather than leaning on
Next.js parent to child metadata merging): a child segment that defines
`openGraph` silently drops the parent's `openGraph.images`. Returning a full card
per opt-in segment sidesteps that gotcha entirely. Segments that do not opt in
still inherit the root's full card, because root is always in the tree.

Separator is the middle dot ` · ` (no em-dashes anywhere).

The helper is pure of side effects beyond `getSetting`, so it is unit-testable
with a mocked `getSetting`, matching `org.test.ts` / `assets.test.ts`.

### 2. The OG image

Generate a dedicated **`public/brand/og-image.jpg`**: a 1200x630, center-cropped
JPG derived from the existing `public/brand/login-building.webp` (the Yale
Physicians Building photo already used by `BrandBackdrop` on `/login` and
`/apply`).

Rationale:
- 1200x630 is the OG standard aspect; the source is a different ratio and would
  be cropped unpredictably by each platform otherwise.
- **JPG** unfurls reliably everywhere; WebP is inconsistent on Facebook,
  LinkedIn, iMessage, and Teams.
- A cropped JPG lands around ~200 KB versus the source's 1.1 MB, so it stays
  under scraper size caps and unfurls fast.

Generated with `sharp` (already a transitive dependency via Next) at build-of-
asset time, committed as a static file. Center crop matches the backdrop's
`object-center`.

### 3. Wiring

- **`src/app/layout.tsx`**: replace inline `generateMetadata` body with
  `buildPageMetadata()`, then re-attach the existing favicon `icons` config
  (spread over the helper result, or pass through). Favicon behavior is
  preserved exactly.
- **`src/app/apply/layout.tsx`**: return
  `buildPageMetadata({ title: applyPortalTitle, description: "Apply to {orgName}" })`.
- **Per top-level module**: add `generateMetadata` to each module's server-
  component `layout.tsx`, reusing the module registry's own `title` and
  `description` via `getModule(id)`:
  - schedule, volunteers, incidents, clinic, admin, recruitment, learning,
    support (all have a `layout.tsx` and a registry entry).
  - **my-info**: has a registry entry but no `layout.tsx`; add a metadata-only
    passthrough `layout.tsx` (server component that returns `children`, mirroring
    `apply/layout.tsx`).
  - **notifications**: no registry entry; add a metadata-only passthrough
    `layout.tsx` with literal copy (title "Notifications",
    description "Your notification inbox").
  - **dashboard** (`(app)/page.tsx`, the app home): add `generateMetadata`
    returning `buildPageMetadata({ title: "Dashboard" })` if it is a server
    component; otherwise leave it inheriting the root card.
- **`src/app/login/page.tsx`**: if a server component, add `generateMetadata`
  returning `buildPageMetadata({ title: "Sign in", description: "Sign in to {appName}" })`.

All module layouts confirmed to be server components (no `"use client"`), so
they can host `generateMetadata`. Nested subtrees (for example
`recruitment/cycles/layout.tsx`) are left alone and inherit their module card.

### 4. Tests

- `src/platform/branding/metadata.test.ts`: mock `getSetting`; assert
  - root call yields the title template and `appName` OG title,
  - child call yields raw `title` plus composed `"{title} · {appName}"` OG title,
  - `metadataBase` equals the configured `app.baseUrl`,
  - the image is `/brand/og-image.jpg` at 1200x630,
  - twitter card is `summary_large_image`.
- Verify `public/brand/og-image.jpg` exists and is 1200x630 (a small assertion
  or a manual check via `sharp`/`sips` during implementation).

## Out of scope (YAGNI)

- Dynamic per-request OG image generation (`ImageResponse`).
- Hand-authored cards for individual deep pages.
- Per-host `og:url` rewriting for the apply subdomain; `metadataBase` stays the
  main hub `app.baseUrl`. (Noted limitation: on the apply subdomain the image
  and `og:url` resolve against the main hub host, which is harmless since both
  are valid absolute URLs to a live host.)

## Risks / open items to confirm during implementation

- Exact Next.js title-template and `openGraph.title` merge behavior: confirm via
  current Next docs (context7) that the helper's approach produces the intended
  composed titles. The complete-card-per-call design is robust regardless.
- Confirm `login/page.tsx`, `get-started`, and the dashboard page are server
  components before adding `generateMetadata`; if any is a client component, add
  the metadata via a sibling server layout instead.
- Confirm `sharp` is resolvable for the one-off image generation; fall back to
  `sips` (macOS) if not.
