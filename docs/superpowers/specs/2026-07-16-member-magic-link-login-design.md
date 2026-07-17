# Member magic-link login (non-Yale members) — Design

- **Date:** 2026-07-16
- **Branch:** `worktree-feat+member-magic-link-login` (fresh from `origin/main` @ `5515d4b`)
- **Status:** Approved design, pre-implementation

## 1. Goal

Let an **already-active, non-Yale member** sign in to the HAVEN Hub with a one-time
email link ("magic link"), landing in the hub with a **real `personId` session** —
identical downstream to signing in with Yale. Anyone whose email is `@yale.edu` is
refused and pointed at "Sign in with Yale" (Entra).

This mirrors the *mechanics* of the existing applicant magic-link (`/apply` portal) but
targets a different outcome: **full hub access for existing members**, not an anonymous
applicant identity.

## 2. Non-goals (YAGNI)

- **No self-registration.** A link is only ever *issued* to an existing `ACTIVE` Person.
  The magic link cannot create accounts or grant access to strangers.
- **No per-IP rate limiting.** We match the existing portal precedent (per-email only).
  Called out as an accepted limitation (§7).
- **No changes to the `/apply` applicant magic-link.** That flow stays exactly as-is.
- **No multi-email-per-person.** `Person.contactEmail` remains a single unique column.

## 3. Background — how auth works today

(From codebase exploration; file refs are `path:line` at the branch base.)

- **Main hub session** = NextAuth / Auth.js v5, JWT strategy, 7-day cookie encrypted with
  `AUTH_SECRET`. The token carries `personId` (+ `applicantEmail` / `applicantFirstName`).
  Config + all three callbacks live in `src/platform/auth/auth.ts` (provider config
  ~62-70; jwt callback 104-173; session callback 174-179). Types augmented in
  `src/types/next-auth.d.ts`. Route handler `src/app/api/auth/[...nextauth]/route.ts`.
- **`requirePersonSession()`** (`src/platform/auth/session.ts:61-75`) is the universal
  server-side gate: no session → `/login`; no `personId` → `/welcome`; else
  `getActivePerson(personId)` (`src/platform/auth/match-person.ts:83-89`) which returns
  null unless `status === "ACTIVE"`, re-fetched **every render** so offboarding revokes
  access immediately. It also runs the onboarding gate.
- **"Yale login"** is Microsoft **Entra ID** (Azure AD), tenant-pinned OIDC — not CAS.
  The `signIn` callback admits any Yale-tenant account; `resolvePersonForLogin`
  (`match-person.ts:35-73`) maps identity → Person via `entraObjectId → netId → contactEmail`
  (the email match only fires when the claim is Yale-asserted, `@yale.edu`).
- **Applicant magic-link** (`src/modules/recruitment/services/portal-auth.ts`): 256-bit
  random token, only its SHA-256 hash stored in `ApplicantPortalToken`
  (`prisma/schema.prisma:1675`), 30-min TTL, single-use via atomic `updateMany`
  (`usedAt:null, expiresAt>now`), 3-per-15-min rate limit, peek-then-confirm verify page
  (`src/app/apply/verify/page.tsx`). It sets a *separate* signed `applicant_session` cookie
  carrying only `{email, exp}` — **no `personId`, no hub access** — and **any** email may
  request one (no existence check). This is the pattern we mirror, but with a member-scoped
  outcome and a strict existence/active gate.
- **Person** (`prisma/schema.prisma:101-213`): single `contactEmail` (unique,
  case-insensitive via a `LOWER()` partial index, and explicitly **may be a personal /
  non-Yale address**); `status` ∈ {`ACTIVE`, `OFFBOARDED`} (default `ACTIVE`); login keys
  `netId`, `entraObjectId`. No password column. No "external member" concept.
- **Login page** `src/app/login/page.tsx`: shows the Entra button when `AZURE_AD_CLIENT_ID`
  is set, plus a **dev/DEMO-only** email credentials form
  (`NODE_ENV !== "production" || DEMO_MODE`). Open-redirect guard on `callbackUrl` via the
  WHATWG URL API (`page.tsx:37-48`).
