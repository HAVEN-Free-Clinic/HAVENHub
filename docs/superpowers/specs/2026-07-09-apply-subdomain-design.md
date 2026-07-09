# Apply Portal Custom Subdomain (apply.havenfreeclinic.org)

Date: 2026-07-09
Status: Approved design, pending implementation plan
Branch: `feat/apply-subdomain`

## Summary

Serve the public application portal from `apply.havenfreeclinic.org` instead of
`<hub>/apply`, without moving the code. The portal stays part of the single
Next.js app; a host check in `src/proxy.ts` rewrites the portal host onto the
existing `/apply` route tree so URLs stay clean (`apply.havenfreeclinic.org/<slug>`).
All portal authentication happens on that host with host-scoped cookies, so the
hub's existing login is left completely untouched.

## Goals

- `apply.havenfreeclinic.org` serves the portal home; `apply.havenfreeclinic.org/<slug>` serves a cycle's application form.
- Both portal auth paths work on the subdomain: magic-link (new applicants) and Yale SSO (returning applicants renewing/transferring).
- The shared/copyable public application link points at the subdomain.
- The hub's login and session behavior are unchanged (no global cookie change, nobody gets logged out).
- `<hub>/apply` keeps working (backward compatibility for existing links and in-flight applicant cookies).

## Non-goals (YAGNI)

- No cross-domain (`.havenfreeclinic.org`) session-cookie sharing. Not needed once the portal is self-contained.
- No redirect from `<hub>/apply` to the subdomain (kept working, not forced).
- No rewrite of every internal `<Link href="/apply/...">`. Internal navigation keeps the `/apply` prefix (still works via pass-through); only the canonical/shared links use the subdomain.
- No change to the `app.baseUrl` **setting value** (it still feeds unrelated hub emails: reminders, interviews, onboarding). The magic-link builder stops reading it as its primary source (see below), but the stored setting is untouched.

## Context (verified in code)

- Routing: `src/proxy.ts` (Next 16 `proxy`, Node runtime). Today it only stamps `x-pathname`; matcher `["/((?!api|_next/static|_next/image|favicon.ico).*)"]`.
- Auth: `src/platform/auth/auth.ts` uses `trustHost: true`, no custom `cookies`/`domain`, JWT session. No `AUTH_URL`/`NEXTAUTH_URL` referenced in the repo. Entra provider id is `microsoft-entra-id` (callback path `/api/auth/callback/microsoft-entra-id`).
- Portal applicant cookie: set in `src/app/apply/verify/route.ts` (`APPLICANT_COOKIE`, `httpOnly`, `secure`, `sameSite: lax`, `path: /`, no domain -> host-scoped).
- Magic link: built in `src/modules/recruitment/services/portal-auth.ts` (~L136-142) as `${await getSetting("app.baseUrl")}/apply/verify?token=...`.
- Same-origin guards: `safeNextPath` (`src/modules/recruitment/services/portal-next.ts`) and `safeCallbackUrl` (`src/app/login/page.tsx`) validate against a base origin; both are satisfied by relative paths, which is what the portal uses.
- Shared public link: `src/app/(app)/recruitment/cycles/[id]/page.tsx:50` -> `const applyUrl = \`/apply/${cycle.publicSlug}\`` (relative, resolves to the hub today).
- Slug creation: `src/app/(app)/recruitment/actions.ts` via `slugify(...)`.

## Architecture

### 1. Host-based routing (`src/proxy.ts`)

Keep the existing `x-pathname` stamping. Add: if the request `Host` equals the
configured portal host, rewrite non-prefixed portal paths onto `/apply`.

Portal host source: `config.PORTAL_BASE_URL` (parsed to a hostname). Read from
`process.env` at the proxy layer (no DB call in proxy).

Rewrite rule on the portal host:
- Pass through unchanged when the pathname:
  - starts with `/apply`, `/api`, `/login`, `/_next`, `/brand`, or
  - is a reserved word (see below), or
  - looks like a static file (has a file extension, e.g. `/favicon.ico`, `*.webp`).
- Otherwise `NextResponse.rewrite` to `/apply` + pathname:
  - `/` -> `/apply`
  - `/<slug>` -> `/apply/<slug>`

Non-portal hosts: behavior unchanged (only `x-pathname` stamping).

Note: rewrite preserves the browser URL (stays pretty); pass-through means
`/apply/*`, `/login`, `/api/auth/*`, and assets resolve normally on the subdomain.

### 2. Single source of truth for the portal origin

The portal origin is deploy/DNS configuration and the proxy layer cannot read
the DB, so it lives in **one env var**, not a settings row.

- `config.ts`: add `PORTAL_BASE_URL: z.string().url().optional()` (e.g. `https://apply.havenfreeclinic.org`). No `settings/registry.ts` change.
- Pure helper `buildPortalUrl(portalBase: string | undefined, appBase: string, slug?): string`:
  - When `portalBase` is set (portal live): pretty form `${portalBase}/${slug}` (proxy rewrites `/slug` -> `/apply/slug`), or `${portalBase}` with no slug.
  - When `portalBase` is unset (pre-launch fallback): `${appBase}/apply/${slug}` (the working hub path), or `${appBase}/apply`.
