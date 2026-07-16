# In-app GitBook help widget (adaptive-auth embed)

- **Date:** 2026-07-15
- **Status:** Approved (brainstorming), pending implementation plan
- **Author:** Jack C (with Claude)
- **Related prior work:** PR #289 GitBook adaptive access; `docs/superpowers/specs/2026-07-13-gitbook-adaptive-docs-access-design.md`

## Summary

Add a global "Help" launcher to the authenticated app shell that opens GitBook's
embedded Assistant + Search + Docs panel (`@gitbook/embed/react`). The panel is
authenticated with the **same** adaptive visitor JWT the app already mints for the
docs redirect flow, so users see only the content their permissions allow. The
launcher lightly seeds the assistant with context derived from the current module.

This is additive. The existing `/api/gitbook/auth` redirect flow (used when someone
visits `docs.havenfreeclinic.org` directly) is unchanged in behavior; it is only
refactored to share the JWT-minting helper.

## Background

The current state (verified in code):

- **`src/app/api/gitbook/auth/route.ts`** is GitBook's custom visitor-auth "Login
  URL". It signs a short-lived HS256 JWT (raw-UTF-8 HMAC via `node:crypto`, no
  `jsonwebtoken` dependency) using `config.GITBOOK_JWT_KEY`, then **302-redirects**
  the visitor back to `config.GITBOOK_SITE_URL` with `?jwt_token=...`. The payload
  is `{ name, email, iat, exp (now + 1h), ...buildAdaptiveClaims(perms, derived) }`.
- **`buildAdaptiveClaims`** (`src/platform/gitbook/adaptive-claims.ts`) returns
  `{ can: { <module>: { <action>: boolean } } }`. Two data-driven leaves
  (`schedule.manages_any_dept`, `schedule.manages_any_rhd_dept`) are computed in the
  route from `canManageAnyScheduleDept` / `canManageAnyRhdDept` and passed in.
- **`getEffectivePermissions(personId)`** (`src/platform/rbac/engine.ts`) is the
  permission source feeding the claim.
- There is **no in-app docs/help surface** today, and **no app-wide CSP** (only
  per-asset response headers on a few file-serving routes), so an embed iframe is
  not blocked.
- Stack: Next.js 16.2.7, React 19.2.4, npm, App Router with an `(app)` layout group;
  `AppShell` (`src/platform/ui/app-shell.tsx`) renders the persistent toolbar.

The blocker for embedding: the JWT logic lives inside a route that redirects away, so
it cannot hand a token to a client component as-is. The embed needs
`visitor={{ token }}` on the client.

## Decisions (from brainstorming)

1. **Surface:** a global Help launcher in the app shell (no dedicated `/docs` page).
2. **Capabilities:** the full `assistant` + `search` + `docs` tab experience.
3. **Context:** light context-seeding, deriving the current module from the URL and
   seeding the assistant's greeting/suggestions. No brittle route-to-docs-page map.
4. **Token delivery:** a JSON token endpoint (approach A below), not a server prop.
5. **Placement:** a toolbar icon-button in the `AppShell` right cluster next to
   `NotificationBell` (not a floating bottom-right FAB).

## Goals

- Users can open GitBook Assistant/Search/Docs from anywhere in the authenticated app.
- The embed is authenticated with the existing adaptive visitor JWT; no second auth
  model, no schema change, and no change to the committed `adaptive-schema.json`.
- One source of truth for the visitor JWT shape, shared by the redirect route and the
  embed.
- Long-lived sessions keep working (token refreshed before its 1h expiry).
- The launcher renders only when GitBook is configured; it is invisible otherwise.

## Non-goals (YAGNI)

- No dedicated in-app `/docs` browsing page.
- No app-route to docs-page deep-link map.
- No behavioral change to the existing `/api/gitbook/auth` redirect flow.
- No database or Prisma schema changes; no change to the adaptive schema/catalog.
- No new authentication mechanism; the embed reuses the existing key and claims.

## Architecture

### Token delivery: JSON endpoint (approach A)

The app shell persists across soft navigations and does not re-render, so a token
passed once as a server prop would go stale after 1h and the panel would silently
break (approach B, rejected). Instead:

