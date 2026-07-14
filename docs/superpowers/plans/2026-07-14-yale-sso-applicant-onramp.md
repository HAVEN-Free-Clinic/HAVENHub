# Yale SSO Applicant On-Ramp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any tenant-valid Yale (Microsoft Entra) account sign in and start an application, even if they have no existing `Person` record.

**Architecture:** Session-honoring approach. The NextAuth `signIn` callback stops dead-ending unknown Yale logins at `/welcome` and instead admits any tenant-valid account; the `jwt` callback resolves the `Person` once (null when unmatched or offboarded) and stamps a verified `applicantEmail` on the token; `getApplicantIdentity()` then treats a null-`personId` session that carries `applicantEmail` as a prospective applicant, mirroring the existing magic-link cookie path. The member hub stays invite-only because every member surface already gates on `session.personId`.

**Tech Stack:** Next.js App Router (Server Components + Server Actions), NextAuth / Auth.js v5 (JWT session strategy, Microsoft Entra ID provider), Prisma/Postgres, Vitest.

## Global Constraints

- **No em-dashes** in prose or UI copy. Use commas, colons, parentheses, or semicolons. (Author preference.)
- **Member hub stays invite-only.** The only new capability this feature grants is apply-portal access. Do not relax `requirePersonSession` or any `session.personId` gate.
- **No `Person` auto-provisioning and no `PersonStatus` change.** Applicants remain `Applicant` rows keyed by email; a `Person` is created downstream at acceptance. `PersonStatus` stays `ACTIVE | OFFBOARDED`.
- **Keep the magic-link email path** as the non-Yale fallback. Do not remove or restructure it.
- **Who is allowed:** any account that authenticates through Yale's Entra tenant (the pinned issuer already restricts this). Do not add an extra `@yale.edu` domain requirement.
- **Test database:** the repo `.env` points `TEST_DATABASE_URL` at shared Neon, which `resetDb()` would wipe. Always override with the local throwaway Postgres for every Vitest run:
  `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test"`.
  Never run tests against Neon. Do not run `prisma generate` (shared node_modules Prisma client across worktrees).
- **Conventional commits**, one per task. Frequent commits.

---

## File Structure

- `src/platform/auth/match-person.ts` — add two pure, exported helpers (`entraTenantAllowed`, `applicantEmailFromClaims`). Keeps sign-in decision logic testable without booting NextAuth.
- `src/platform/auth/match-person.test.ts` — unit tests for the two new helpers.
- `src/types/next-auth.d.ts` — add `applicantEmail` to the augmented `Session` and `JWT`.
- `src/platform/auth/auth.ts` — rewire `signIn` (admit tenant-valid accounts), `jwt` (single Person resolution + stamp `applicantEmail` + moved audit), `session` (expose `applicantEmail`).
- `src/modules/recruitment/services/portal-auth.ts` — one new branch in `getApplicantIdentity()`.
- `src/modules/recruitment/services/portal-auth.test.ts` — tests for the new applicant-identity branch.
- `src/app/welcome/page.tsx` — offer a "Start an application" link when a recruitment cycle is open.

Not modified: `src/app/apply/page.tsx`. During planning its copy was reviewed and already frames "Sign in with Yale" as the primary path and the email link as the non-Yale fallback ("Not affiliated with Yale? Get a one-time link by email"). The backend change (Tasks 1-3) is what makes the existing button work for new applicants, so no copy edit is warranted (YAGNI).

---

### Task 1: Pure Entra-claim helpers

Two small pure functions so the sign-in decision and applicant-email derivation are unit-testable without NextAuth. Placed alongside the existing login-resolution helpers.

**Files:**
- Modify: `src/platform/auth/match-person.ts` (append two exported functions)
- Test: `src/platform/auth/match-person.test.ts` (add two `describe` blocks + extend the import)

**Interfaces:**
- Produces:
  - `entraTenantAllowed(claims: { tid?: string | null }, configuredTenantId: string | null | undefined): boolean`
  - `applicantEmailFromClaims(claims: { email?: string | null; preferred_username?: string | null }, fallbackEmail?: string | null): string | null`

- [ ] **Step 1: Write the failing tests**

Add to the top import of `src/platform/auth/match-person.test.ts`:

```ts
import {
  netIdFromUpn,
  resolvePersonForLogin,
  getActivePerson,
  entraTenantAllowed,
  applicantEmailFromClaims,
} from "./match-person";
```

Append these `describe` blocks to the end of the file (they are pure, no DB):

```ts
describe("entraTenantAllowed", () => {
  it("allows when no tenant is configured", () => {
    expect(entraTenantAllowed({ tid: "whatever" }, undefined)).toBe(true);
  });
  it("allows when the token carries no tid", () => {
    expect(entraTenantAllowed({}, "yale-tenant")).toBe(true);
  });
  it("allows a matching tid", () => {
    expect(entraTenantAllowed({ tid: "yale-tenant" }, "yale-tenant")).toBe(true);
  });
  it("rejects a mismatched tid", () => {
    expect(entraTenantAllowed({ tid: "other-tenant" }, "yale-tenant")).toBe(false);
  });
});

describe("applicantEmailFromClaims", () => {
  it("prefers the email claim, lowercased", () => {
    expect(
      applicantEmailFromClaims({ email: "New.Grad@Yale.edu", preferred_username: "ng99@yale.edu" }),
    ).toBe("new.grad@yale.edu");
  });
  it("falls back to the UPN when the email claim is absent", () => {
    expect(applicantEmailFromClaims({ preferred_username: "NG99@yale.edu" })).toBe("ng99@yale.edu");
  });
  it("falls back to the provided user email when claims are empty", () => {
    expect(applicantEmailFromClaims({}, "Someone@yale.edu")).toBe("someone@yale.edu");
  });
  it("returns null when nothing is usable", () => {
    expect(applicantEmailFromClaims({}, null)).toBeNull();
    expect(applicantEmailFromClaims({})).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test" \
  npx vitest run src/platform/auth/match-person.test.ts
```
Expected: FAIL. The new tests error because `entraTenantAllowed` / `applicantEmailFromClaims` are not exported (import resolves to `undefined`, calling it throws).

- [ ] **Step 3: Implement the helpers**

Append to `src/platform/auth/match-person.ts` (after `resolvePersonForLogin`, before or after `getActivePerson`):

```ts
/**
 * True unless the Entra token asserts a tenant (tid) different from the one we are
 * configured for. The pinned issuer already restricts sign-in to Yale's tenant, so
 * this is defense in depth. A missing tid or missing config is allowed.
 */
export function entraTenantAllowed(
  claims: { tid?: string | null },
  configuredTenantId: string | null | undefined,
): boolean {
  if (configuredTenantId && claims.tid && claims.tid !== configuredTenantId) return false;
  return true;
}

/**
 * The verified address used to key a prospective applicant. Entra always carries a
 * UPN (preferred_username); the email claim can be absent, so fall back to it, then
 * to the NextAuth-provided user email. Lowercased; null when nothing is usable.
 */
export function applicantEmailFromClaims(
  claims: { email?: string | null; preferred_username?: string | null },
  fallbackEmail?: string | null,
): string | null {
  const raw = claims.email ?? claims.preferred_username ?? fallbackEmail ?? null;
  return raw ? raw.toLowerCase() : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test" \
  npx vitest run src/platform/auth/match-person.test.ts
```
Expected: PASS (all existing `netIdFromUpn` / `resolvePersonForLogin` / `getActivePerson` tests plus the 8 new helper assertions).

- [ ] **Step 5: Commit**

```bash
git add src/platform/auth/match-person.ts src/platform/auth/match-person.test.ts
git commit -m "feat(auth): pure entraTenantAllowed + applicantEmailFromClaims helpers"
```

---

### Task 2: Admit tenant-valid Yale logins and stamp applicantEmail

Rewire the NextAuth callbacks so any tenant-valid account is admitted (member if recognized, applicant otherwise), and the verified email is carried on the session. Add the `applicantEmail` field to the augmented session/JWT types so this typechecks.

**Files:**
- Modify: `src/types/next-auth.d.ts`
- Modify: `src/platform/auth/auth.ts:6` (import) and `src/platform/auth/auth.ts:85-127` (callbacks)

**Interfaces:**
- Consumes: `entraTenantAllowed`, `applicantEmailFromClaims` (Task 1).
- Produces: `session.applicantEmail: string | null` (verified Yale email, set for every Entra login, independent of Person match) and `session.personId: string | null` (unchanged meaning). Consumed by Task 3.

