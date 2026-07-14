# Yale SSO as a first-class applicant on-ramp

Date: 2026-07-14
Status: Approved (design)

## Problem

Today, a brand-new Yale student cannot start an application by signing in with
Yale. The apply portal already runs a dual identity system, but only one half of
it is self-service:

- **Yale SSO (Microsoft Entra)** mints a NextAuth session *only* if the login
  matches an existing `Person`. A new Yale account authenticates at Entra fine,
  resolves to no `Person`, and the `signIn` callback returns the string
  `"/welcome"`: a dead-end "we couldn't find you in our records, contact IT"
  page. See `src/platform/auth/auth.ts:86-106` and `src/app/welcome/page.tsx`.
- **Magic-link email** issues a signed applicant cookie keyed by email, with
  `personId: null` and no `Person` required. This is the *only* current
  self-service path, and its UI is labeled "Not affiliated with Yale? Get a
  one-time link by email" (`src/app/apply/page.tsx:67-70`): exactly backwards
  for a Yale student who wants to apply.

The intuitive action for a Yale applicant, "Sign in with Yale," rejects them.

Two facts make this a clean fix:

1. The whole apply flow gates on `getApplicantIdentity()`, and an **email is
   enough**: `personId` may be null. `/apply/[slug]` (page.tsx:45-46), draft
   actions, and `submitApplication` all accept an email-only identity. A NEW
   submission creates an **`Applicant`** row keyed by `cycleId + emailLower`
   (`src/modules/recruitment/services/submissions.ts:186-187`), **not** a
   `Person`. `PersonStatus` is only `ACTIVE`/`OFFBOARDED`
   (`prisma/schema.prisma:20-23`): Persons are real members, created downstream
   at acceptance/onboarding.
2. Therefore "auto-create a Person on login" would fight the codebase's
   `Applicant`-vs-`Person` separation. The right move is to make a valid Yale
   SSO login produce an **email identity** even when no `Person` exists, exactly
   mirroring the magic-link path.

The remaining gap: even if we sent new Yale logins to `/apply`,
`getApplicantIdentity()` ignores a session whose `personId` is null, so they
would loop back to the sign-in screen.

## Scope decisions (confirmed with product owner)

- **Who is allowed:** any account that authenticates through Yale's Entra tenant,
  including sponsored/guest accounts. No additional `@yale.edu` domain check is
  required. The pinned issuer
  (`https://login.microsoftonline.com/${AZURE_AD_TENANT_ID}/v2.0`) already
  restricts to Yale's tenant.
- **Non-Yale applicants:** the email magic-link path stays as a fallback. Yale
  SSO becomes the primary on-ramp; the email path remains for genuinely non-Yale
  applicants.
- **Member hub stays invite-only.** The only new capability granted by this
  change is apply-portal access. Nothing here relaxes hub access.

## Chosen approach: session-honoring (Approach 1)

Stop dead-ending unmatched Yale logins. Admit any tenant-valid Entra login, carry
the verified email onto the session, and teach `getApplicantIdentity()` to accept
a session whose `personId` is null. A matched member still gets `personId` (so
renewals/transfers keep working); a new Yale account gets an email-only identity,
just like the magic-link path already produces.

Approaches considered and rejected:

- **Cookie-bridge:** redirect an unmatched Yale login through a route that mints
  the magic-link applicant cookie. Rejected: more moving parts, and it forks the
  flow (matched keeps a JWT for renewals, unmatched gets a cookie) for no gain
  over Approach 1.
- **Auto-provision a Person on login:** rejected. Fights the `Applicant`-vs-
  `Person` separation, pollutes the Person table, and needs a schema migration
  plus a new status. Highest risk, worst fit.

## Changes

### 1. Auth callbacks (`src/platform/auth/auth.ts`)

**`signIn`** admits any tenant-valid Yale account. It no longer resolves the
Person or returns `"/welcome"`. It rejects only a wrong tenant (defense in depth;
the pinned issuer already enforces this):

```ts
async signIn({ account, profile }) {
  if (account?.provider === "credentials") return true; // authorize() validated
  const claims = (profile ?? {}) as EntraClaims;
  // Defense in depth: the pinned issuer already restricts to Yale's tenant.
  if (config.AZURE_AD_TENANT_ID && claims.tid && claims.tid !== config.AZURE_AD_TENANT_ID) {
    return false;
  }
  // Any tenant-valid Yale account is admitted: as a member if we recognize them
  // (personId set in jwt), otherwise as a prospective applicant (personId null,
  // hub access still gated by requirePersonSession).
  return true;
}
```