- New **`GET /api/gitbook/embed-token`** returns `{ token, expiresAt }` as JSON.
- The client fetches it when the panel first opens and re-fetches before `expiresAt`
  (and on any embed-signalled token-expiry, if the frame exposes such an event).

### Data flow

```
HelpLauncher (client, in AppShell)
  -> on open: fetch GET /api/gitbook/embed-token
       -> auth() -> resolve active person
       -> mintVisitorToken(person, { email })  [shared helper]
            -> getEffectivePermissions + 2 derived schedule claims (Promise.all)
            -> signJwt({ name, email, iat, exp, ...buildAdaptiveClaims(...) }, GITBOOK_JWT_KEY)
       -> { token, expiresAt }
  -> render GitBookProvider siteURL + GitBookFrame visitor={{ token }}
       tabs=['assistant','search','docs'], colorScheme, greeting/suggestions (module-seeded)
  -> before expiresAt: re-fetch token
```

## Components

### 1. `src/platform/gitbook/visitor-token.ts` (new; refactor target)

Extract from `api/gitbook/auth/route.ts`: `base64url`, `signJwt`, and the payload
assembly (perms + the two derived schedule claims + `buildAdaptiveClaims` + name/
email/iat/exp).

```ts
export interface VisitorToken {
  token: string;
  expiresAt: number; // epoch ms, for client-side refresh scheduling
}

// Reads config.GITBOOK_JWT_KEY; throws if unset (callers translate to 503).
export async function mintVisitorToken(
  person: { id: string; name: string; contactEmail: string | null },
  opts?: { email?: string | null }
): Promise<VisitorToken>;
```

- One place computes `getEffectivePermissions` + `canManageAnyScheduleDept` +
  `canManageAnyRhdDept` (via `Promise.all`), builds claims, signs, and returns
  `{ token, expiresAt }`.
- The claim shape and 1h expiry are identical to today, so existing GitBook adaptive
  conditions and tests are unaffected.

### 2. `src/app/api/gitbook/auth/route.ts` (refactor, behavior unchanged)

Replace the inline signing block with `mintVisitorToken(person, { email: session.user?.email })`,
then continue with the existing `resolveTarget` + `?jwt_token=` redirect and the
`gitbook.visitor_auth` audit. `signJwt` and `base64url` move into the shared helper
(the route no longer references them directly, since `mintVisitorToken` owns
signing). `resolveTarget` stays local to this route, as it is redirect-specific.

### 3. `src/app/api/gitbook/embed-token/route.ts` (new)

```ts
export const runtime = "nodejs";
export async function GET(): Promise<Response>;
```

- If `!GITBOOK_JWT_KEY || !GITBOOK_SITE_URL` -> `503` JSON.
- `auth()`; if no `session.personId` -> `401` JSON (the client shows a
  "please sign in" state; it does not redirect the way the docs flow does).
- `getActivePerson`; if none -> `403` JSON.
- `mintVisitorToken(person, { email: session.user?.email })` -> return
  `{ token, expiresAt }` with `Cache-Control: no-store`.
- **No per-open audit.** The panel opens/refreshes frequently; the redirect flow
  already audits real doc visits. (If issuance auditing is later wanted, debounce it.)

### 4. `src/platform/ui/help/HelpLauncher.tsx` (new, client component)

- Icon-button (lucide `LifeBuoy` or `CircleHelp`) styled like the existing toolbar
  icon-buttons, rendered in the `AppShell` right cluster beside `NotificationBell`.
- Toggles a panel: a glass-consistent container, bottom-right sheet on desktop and a
  full-screen sheet on mobile, matching the app's design-system radii/material.
- Loads the embed lazily and SSR-safe:
  `dynamic(() => import('@gitbook/embed/react'), { ssr: false })`.
- Renders `GitBookProvider siteURL={siteURL}` wrapping
  `GitBookFrame visitor={{ token }} tabs={['assistant','search','docs']}
  colorScheme={resolvedTheme} closeButton greeting={...} suggestions={...}`.
