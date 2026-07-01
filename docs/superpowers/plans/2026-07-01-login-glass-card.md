# Login glass-card redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the login page into a single centered glass card floating over a softened, airy version of the existing brand photo backdrop, keeping the sign-in content and behavior.

**Architecture:** One server component (`src/app/login/page.tsx`) is restructured from a two-column brand/form layout into a full-bleed background plus a top-left `HavenLogo` plus one centered `glass-panel` card holding the existing content. All auth logic, server actions, and kept content strings are unchanged. Reuses the app's Liquid Glass material and design tokens; no new CSS.

**Tech Stack:** Next.js App Router (server component), Tailwind (semantic tokens + brand tokens), the `glass-panel` component class in `globals.css`, `lucide-react`, existing platform UI primitives.

## Global Constraints

- No em-dashes (the `—` character) anywhere; a `local/no-em-dash` ESLint rule enforces this.
- Product name "HAVEN Hub" (two words) in prose/UI; identifiers stay `havenhub`.
- Reuse app primitives and tokens: `glass-panel`, `rounded-2xl`, `Button`, `Input`/`Field`/`FormActions`, `HavenLogo`, `SupportLink`, `SignInButton`, brand tokens (`bg-brand`, `bg-brand-deep`) and semantic text tokens (`foreground`, `foreground-soft`, `muted-foreground`, `critical`, `warning`, `surface`, `border`, `border-subtle`, `subtle-foreground`).
- Liquid Glass rule: glass on the card container only; content stays solid; no glass-on-glass.
- Theming: rely on `glass-panel`'s built-in dark variant and semantic tokens; the photo backdrop plus brand tint is a fixed, non-flipping scrim.
- Preserve behavior and these exact e2e selectors: the dev form's `input[name="email"]`, the `Dev sign in` button text, and the error `role="alert"` carrying the "couldn't sign you in" message.
- No raw styled controls that would trip the controls lint rule (use the primitives).

---

### Task 1: Restyle the login page into a centered glass card

**Files:**
- Modify (full rewrite of the returned JSX and the data loading): `src/app/login/page.tsx`
- Unchanged: `src/app/login/sign-in-button.tsx`
- Reference only (do not change): `e2e/login.spec.ts` (its selectors must keep matching)

**Interfaces:**
- Consumes: `auth`, `signIn` from `@/platform/auth/auth`; `config` from `@/platform/config`; `getSetting` from `@/platform/settings/service`; `getSupportContact` from `@/platform/branding/support`; `SupportLink` from `@/platform/branding/support-link`; `HavenLogo` from `@/platform/ui/haven-logo`; `Input`, `Field` from `@/platform/ui/input`; `Button` from `@/platform/ui/button`; `FormActions` from `@/platform/ui/form`; `SignInButton` from `./sign-in-button`; `LogIn` from `lucide-react`; `Image` from `next/image`; `redirect` from `next/navigation`; `AuthError` from `next-auth`.
- Produces: nothing consumed elsewhere (a route page).

- [ ] **Step 1: Replace the file contents**

Rewrite `src/app/login/page.tsx` to exactly this (it drops the now-unused `getOrgIdentity`/`formatOrgLine` import and the org/tagline, adds the `LogIn` icon, and restructures the layout; the `searchParams`/`safeCallbackUrl`/`auth` logic, both server actions, the error map, and all kept content strings are preserved verbatim):