**`jwt`** becomes the single place that resolves the Person (removes today's
redundant double lookup, which the exploration flagged). It stamps `personId`
(null when unmatched or offboarded) and, for every Entra login, an
`applicantEmail`. The "no Person match" audit moves here so applicant logins are
still recorded without a second query:

```ts
async jwt({ token, user, account, profile }) {
  if (account) {
    if (account.provider === "credentials" && user) {
      token.personId = user.id;
    } else {
      const claims = (profile ?? {}) as EntraClaims;
      const person = await resolveEntraLogin(profile, account.providerAccountId, user?.email);
      token.personId = person?.id ?? null;
      token.applicantEmail = applicantEmailFromClaims(claims, user?.email);
      if (!person) {
        await recordAudit({
          action: "auth.applicant_login",
          entityType: "Auth",
          after: { upn: claims.preferred_username ?? null, email: token.applicantEmail },
        });
      }
    }
  }
  return token;
}
```

Note: `resolveEntraLogin` keeps returning null for an OFFBOARDED person, so
`personId` stays null for them (see edge cases). Its internal tenant check is now
redundant with `signIn` but harmless; leave it as belt-and-suspenders.

**`session`** surfaces `applicantEmail`:

```ts
async session({ session, token }) {
  session.personId = (token.personId as string | null) ?? null;
  session.applicantEmail = (token.applicantEmail as string | null) ?? null;
  return session;
}
```

### 2. Pure helper (new, unit-testable)

Extract the email-from-claims logic so the callback stays thin and the logic is
testable without booting NextAuth. Lives in `match-person.ts` (or a small
sibling):

```ts
/** The verified address to key a prospective applicant on. Entra always carries
 *  a UPN (preferred_username); the email claim can be absent, so fall back to it. */
export function applicantEmailFromClaims(
  claims: { email?: string | null; preferred_username?: string | null },
  fallbackEmail?: string | null,
): string | null {
  const raw = claims.email ?? claims.preferred_username ?? fallbackEmail ?? null;
  return raw ? raw.toLowerCase() : null;
}
```

### 3. Session types (`src/types/next-auth.d.ts`)

Add `applicantEmail` to both `Session` and `JWT`:

```ts
declare module "next-auth" {
  interface Session {
    personId: string | null;
    applicantEmail: string | null;
    user: DefaultSession["user"];
  }
}
declare module "next-auth/jwt" {
  interface JWT {
    personId?: string | null;
    applicantEmail?: string | null;
  }
}
```

### 4. Identity resolution (`src/modules/recruitment/services/portal-auth.ts`)

`getApplicantIdentity()` gains one branch. After the existing `session.personId`
check, honor a Yale-verified session with a null `personId`:

```ts
export async function getApplicantIdentity(): Promise<ApplicantIdentity | null> {
  const session = await auth();
  if (session?.personId && session.user?.email) {
    return { email: session.user.email.toLowerCase(), personId: session.personId };
  }
  // Tenant-valid Yale login that matches no Person: still a verified applicant
  // identity (email only). Mirrors what the magic-link cookie produces.
  if (session?.applicantEmail) {
    return { email: session.applicantEmail, personId: null };
  }
  const store = await cookies();
  const email = readApplicantCookie(store.get(APPLICANT_COOKIE)?.value);
  return email ? { email, personId: null } : null;
}
```

Nothing downstream changes. `/apply/[slug]`, `saveDraftAction`,
`uploadDraftFileAction`, and `submitPublicApplication` already run on this
identity shape.

### 5. UI copy

- `src/app/apply/page.tsx`: "Sign in with Yale" is now the genuine primary path
  for everyone. Light copy tweak so it reads as the main action and the email
  link reads clearly as the non-Yale fallback. No structural change; the button
  already exists and already threads the safe `next` deep link.
- `src/app/welcome/page.tsx`: add a "Start an application" link to `/apply` when a
  recruitment cycle is open, so a Yale person who reaches `/welcome` from the hub
  is not stranded. Reuse the same open-cycle query shape used on the portal home
  (`status: "OPEN"` within the opens/closes window).

### 6. Optional dev/demo affordance