- **`safeNextPath`** open-redirect guard: `src/modules/recruitment/services/portal-next.ts`.
- **Email**: `queueEmail(prisma, {...})` (`src/platform/email/send.ts:39`) inserts an
  `EmailLog` row and schedules the flusher; templates registered per-category
  (e.g. `src/platform/email/templates/recruitment.ts:101` = `recruitment.portal_link`),
  admin-editable at `/admin/email/templates`; rendered via `renderEmail(key, vars)`.

## 4. Requirements

1. **Eligibility to receive a link** (approved): a `Person` exists with
   `status === "ACTIVE"` whose `contactEmail` equals the entered address
   (case-insensitive). **No** current-term-membership requirement.
2. **Yale block**: if the entered email is `@yale.edu`, do not issue a link; tell the user
   to use "Sign in with Yale".
3. **Session outcome**: on success the user gets a normal NextAuth Person session
   (`personId` set) — full RBAC, onboarding gate, and instant offboard revocation, with
   **zero changes** to `requirePersonSession` or downstream gates.
4. **Kill-switch** (approved): admin-configurable setting `auth.memberMagicLinkEnabled`
   (default `true`) in the existing settings registry, honored by both the issuer and the
   `/login` UI visibility.
5. **Enumeration-safe**: identical response whether or not the email matches an active
   member (generic "if eligible, we sent a link"). The Yale-block message is exempt (the
   `@yale.edu` domain is public and reveals nothing about membership).

## 5. Design

### 5.1 Architecture decision (approved)

**Approach A — a dedicated NextAuth credentials provider `member-magic-link`.** The confirm
step calls `signIn("member-magic-link", { token })`; the provider's `authorize` verifies +
atomically claims the token, re-checks the Person, and returns the Person. The existing jwt
callback then stamps `personId` exactly as it does for Yale/dev-credentials logins.
Rejected: (B) a separate signed cookie taught into `requirePersonSession` — forks the
session model across ~40 gate call-sites; (C) overloading the `/apply` portal link —
entangles open applicant identity with gated hub access.

### 5.2 Data model — `MemberLoginToken` (new)

Separate from `ApplicantPortalToken` (different trust level: this grants hub access).

```prisma
model MemberLoginToken {
  id         String    @id @default(cuid())
  emailLower String    // normalized email the link was issued for
  personId   String    // ACTIVE Person resolved at issue time
  tokenHash  String    @unique   // sha256 of the raw token; raw never stored
  expiresAt  DateTime
  usedAt     DateTime?
  createdAt  DateTime  @default(now())

  @@index([emailLower])
  @@index([personId])
}
```

`emailLower` is stored pre-lowercased → a plain btree index suffices (no `LOWER()`
expression index needed). Migration adds one table. **No `Person` relation for v1** —
consistent with `ApplicantPortalToken` (which has none); verify re-loads by `personId` and
re-checks, so a hard Person delete simply orphans dead token rows (harmless, single-use).

### 5.3 Service — `src/platform/auth/member-magic-link.ts` (new)

Mirrors the hardened `portal-auth.ts` helpers (`randomBytes(32).toString("base64url")`,
`sha256` hash, atomic single-use claim, 30-min TTL, 3/15-min rate limit). Small crypto
helpers (`hashToken`) are replicated locally to keep the module self-contained and avoid
churn in the recruitment module.

**`RequestResult`** = `{ status: "sent" } | { status: "use-yale" } | { status: "disabled" }`.

- **`requestMemberLoginLink(email, next?): Promise<RequestResult>`**
  1. If kill-switch off → return `{ status: "disabled" }` (UI hides the form; treat as no-op).
  2. Normalize: `email.trim().toLowerCase()`.
  3. If ends with `@yale.edu` → return `{ status: "use-yale" }` (no token, no email).
  4. Rate-limit: count `MemberLoginToken` for `emailLower` created in the last 15 min;
     if `>= 3` → return `{ status: "sent" }` **without** issuing (silent skip; no enumeration).
  5. Look up `Person` by `contactEmail` (case-insensitive `equals … mode:"insensitive"`)
     with `status: "ACTIVE"`. If none → return `{ status: "sent" }` (silent skip).
  6. Issue token: `randomBytes(32)` → raw; store `{ emailLower, personId, tokenHash,
     expiresAt: now+30min }`.
  7. Build `loginUrl = ${appBase}/login/verify?token=<raw>[&next=<safeNext>]` where
     `appBase` is the app base URL setting (the **hub host**, never the portal host);
     `next` appended only when `safeNextPath` accepts it.
  8. `renderEmail("auth.member_login_link", { firstName, loginUrl })` — `firstName` is
     **derived from `Person.name`** (first whitespace-delimited token; `Person` has only a
     single `name` column, no `firstName`), reusing any existing name-splitting helper —
     then `queueEmail(prisma, { to: person.contactEmail, subject, html, template })`.
  9. Capture PostHog `member_login_link_requested`.
  10. Return `{ status: "sent" }`.