- Async wrapper `portalUrl(slug?): Promise<string>` reads `config.PORTAL_BASE_URL` and the `app.baseUrl` setting, then calls `buildPortalUrl`. Used for canonical/shared links from server components.

### 3. Auth stays self-contained on the subdomain

- Magic link: in `portal-auth.ts`, pick the email base URL by **matching the request host against known hosts**, never by interpolating the raw `Host` (which `config.ts`/`portal-auth.ts` deliberately treat as attacker-controllable). Pure helper `pickPortalEmailBase(requestHost, portalBase, appBase)`: if `requestHost` equals the host of `portalBase`, return `portalBase`; otherwise return `appBase`. The result is always one of two trusted, configured values. The verify URL keeps its `/apply/verify` path (`${base}/apply/verify?...`), so on the subdomain it is `https://apply.havenfreeclinic.org/apply/verify?...` and its cookie lands on the subdomain. Rationale: the applicant cookie must be set on the host the applicant is using, and this selects the subdomain base only when the applicant is verifiably on the subdomain, without ever trusting the header's contents.
- Yale SSO: the portal's existing relative `/login?callbackUrl=/apply/<slug>...` links pass through on the subdomain. Entra returns to `apply.../api/auth/callback/microsoft-entra-id`; the JWT session cookie is host-scoped to the subdomain; `auth()` on the subdomain reads it. `safeCallbackUrl`/`safeNextPath` already accept the relative targets used here, so no validation change is needed (everything is same-origin on the subdomain).

### 4. Guardrails

- Reserve slug words so a cycle slug can never shadow a pass-through path: `login`, `api`, `verify`, `brand`, `apply`, `_next`, `favicon` (kept in one exported constant shared with the proxy pass-through check). Enforced at cycle-slug creation (`recruitment/actions.ts` / `slugify` call site): a reserved slug is **rejected with a validation error** (publicSlug is user-editable in the new-cycle form, so a clear error is predictable and testable; slugified titles realistically never produce these exact words).
- Shared public link: `cycles/[id]/page.tsx:50` uses `portalUrl(slug)` so directors copy `apply.havenfreeclinic.org/<slug>`.

## Flows

- **New applicant (magic link):** visits `apply.havenfreeclinic.org/<slug>` -> `/apply/<slug>` -> not identified -> redirect `/apply?next=/apply/<slug>` (subdomain) -> requests email link -> email link points at the subdomain -> `/apply/verify` sets applicant cookie on the subdomain -> back to the form. All same host.
- **Returning applicant (Yale SSO):** on the subdomain form, "Sign in with Yale" -> subdomain `/login` -> Entra -> subdomain callback -> session cookie on subdomain -> back to `/apply/<slug>?type=renewal`. Hub untouched.
- **Shared link:** director copies `portalUrl(slug)` = `apply.havenfreeclinic.org/<slug>` from the cycle admin page.

## Edge cases

- Slug collides with a pass-through word: prevented by slug reservation.
- Static assets (`/brand/login-building.webp`) on the subdomain: excluded from rewrite (file-extension / `/brand` pass-through), served normally.
- `<hub>/apply` still works everywhere (no rewrite on non-portal hosts).
- Preview deploys: `PORTAL_BASE_URL` unset -> proxy does no host rewrite; `portalUrl()` falls back to `${app.baseUrl}/apply/<slug>`; the magic-link host never matches the (unset) portal host so it uses `app.baseUrl`. This is exactly today's behavior (the magic link already uses `app.baseUrl`), so no regression.
- `AUTH_URL`/`NEXTAUTH_URL`: must not be pinned to a single host in Vercel env (rely on `trustHost`), else SSO callbacks break on the subdomain. Preflight check.

## Out-of-band steps (owner: Jack)

1. Vercel: attach `apply.havenfreeclinic.org` to the project (reported done) and set env `PORTAL_BASE_URL=https://apply.havenfreeclinic.org` (Production + Preview as desired).
2. Azure/Entra: add redirect URI `https://apply.havenfreeclinic.org/api/auth/callback/microsoft-entra-id` to the Yale SSO app registration.
3. Preflight: confirm `AUTH_URL`/`NEXTAUTH_URL` is not set (or not host-pinned) in Vercel env.

## Testing

- Unit (`proxy`): on the portal host, `/` and `/<slug>` rewrite to `/apply` and `/apply/<slug>`; `/api/...`, `/login`, `/apply/...`, `/brand/x.webp`, and reserved words pass through; on a non-portal host nothing is rewritten and `x-pathname` is still stamped.
- Unit: `buildPortalUrl()` produces the pretty form when a portal base is set and the `/apply`-prefixed hub form when it is unset; slug reservation rejects reserved words at cycle creation.
- Unit: `pickPortalEmailBase()` returns the portal base only when the request host matches the portal host, otherwise the app base (and never interpolates an arbitrary host).
- Manual/e2e on a preview with `PORTAL_BASE_URL` set: complete the new-applicant magic-link flow and the returning Yale-SSO flow entirely on the subdomain; confirm the copyable public link is the subdomain.

## Rollout

1. Merge with `PORTAL_BASE_URL` unset -> no behavioral change (portal still at `/apply`, links on hub).
2. Add the Azure redirect URI.
3. Set `PORTAL_BASE_URL` (and Vercel domain) -> subdomain goes live; run the two auth flows on the subdomain before announcing.