Entra does not exist locally or in the DEMO_MODE deploy (havenhub-two.vercel.app
runs DEMO_MODE with no Azure app), so the new on-ramp cannot be exercised there.
Optionally extend the dev/DEMO `Credentials` provider so an unknown email yields
an applicant identity (`personId` null, `applicantEmail` set) instead of being
rejected, making "any account can apply" demoable. This requires the credentials
branch of `jwt` to also set `applicantEmail` for a person-less dev login, and the
`authorize` callback to return a session for an unknown email instead of null.
Exact shape is worked out in the plan. Clearly non-prod gated
(`NODE_ENV !== "production" || DEMO_MODE`). Flagged optional: the core
production behavior does not depend on it, and the magic-link path already lets
us exercise the new-applicant flow in dev.

## Security

Because a null-`personId` session is now honored by the apply portal, audit that
no member-data surface trusts a bare session:

- Grep every `auth()` call site. Confirm each member page/route/API gates on
  `personId` (via `requirePersonSession`, `requirePermission`,
  `requireModuleAccess`, or an explicit `session.personId` check) rather than
  trusting the raw session.
- This confirms an existing boundary rather than introducing a new one: the same
  null-`personId` JWT is already minted today via the `"/welcome"` return, so no
  new attack surface is created. Fix anything that reads a bare session.
- `requirePersonSession` (`src/platform/auth/session.ts:61-64`) is unchanged and
  remains the hub gate: `if (!session.personId) redirect("/welcome")`.

## Edge cases (intentional behavior)

- **Offboarded member signs in with Yale.** `resolveEntraLogin` returns null for
  an OFFBOARDED person, so `personId` stays null while `applicantEmail` is set.
  They get an applicant identity and can re-apply as NEW (correct: not a current
  member, so no renewal path), and still cannot reach the hub.
- **Empty Entra email claim.** `applicantEmailFromClaims` falls back to the UPN
  (`preferred_username`), which Entra always provides. Only if both are absent
  does `applicantEmail` come back null, in which case the visitor falls through to
  the cookie path and, absent a cookie, sees the sign-in screen. Rare and
  acceptable.
- **Returning member (RENEWAL/TRANSFER).** Unchanged: a matched login carries
  `personId`, so `getRenewalContext` and the renewal/transfer branches in
  `submissions.ts` and `/apply/[slug]/page.tsx` still work.
- **Post-login redirect.** The `/apply` "Sign in with Yale" link already sets
  `callbackUrl` to the safe `next` deep link (defaulting to `/apply`), so a new
  Yale applicant lands back on the portal, now with a valid identity, instead of
  `/welcome`. A hub sign-in (`callbackUrl=/`) still lands on `/welcome` via
  `requirePersonSession`.

## Testing

- **Unit (pure helper):** `applicantEmailFromClaims` across email present, email
  absent (UPN fallback), both absent (null), and casing.
- **Unit (`getApplicantIdentity`):** member session (`personId` + email) yields
  member identity; applicant-email session (`personId` null) yields applicant
  identity; cookie-only yields cookie identity; nothing yields null. Extend
  `portal-auth.test.ts`.
- **e2e:** the magic-link new-applicant path is already covered by the
  comprehensive Playwright suite. Simulating a null-`personId` Yale session in
  Playwright is limited by the dev harness (no Entra), so treat a dedicated
  SSO-new-applicant e2e as best-effort; the unit coverage plus the existing
  magic-link e2e exercise the same downstream code.

## Files touched

- `src/platform/auth/auth.ts` (signIn, jwt, session callbacks)
- `src/platform/auth/match-person.ts` (new `applicantEmailFromClaims` helper) plus
  its test
- `src/types/next-auth.d.ts` (`applicantEmail` on Session + JWT)
- `src/modules/recruitment/services/portal-auth.ts` (identity branch) plus
  `portal-auth.test.ts`
- `src/app/apply/page.tsx` (copy)
- `src/app/welcome/page.tsx` (open-cycle "Start an application" link)
- Optional: `src/platform/auth/auth.ts` Credentials `authorize`/`jwt` for the
  dev/demo applicant affordance

## Out of scope

- Any change to member hub access or RBAC.
- Person auto-provisioning or a new `PersonStatus`.
- Changes to the acceptance/onboarding pipeline that turns an `Applicant` into a
  `Person`.
- Removing or restructuring the magic-link email path (kept as fallback).