- [ ] **Step 1: Add `applicantEmail` to the session/JWT types**

Replace the entire contents of `src/types/next-auth.d.ts` with:

```ts
import type { DefaultSession } from "next-auth";

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

- [ ] **Step 2: Extend the match-person import in `auth.ts`**

Change `src/platform/auth/auth.ts:6` from:

```ts
import { resolvePersonForLogin, type LoginProfile } from "./match-person";
```

to:

```ts
import {
  resolvePersonForLogin,
  applicantEmailFromClaims,
  entraTenantAllowed,
  type LoginProfile,
} from "./match-person";
```

- [ ] **Step 3: Rewrite the callbacks**

Replace the entire `callbacks: { ... }` object (currently `src/platform/auth/auth.ts:85-127`) with:

```ts
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === "credentials") return true; // authorize() validated
      // Admit any Yale-tenant account. Recognized members get a personId in jwt();
      // everyone else becomes a prospective applicant (personId null). Hub access
      // stays gated by requirePersonSession, so this only unlocks the apply portal.
      const claims = (profile ?? {}) as EntraClaims;
      return entraTenantAllowed(claims, config.AZURE_AD_TENANT_ID);
    },
    async jwt({ token, user, account, profile }) {
      if (account) {
        // Initial sign-in only
        if (account.provider === "credentials" && user) {
          token.personId = user.id;
        } else {
          const claims = (profile ?? {}) as EntraClaims;
          const person = await resolveEntraLogin(
            profile,
            account.providerAccountId,
            user?.email
          );
          token.personId = person?.id ?? null;
          // Verified Yale address, stamped whether or not we recognize the Person,
          // so the apply portal can identify a brand-new applicant by email.
          token.applicantEmail = applicantEmailFromClaims(claims, user?.email);
          if (!person) {
            await recordAudit({
              action: "auth.applicant_login",
              entityType: "Auth",
              after: {
                upn: claims.preferred_username ?? null,
                email: token.applicantEmail,
              },
            });
          }
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.personId = (token.personId as string | null) ?? null;
      session.applicantEmail = (token.applicantEmail as string | null) ?? null;
      return session;
    },
  },
```

Notes for the implementer:
- The old `signIn` called `resolveEntraLogin` and returned the string `"/welcome"` for unknown users. That is gone: unknown Yale users are now admitted (`return true`) and the redundant second DB lookup is removed. `resolveEntraLogin` is still used by `jwt`, so keep its definition (lines ~29-45) untouched.
- The unmatched-login audit moved from `signIn` into `jwt` (renamed `auth.login_unmatched` -> `auth.applicant_login`). `recordAudit` is already imported; no import change needed there.
- An OFFBOARDED member still resolves to `null` in `resolveEntraLogin` (its `person.status === "OFFBOARDED"` check), so they get `personId: null` and become an applicant who can re-apply as NEW. Intended.

- [ ] **Step 4: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: PASS (no type errors). In particular `token.applicantEmail` and `session.applicantEmail` resolve against the augmented types from Step 1.

- [ ] **Step 5: Run the auth + portal test suites to confirm no regression**

Run:
```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test" \
  npx vitest run src/platform/auth/match-person.test.ts \
                 src/modules/recruitment/services/portal-auth.test.ts
```
Expected: PASS. The existing `getApplicantIdentity` tests still pass because a member session (personId + user.email) still takes the first branch; the mocked sessions simply lack `applicantEmail` (undefined), which is harmless.

- [ ] **Step 6: Commit**

```bash
git add src/types/next-auth.d.ts src/platform/auth/auth.ts
git commit -m "feat(auth): admit any Yale-tenant login and stamp applicantEmail on the session"
```

---

### Task 3: getApplicantIdentity honors a Yale session with no Person

Teach the apply-portal identity resolver to accept a null-`personId` session that carries a verified `applicantEmail`. This closes the loop so a brand-new Yale login can start an application instead of bouncing back to the sign-in screen.

**Files:**
- Modify: `src/modules/recruitment/services/portal-auth.ts:97-105` (`getApplicantIdentity`)
- Test: `src/modules/recruitment/services/portal-auth.test.ts` (add two tests)

**Interfaces:**
- Consumes: `session.applicantEmail` (Task 2).
- Produces: unchanged `ApplicantIdentity = { email: string; personId: string | null }` from `getApplicantIdentity()`, now also returned for a verified-Yale-but-Person-less session.

- [ ] **Step 1: Write the failing test**

Add these two tests to `src/modules/recruitment/services/portal-auth.test.ts`, immediately after the existing test `"getApplicantIdentity returns the SSO session identity when a Person session exists"` (around line 128):

```ts
it("getApplicantIdentity returns an applicant identity for a Yale session with no Person", async () => {
  // Brand-new Yale account: signed in via Entra, no Person match. The jwt callback
  // stamped applicantEmail; personId is null. They can still start an application.
  vi.mocked(auth).mockResolvedValueOnce({
    personId: null,
    applicantEmail: "newbie@yale.edu",
    user: {},
  } as never);
  expect(await getApplicantIdentity()).toEqual({ email: "newbie@yale.edu", personId: null });
});

it("getApplicantIdentity prefers the Person session over applicantEmail when both are present", async () => {
  // A recognized member also carries applicantEmail, but the Person path wins.
  vi.mocked(auth).mockResolvedValueOnce({
    personId: "p9",
    applicantEmail: "member@yale.edu",
    user: { email: "Member@Yale.edu" },
  } as never);
  expect(await getApplicantIdentity()).toEqual({ email: "member@yale.edu", personId: "p9" });
});
```

- [ ] **Step 2: Run the tests to verify the first fails**

Run:
```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test" \
  npx vitest run src/modules/recruitment/services/portal-auth.test.ts
```
Expected: the new "no Person" test FAILS. With the current resolver, a null-`personId` session skips the first branch and falls through to the cookie path (the module-level `cookies` mock returns `undefined`), so `getApplicantIdentity()` returns `null` instead of the applicant identity. (The "prefers the Person session" test already passes; it is a regression guard.)

- [ ] **Step 3: Add the applicant-email branch**

Replace `getApplicantIdentity` (currently `src/modules/recruitment/services/portal-auth.ts:97-105`) with:

```ts
export async function getApplicantIdentity(): Promise<ApplicantIdentity | null> {
  const session = await auth();
  if (session?.personId && session.user?.email) {
    return { email: session.user.email.toLowerCase(), personId: session.personId };
  }
  // A tenant-valid Yale login that matched no Person still carries a verified email
  // (stamped in the jwt callback). Treat it as a prospective applicant, exactly like
  // the magic-link cookie path. personId is preserved if present so a recognized
  // member who happens to lack a user.email claim is never downgraded.
  if (session?.applicantEmail) {
    return { email: session.applicantEmail, personId: session.personId ?? null };
  }
  const store = await cookies();
  const email = readApplicantCookie(store.get(APPLICANT_COOKIE)?.value);
  return email ? { email, personId: null } : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test" \
  npx vitest run src/modules/recruitment/services/portal-auth.test.ts
```
Expected: PASS (all prior tests plus the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/portal-auth.ts src/modules/recruitment/services/portal-auth.test.ts
git commit -m "feat(recruitment): honor a Yale SSO session with no Person as an applicant identity"
```

---

### Task 4: Offer "Start an application" on the /welcome page

A Yale person who signs into the member hub (not the apply portal) still lands on `/welcome` because `requirePersonSession` bounces null-`personId` sessions there. Give them a way forward when recruitment is open.

**Files:**
- Modify: `src/app/welcome/page.tsx`

**Interfaces:**
- Consumes: `prisma.recruitmentCycle` (open-cycle count), `buttonClasses` from `@/platform/ui/button`.
- Produces: none (leaf UI).

- [ ] **Step 1: Update the welcome page**

Replace the entire contents of `src/app/welcome/page.tsx` with:

```tsx
import Link from "next/link";
import { signOut } from "@/platform/auth/auth";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";

export default async function WelcomePage() {
  const now = new Date();
  const [orgName, support, openCycleCount] = await Promise.all([
    getSetting<string>("branding.orgName"),
    getSupportContact(),
    prisma.recruitmentCycle.count({
      where: {
        status: "OPEN",
        AND: [
          { OR: [{ opensAt: null }, { opensAt: { lte: now } }] },
          { OR: [{ closesAt: null }, { closesAt: { gte: now } }] },
        ],
      },
    }),
  ]);
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted p-6">
      <Card pad={false} className="w-full max-w-md p-8">
        <HavenLogo className="h-10 text-brand-fg" />
        <h1 className="mt-4 text-2xl font-bold tracking-tight">Welcome to {orgName}</h1>
        <p className="mt-3 text-sm leading-relaxed text-foreground-soft">
          You signed in successfully, but we couldn&apos;t find you in our records.
          If you&apos;re a current member, contact{" "}
          <SupportLink email={support.email}>the IT team</SupportLink> so we can fix
          your record.
          {openCycleCount > 0
            ? " If you'd like to join, you can start an application now."
            : " If you'd like to join, keep an eye out for the next recruitment cycle."}
        </p>
        {openCycleCount > 0 && (
          <Link href="/apply" className={buttonClasses("primary", "md", "mt-6 w-full")}>
            Start an application
          </Link>
        )}
        <form
          className="mt-3"
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <Button type="submit" variant="outline">Sign out</Button>
        </form>
      </Card>
    </main>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run:
```bash
npx tsc --noEmit && npx next lint --file src/app/welcome/page.tsx
```
Expected: PASS. (`buttonClasses(variant, size, extra)` accepts sizes `"sm" | "md" | "lg"`; `"md"` is valid.)

- [ ] **Step 3: Commit**

```bash
git add src/app/welcome/page.tsx
git commit -m "feat(recruitment): offer Start an application on /welcome when a cycle is open"
```

---

### Task 5: Confirm the null-personId session cannot reach member data

Security confirmation, not a code change (unless a gap is found). Because a null-`personId` Entra session is now honored by the apply portal, verify every member-data surface still rejects it. This confirms an existing boundary: the same JWT was already minted today via the old `"/welcome"` return.

**Files:**
- Read-only audit across `src/app/**` and `src/**/*route.ts`. Add a guard only if a gap is found.

- [ ] **Step 1: Enumerate every `auth()` call site**

Run:
```bash
grep -rn "await auth()" src --include='*.ts' --include='*.tsx' \
  | grep -vE "auth/auth\.ts|\.test\.|portal-auth\.ts"
```
Expected sites (14 total; 12 to verify):

- Intentionally personId-optional (apply portal, do not change):
  `src/app/apply/[slug]/actions.ts`, `src/app/apply/[slug]/page.tsx`
- The gate itself: `src/platform/auth/session.ts` (`requirePersonSession`)
- The login page: `src/app/login/page.tsx`
- Must reject null personId (member data): `learning/play/.../route.ts`,
  `my-info/certificate/[id]/route.ts`, `support/attachment/[id]/route.ts`,
  `api/learning/blob-upload/route.ts`,
  `api/recruitment/applications/[applicationId]/files/[key]/route.ts`,
  `api/support/epic/generate/route.ts`, `api/notifications/route.ts`,
  `api/incidents/attachments/[id]/route.ts`,
  `(app)/admin/email/oauth/callback/route.ts`, `api/gitbook/auth/route.ts`

- [ ] **Step 2: Verify each member-data site guards on `session.personId`**

Run:
```bash
grep -rn -A2 "await auth()" \
  "src/app/(app)/learning/play" \
  "src/app/(app)/my-info/certificate" \
  "src/app/(app)/support/attachment" \
  "src/app/api/learning/blob-upload" \
  "src/app/api/recruitment/applications" \
  "src/app/api/support/epic/generate" \
  "src/app/api/notifications" \
  "src/app/api/incidents/attachments" \
  "src/app/(app)/admin/email/oauth/callback" \
  "src/app/api/gitbook/auth"
```
Expected: each shows an immediate `if (!session?.personId) return/throw ...` (401 / Unauthorized / redirect) on the line(s) directly after `auth()`. This is the known-good state as of this plan: no gaps.

- [ ] **Step 3: Confirm the `(app)` layout gate**

Run:
```bash
grep -rn "requirePersonSession" src/app/\(app\)/layout.tsx src/platform/*/app-shell* 2>/dev/null
```
Expected: the shared `(app)` layout (or `AppShell`) enforces `requirePersonSession`, so every hub page inherits the null-`personId` -> `/welcome` bounce. If found, the audit passes.

- [ ] **Step 4: Record the result and commit (docs only)**

If Steps 2-3 confirm no gaps (the expected outcome), append a short "Security audit result" note to the spec and commit:

```bash
git add docs/superpowers/specs/2026-07-14-yale-sso-applicant-onramp-design.md
git commit -m "docs(recruitment): record null-personId session audit result (no gaps)"
```

If a gap IS found (a member-data route that reads `session` without checking `personId`), add `if (!session?.personId) return Response.json({ error: "Unauthorized" }, { status: 401 });` immediately after its `auth()` call, and commit as a `fix(auth): ...` instead. Do not weaken any existing check.

---

### Task 6 (OPTIONAL): Dev/DEMO applicant login

Entra does not exist locally or in the DEMO_MODE deploy, so the new on-ramp cannot be exercised there. This optional task lets an unknown email sign in as an applicant via the dev/DEMO Credentials provider, so "any account can apply" is demoable. Skip unless the demo deploy needs it; the magic-link path already exercises the new-applicant flow in dev.

**Files:**
- Modify: `src/platform/auth/auth.ts` (Credentials `authorize` + the `jwt` credentials branch)

**Interfaces:**
- Consumes: `applicantEmailFromClaims` is not used here; the email is the credential itself.
- Produces: a Credentials session with `personId: null` and `applicantEmail` set for an unknown email.

- [ ] **Step 1: Allow an unknown email as an applicant in `authorize`**

Replace the `authorize` body (currently `src/platform/auth/auth.ts:70-76`) with:

```ts
            async authorize(credentials) {
              const email = credentials?.email as string | undefined;
              if (!email) return null;
              const person = await resolvePersonForLogin({ email });
              // A recognized ACTIVE person logs in as a member.
              if (person && person.status === "ACTIVE") {
                return { id: person.id, email, name: person.name };
              }
              // Dev/DEMO only: an unknown (or non-active) email logs in as a
              // prospective applicant, mirroring the Entra applicant on-ramp.
              // id:"" signals "no Person"; the jwt callback maps it to personId:null.
              return { id: "", email, name: null };
            },
```

- [ ] **Step 2: Map the applicant credential to a null personId + applicantEmail in `jwt`**

In the `jwt` callback credentials branch (from Task 2), replace:

```ts
        if (account.provider === "credentials" && user) {
          token.personId = user.id;
        } else {
```

with:

```ts
        if (account.provider === "credentials" && user) {
          token.personId = user.id ? (user.id as string) : null;
          token.applicantEmail = user.id ? null : (user.email?.toLowerCase() ?? null);
        } else {
```

- [ ] **Step 3: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 4: Manual verification (dev server)**

Start the dev server, open `/apply`, use the dev login with an email that has no `Person`, and confirm you reach `/apply` with a working "Start application" flow (not `/welcome`). Confirm an existing member email still logs into the hub.

- [ ] **Step 5: Commit**

```bash
git add src/platform/auth/auth.ts
git commit -m "feat(auth): dev/DEMO applicant login for the Yale on-ramp (non-prod only)"
```

---

## Self-Review

**Spec coverage:**
- signIn admits tenant-valid accounts -> Task 2. jwt stamps applicantEmail + single resolution + moved audit -> Task 2. session exposes applicantEmail -> Task 2. Pure helpers for testability -> Task 1. Session types -> Task 2. getApplicantIdentity branch + tests -> Task 3. /welcome open-cycle link -> Task 4. Security audit of bare `auth()` -> Task 5. Optional dev/demo affordance -> Task 6. apply/page.tsx copy: reviewed, no change needed (documented in File Structure). Edge cases (offboarded, empty email claim, returning member, post-login redirect) are covered by the Task 1 fallback logic + Task 2 notes + unchanged renewal path. All spec sections map to a task.

**Placeholder scan:** No TBD/TODO. Every code step shows complete code; every test step shows real assertions; every run step gives an exact command and expected result. Task 6 is explicitly optional, not a placeholder.

**Type consistency:** `entraTenantAllowed` and `applicantEmailFromClaims` signatures are identical in Task 1 (definition), Task 1 tests, and Task 2 (call sites). `session.applicantEmail` / `token.applicantEmail` (`string | null` / optional) are declared in Task 2 Step 1 and read in Task 2 (jwt/session) and Task 3 (`getApplicantIdentity`). `ApplicantIdentity` shape (`{ email, personId }`) is unchanged and consistent across Task 3. `buttonClasses(variant, size, extra)` with size `"md"` matches the real `src/platform/ui/button.tsx` API.