- **Token lifecycle:** fetch `/api/gitbook/embed-token` on first open; store
  `{ token, expiresAt }`; schedule a refresh slightly before `expiresAt` while the
  panel is mounted; handle 401/503 with a small inline message. `Date.now()` is used
  only inside effects/handlers (not render), consistent with the react-hooks purity
  lint rule.

### 5. Context seeding

- `HelpLauncher` reads `usePathname()` and maps the first path segment to a module
  title using a serializable `Record<string, string>` (segment -> title) **passed
  down from the server** (built from `MODULES` in the shell). Passing it as a prop
  avoids drift from the registry and sidesteps the "use client" plain-data-proxy
  trap (importing server constants into a client module).
- The mapped title seeds `greeting` and `suggestions`, e.g. an "Ask about
  Recruitment" suggestion when the path is under `/recruitment`. When no segment
  matches, fall back to a generic greeting.

### 6. Shell wiring: `src/platform/ui/app-shell.tsx`

- `AppShell` (server) reads `config`. Only when **both** `GITBOOK_SITE_URL` and
  `GITBOOK_JWT_KEY` are set does it render `<HelpLauncher siteURL={...}
  moduleLabels={...} />` in the right cluster. Otherwise the launcher is omitted.
- The `moduleLabels` map is derived from `MODULES` here (server side) and passed as a
  plain serializable prop.

## Config / environment

- Reuse `config.GITBOOK_SITE_URL` and `config.GITBOOK_JWT_KEY`
  (`src/platform/config.ts`). Both are currently **absent from `.env.example`**; add
  them with explanatory comments.
- **Reconcile `GITBOOK_SITE_URL`.** The embed's `siteURL` must equal the published
  site URL exactly. The config comment references a `gitbook.io` base while the
  public host is `docs.havenfreeclinic.org`. Confirm the production value and that it
  is the URL GitBook serves the embed from before shipping. The embed `siteURL` and
  the redirect target should be the same published URL.

## External prerequisites (GitBook dashboard, non-code)

- Embedding and the AI Assistant must be enabled on the GitBook site/plan (the
  Assistant tab requires it).
- If GitBook enforces an embed-origin allowlist, add the app's origin(s).
- Visitor/adaptive-content auth is already configured for the redirect flow; the
  embed reuses the same signing key and claim shape, so no additional GitBook auth
  setup and no schema change are required.

## Security

- The token endpoint requires an authenticated, active person; unauthenticated
  requests get `401` (no token issued).
- Tokens remain short-lived (1h) and `no-store`.
- Claims are unchanged, so the existing least-privilege adaptive gating still governs
  what the embed can show.
- No app-wide CSP exists today. If one is added later, the GitBook embed origin(s)
  must be allowlisted in `frame-src`/`connect-src`/`script-src`.

## Testing

- **`visitor-token.test.ts`** (new/relocated): claim shape (`can.<module>.<action>`),
  derived schedule leaves, `iat`/`exp` (1h), and that a decoded HS256 signature
  verifies against the key.
- **`api/gitbook/auth/route.test.ts`**: keep green; assert redirect behavior is
  unchanged after the refactor.
- **`api/gitbook/embed-token/route.test.ts`** (new): `503` when unconfigured, `401`
  when unauthenticated, `403` when no active person, `200` returning
  `{ token, expiresAt }` with valid claims and `no-store`.
- **Client:** a light unit test that pathname -> seeded suggestion mapping is correct;
  mock the `dynamic` embed import so the third-party frame is not exercised.
- **Unaffected, must stay green:** `schema-artifact.test.ts`, `catalog.test.ts`,
  `adaptive-claims.test.ts` (no claim/schema change).

## Open items to verify during implementation

- Exact `@gitbook/embed` package version and prop names at install (adjust
  `GitBookFrame`/`GitBookProvider` props if they differ from the doc summary).
- Whether `GitBookFrame` emits a token-expiry/refresh event to hook the re-fetch
  into; otherwise use timer-based refresh keyed on `expiresAt`.
- The concrete production value of `GITBOOK_SITE_URL`.

## Rollout

- Ship behind config: with `GITBOOK_*` unset in an environment, the launcher does not
  render and the endpoint 503s, so the feature is inert until enabled.