- **`peekMemberToken(raw): Promise<{ email: string; name: string } | null>`** —
  read-only: validate hash against an unused/unexpired row, load the Person's `name` for the
  confirm screen. Does **not** consume.

- **`verifyAndConsumeMemberToken(raw): Promise<{ personId: string } | null>`** —
  atomic claim: `updateMany({ where: { tokenHash, usedAt:null, expiresAt:{gt:now} },
  data: { usedAt: now } })`; proceed only if `count === 1` (TOCTOU-safe). Then re-load the
  Person by the token's `personId` and **re-check**: `status === "ACTIVE"`,
  `contactEmail` (lowercased) `=== emailLower`, and not `@yale.edu`. If any check fails →
  return `null`. So an offboard, email change, or Yale-ification between issue and click
  kills the token.

### 5.4 NextAuth provider + jwt callback (`src/platform/auth/auth.ts`)

- Register a credentials provider with `id: "member-magic-link"`, **unconditionally**
  (in production too — unlike the dev credentials provider). Its
  `authorize({ token })` → `verifyAndConsumeMemberToken(token)`; on success return
  `{ id: personId }`, else `null` (→ `CredentialsSignin`).
- Extend the jwt callback's personId-stamping branch to also cover `member-magic-link`
  (set `token.personId = user.id`, leave `applicantEmail`/`applicantFirstName` null), so it
  reuses the existing audit event + PostHog `user_signed_in` firing. No other callback
  changes; `requirePersonSession` and all RBAC gates are untouched.

### 5.5 UI

- **`/login`** (`src/app/login/page.tsx`): add a secondary affordance below the Yale
  button — "Not a Yale member? Get a sign-in link by email" — rendered as a small client
  form (pattern: `src/app/apply/sign-in-form.tsx`) posting to a new server action
  `requestMemberLoginLinkAction(formData)`. The action reads a safe `callbackUrl`/`next`,
  calls `requestMemberLoginLink`, and renders:
  - `sent` → neutral "If that email belongs to an active member, we've sent a sign-in link."
  - `use-yale` → "That's a Yale email — use *Sign in with Yale* above."
  - The whole section is **hidden when the kill-switch is off**.
  - Kept visually/logically distinct from the dev credentials form (which remains
    `NODE_ENV !== "production" || DEMO_MODE`). Update the "Use your Yale account to
    continue" copy to acknowledge the non-Yale path.