```tsx
import Image from "next/image";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { LogIn } from "lucide-react";
import { auth, signIn } from "@/platform/auth/auth";
import { config } from "@/platform/config";
import { getSetting } from "@/platform/settings/service";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { FormActions } from "@/platform/ui/form";
import { SignInButton } from "./sign-in-button";

const ERROR_MESSAGES: Record<string, string> = {
  CredentialsSignin:
    "We couldn't sign you in. That email isn't in our records or the account isn't active.",
};
const DEFAULT_ERROR = "Sign-in failed. Please try again, or contact the IT team.";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const { error, callbackUrl } = await searchParams;
  // Only honor a same-origin, slash-rooted destination (e.g. the GitBook docs
  // auth endpoint) so the callback can never become an open redirect. Parsing
  // against APP_BASE_URL with the WHATWG URL API rejects absolute URLs and the
  // protocol-relative / backslash tricks ("//evil.com", "/\evil.com") that a
  // naive string check misses. Anything else falls back to the home page.
  let safeCallbackUrl = "/";
  if (callbackUrl) {
    try {
      const base = new URL(config.APP_BASE_URL);
      const target = new URL(callbackUrl, base);
      if (target.origin === base.origin && /^\/[^/\\]/.test(target.pathname)) {
        safeCallbackUrl = target.pathname + target.search;
      }
    } catch {
      // Malformed callbackUrl: keep the "/" default.
    }
  }
  const session = await auth();
  if (session?.personId) redirect(safeCallbackUrl);
  const [appName, support] = await Promise.all([
    getSetting<string>("branding.appName"),
    getSupportContact(),
  ]);
  const errorMessage = error ? (ERROR_MESSAGES[error] ?? DEFAULT_ERROR) : null;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
      {/* Full-bleed brand backdrop, softened to read airy rather than heavy */}
      <Image
        src="/brand/login-building.webp"
        alt=""
        aria-hidden="true"
        fill
        priority
        sizes="100vw"
        className="object-cover object-center"
      />
      {/* Airy brand wash: lighter than the old side panel, so the photo reads as
          atmospheric brand texture. Center stays brighter for the glass card. */}
      <div aria-hidden="true" className="absolute inset-0 bg-brand/30" />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-b from-brand-deep/55 via-brand/10 to-brand-deep/60"
      />
      {/* Extra weight in the top-left corner keeps the white logo legible. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-br from-brand-deep/45 via-transparent to-transparent"
      />

      {/* Brand lockup, top-left over the backdrop */}
      <div className="absolute left-6 top-6 z-10 sm:left-10 sm:top-10">
        <HavenLogo className="h-9 text-white" />
      </div>

      {/* Centered glass card */}
      <div className="glass-panel relative z-10 w-full max-w-sm rounded-2xl p-8 shadow-xl">
        <div
          aria-hidden="true"
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-surface shadow-sm"
        >
          <LogIn className="h-5 w-5 text-foreground" />
        </div>

        <h1 className="mt-5 text-center text-2xl font-bold tracking-tight text-foreground">
          Sign in to {appName}
        </h1>
        <p className="mt-2 text-center text-sm text-foreground-soft">
          Use your Yale account to continue.
        </p>

        {errorMessage && (
          <p
            role="alert"
            className="mt-5 rounded-xl border border-critical/20 bg-critical/5 px-3 py-2 text-sm text-critical"
          >
            {errorMessage}
          </p>
        )}

        {config.AZURE_AD_CLIENT_ID ? (
          <form
            className="mt-6"
            action={async () => {
              "use server";
              try {
                await signIn("microsoft-entra-id", { redirectTo: safeCallbackUrl });
              } catch (error) {
                if (error instanceof AuthError) {
                  redirect(
                    `/login?error=${error.type}&callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
                  );
                }
                throw error;
              }
            }}
          >
            <SignInButton />
          </form>
        ) : (
          <p className="mt-6 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
            Entra ID is not configured (AZURE_AD_* unset).
          </p>
        )}

        {/* Persistent help affordance, available before any error occurs.
            Hidden entirely when no support email is configured, so a
            locked-out user is never shown a contact they cannot reach. */}
        {support.email && (
          <p className="mt-5 text-center text-sm text-muted-foreground">
            Trouble signing in?{" "}
            <SupportLink email={support.email}>{support.label}</SupportLink>
          </p>
        )}

        {(config.NODE_ENV !== "production" || config.DEMO_MODE) && (
          <form
            className="mt-8 border-t border-border-subtle pt-6"
            action={async (formData: FormData) => {
              "use server";
              try {
                await signIn("credentials", {
                  email: formData.get("email"),
                  redirectTo: safeCallbackUrl,
                });
              } catch (error) {
                // signIn throws NEXT_REDIRECT on success, so only translate auth failures.
                if (error instanceof AuthError) {
                  redirect(
                    `/login?error=${error.type}&callbackUrl=${encodeURIComponent(safeCallbackUrl)}`
                  );
                }
                throw error;
              }
            }}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-subtle-foreground">
              Local development
            </p>
            <Field label="Email">
              <Input
                name="email"
                type="email"
                required
                placeholder="j.carney@yale.edu"
                className="mt-1"
              />
            </Field>
            <FormActions>
              <Button type="submit" variant="outline" className="w-full">
                Dev sign in
              </Button>
            </FormActions>
          </form>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no new errors in `src/app/login/page.tsx` (pre-existing stale-Prisma-client errors in other files are baseline noise). In particular, confirm no "declared but never used" error, meaning the `getOrgIdentity`/`formatOrgLine` imports were fully removed.

Run: `npm run lint`
Expected: clean. The `LogIn` usage and all controls go through primitives, so the controls rule and the em-dash rule both pass.

- [ ] **Step 3: Confirm the e2e selectors still resolve**

By reading the rewritten file, confirm all three selectors the login e2e spec depends on are present and unchanged:
- `input[name="email"]` (the dev form `Input` with `name="email"`),
- a button with text `Dev sign in`,
- an element with `role="alert"` that renders the `CredentialsSignin` message ("We couldn't sign you in ...").

No change to `e2e/login.spec.ts` is expected. (The full login e2e run is CI-gated in this worktree; do not run the DB-backed suite locally.)

- [ ] **Step 4: Commit**

```bash
git add src/app/login/page.tsx
git commit -m "feat(login): centered glass card over a softened brand backdrop"
```

---

## Final verification (whole branch)

- `npm run lint` green; `npx tsc --noEmit` no new errors in the changed file.
- The rewritten page preserves the kept content strings, both server actions, the safe-callback-URL logic, and the three e2e selectors.
- Deferred to QA (needs the running app): a light and dark visual pass confirming the airy backdrop, glass-card legibility, top-left logo contrast, and the icon badge; a mobile-width check that the card and logo do not collide. Tune the three background overlay alphas (`bg-brand/30`, the two gradients) during that pass if the backdrop reads too heavy or too washed out.

## Self-review notes (coverage check)

- Spec "Layout" (full-bleed softened photo, top-left logo, centered glass card): Task 1 Step 1.
- Spec "Card contents" (badge with `LogIn`, title, subtitle, error, Entra sign-in / not-configured warning, support link, dev form): Task 1 Step 1, all preserved from the current page.
- Spec "no footer caption" (tagline + org line removed; `getOrgIdentity`/`formatOrgLine` dropped): Task 1 Step 1 + Step 2.
- Spec "theming" (glass-panel dark variant + semantic tokens + fixed brand scrim): Task 1 Step 1 class choices.
- Spec "testing" (lint, tsc, e2e selectors preserved): Task 1 Steps 2 and 3.