- **`/login/verify`** (new page, public, `dynamic = "force-dynamic"`; pattern:
  `src/app/apply/verify/page.tsx`): peek-then-confirm.
  - GET reads `token` → `peekMemberToken`. Invalid/expired → friendly "This link is invalid
    or has expired — request a new one." Valid → "Sign in as **{name}** ({email})?" with a
    confirm form.
  - Confirm form's server action calls `signIn("member-magic-link", { token, redirectTo:
    safeCallback })`. On `authorize` failure (expired/used between peek and confirm), return
    the user to `/login` with a friendly "link expired or already used" message (via the
    existing `?error=` → `ERROR_MESSAGES` map on the login page).
  - This is the login-CSRF defense (a forwarded link cannot silently sign a victim in), on
    top of NextAuth's own CSRF on the POST.

### 5.6 Email template — `auth.member_login_link` (new, editable)

Registered global **transactional** template (variables `firstName`, `loginUrl`) so admins
can edit it at `/admin/email/templates`. Register in the email-templates registry — a new
`src/platform/email/templates/auth.ts` category file if none exists, else the appropriate
existing file. Unlike the applicant link (which hardcodes `"there"`), this greets the member
**by first name** (derived from `Person.name`; see §5.3 step 8). Default subject: "Your
HAVEN Hub sign-in link";
body notes 30-min single-use expiry, a "Sign in to HAVEN Hub" CTA, and an "ignore if you
didn't request this" line.

### 5.7 Config — kill-switch

Add `auth.memberMagicLinkEnabled` (boolean, default `true`) to the admin-configurable
settings registry + resolver introduced in #20. Read it in `requestMemberLoginLink`
(server action path) and in the `/login` page to decide whether to render the form. It
surfaces in admin settings automatically via the registry. (Implementer: confirm the exact
registry module + how a boolean setting is declared/read.)

## 6. Security analysis

- **Tokens**: 256-bit random, SHA-256 at rest (raw never stored), single-use via atomic
  claim, 30-min TTL.
- **Login-CSRF**: peek-then-confirm (GET never mutates) + NextAuth CSRF on the confirm POST.
- **Enumeration**: `sent`/silent-skip responses are identical for match vs no-match vs
  rate-limited; Yale-block message is domain-only (no membership signal).
- **Rate limiting**: 3 tokens / 15 min / email (matches portal).
- **Verify-time re-checks**: active + email-still-matches + non-Yale, so state changes
  between issue and click invalidate the token; `requirePersonSession`'s per-request DB
  re-check revokes access even *after* a successful login.
- **Provider always on but inert**: `authorize` fails closed without a valid token; the
  256-bit space makes guessing infeasible.
- **Kill-switch**: instant disable without a deploy.

## 7. Accepted limitations

- **Per-email (not per-IP) rate limiting** — consistent with the existing applicant portal;
  the repo has no shared IP rate-limiter. A distributed sender could still enumerate at
  3/15-min *per address*, but responses reveal nothing and no link is issued to
  non-members. Revisit if abuse appears.

## 8. Testing plan

- **Unit** (`member-magic-link.test.ts`, mirroring `portal-auth.test.ts`): single-use;
  expiry rejection; concurrent claim → exactly one success (no TOCTOU); rate-limit cap;
  non-existent email → no token + no `EmailLog`; `OFFBOARDED` person → no token; `@yale.edu`
  → `use-yale` (no token); `contactEmail` changed between issue and verify → reject at
  verify; kill-switch off → `disabled` + no token.
- **Auth callback**: `member-magic-link` sign-in stamps `token.personId` (and leaves
  applicant fields null).
- **E2E** (Playwright, CI): request link → read raw token from the issued `EmailLog`/verify
  URL → hit `/login/verify` → confirm → land in the hub as the member. Reuse existing e2e
  fixtures + per-worktree `TEST_DATABASE_URL`.

## 9. File-level change list

**Create**
- `prisma/schema.prisma` — add `MemberLoginToken` model (+ migration).
- `src/platform/auth/member-magic-link.ts` — service.
- `src/platform/auth/member-magic-link.test.ts` — unit tests.
- `src/app/login/verify/page.tsx` — peek-then-confirm verify page.
- `src/app/login/member-link-form.tsx` — client form (or colocated).
- `src/platform/email/templates/auth.ts` — `auth.member_login_link` template (if no auth
  category file exists).

**Modify**
- `src/platform/auth/auth.ts` — register `member-magic-link` provider; extend jwt callback.
- `src/app/login/page.tsx` — render the non-Yale form (kill-switch gated) + copy; add server
  action `requestMemberLoginLinkAction`; add `?error=` message for member-link failures.
- Settings registry (#20 module) — declare `auth.memberMagicLinkEnabled`.
- Email templates registry — register the new template (if adding a new category file).

## 10. Open questions for the implementation plan

- Exact settings-registry API for declaring/reading a boolean (`auth.memberMagicLinkEnabled`).
- Exact shape of the jwt callback's credentials branch (to extend it cleanly).
- Whether the email-templates registry auto-discovers category files or needs an explicit
  registration entry.
- Confirm the app-base-URL setting used for `loginUrl` (hub host).
