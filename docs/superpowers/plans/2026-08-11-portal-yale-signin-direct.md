# Apply portal direct Yale sign-in: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Sign in with Yale" on the public application portal go straight to Microsoft, so an applicant never sees the HAVEN Hub staff login page and never clicks the same button twice.

**Architecture:** The portal stops linking to `/login` and calls `signIn("microsoft-entra-id")` itself from a new server action in the portal's existing `"use server"` module. A small shared client component renders the form so both the server-rendered portal home and the client-rendered wizard use the same control. Sign-in failures come back to `/apply?error=signin` and render in portal branding instead of on the Hub's login page.

**Tech Stack:** Next.js 16 App Router (server actions, `proxy.ts`), NextAuth v5 (`signIn`, `AuthError`), React `useFormStatus`, Vitest, Playwright, Tailwind.

Spec: `docs/superpowers/specs/2026-08-11-portal-yale-signin-direct-design.md`

## Global Constraints

- **No em-dash characters (U+2014) anywhere in `src/**/*.{ts,tsx}`.** CI enforces `local/no-em-dash` and it fails the build. The convention extends to docs in this repo by practice.
- **Never style a raw `button`/`input`/`select`/`textarea` with `className`.** `no-restricted-syntax` in `eslint.config.mjs:111-119` blocks it. Use the primitives in `@/platform/ui` (`Button`, `Input`, `Field`, `Alert`). A hidden input carries no `className`, so it is fine.
- **Run the full lint before pushing:** `npx eslint src e2e`. Plain `npm run lint` walks a gitignored design-system directory; typecheck and tests do not cover the eslint boundary.
- **Never pipe a test run through `tail`/`head`.** The pipeline returns the pager's exit code, so a failing suite reports success. Run `npm test` bare and read the counts.
- **The local test DB drifts.** If tests fail with "column ... does not exist", run `npm run test:prepare` before concluding anything is broken.
- **Two-word "HAVEN Hub" in prose and UI copy;** identifiers stay `havenhub`.

---

### Task 1: The server action

Adds `portalYaleSignInAction` and its tests. Self-contained: nothing renders it yet, so this task can be reviewed purely on its control flow and sanitization.

**Files:**
- Modify: `src/app/apply/portal-actions.ts` (add import lines and one exported function)
- Test: `src/app/apply/portal-actions.test.ts:1-14` (extend the existing mock block), then append tests

**Interfaces:**
- Consumes: `safeNextPath`, `PORTAL_HOME` from `@/modules/recruitment/services/portal-next` (already imported at `portal-actions.ts:151`); `signIn` from `@/platform/auth/auth`; `AuthError` from `next-auth`.
- Produces: `portalYaleSignInAction(formData: FormData): Promise<void>`, read by Task 2.

- [ ] **Step 1: Extend the test file's mock block**

`portal-actions.test.ts` currently mocks `next/headers` and `@/platform/auth/auth`. Three changes are required, and each one exists for a reason that will bite if skipped.

Replace lines 1-14 of `src/app/apply/portal-actions.test.ts` with:

```ts
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";

// The server action module imports next/headers + auth at top level; mock them
// so it imports cleanly in the node test env (the cookie/signOut paths are
// exercised elsewhere).
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() })), headers: vi.fn(async () => ({ get: vi.fn(() => null) })) }));
vi.mock("@/platform/auth/auth", () => ({ signOut: vi.fn(async () => {}), auth: vi.fn(async () => null), signIn: vi.fn(async () => {}) }));
// Importing the real next-auth in the node test env fails resolving next/server,
// so stand in a minimal AuthError. The action imports AuthError from this same
// specifier, so `instanceof` stays coherent against the class constructed here.
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
// redirect() throws in production, which is what stops the action falling through
// to its rethrow. Model that: throw a tagged sentinel carrying the target URL.
class RedirectSentinel extends Error {
  constructor(readonly url: string) { super(`redirect:${url}`); }
}
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new RedirectSentinel(url); }),
}));

import { AuthError } from "next-auth";
import { signIn } from "@/platform/auth/auth";
import { requestMagicLinkAction, portalYaleSignInAction } from "./portal-actions";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { vi.clearAllMocks(); await resetDb(); });
```

Why each mock matters:
- `signIn` added to the `@/platform/auth/auth` mock: without it the action calls `undefined`.
- `next-auth` mocked: importing it for real fails with `Cannot find module '.../next/server'`. Verified.
- `next/navigation` mocked to **throw**: a no-op `redirect` would return, and the action would fall through to `throw error`, rethrowing the `AuthError`. The test would then be asserting the opposite of production behavior.

- [ ] **Step 2: Write the failing tests**

Append to `src/app/apply/portal-actions.test.ts`:

```ts
it("passes a safe deep-link next to signIn as the post-auth destination", async () => {
  const fd = new FormData();
  fd.set("next", "/apply/spring-2026");

  await portalYaleSignInAction(fd);

  expect(signIn).toHaveBeenCalledWith("microsoft-entra-id", { redirectTo: "/apply/spring-2026" });
});

it("collapses a hostile next to the portal home before it reaches signIn", async () => {
  const fd = new FormData();
  fd.set("next", "//evil.com");

  await portalYaleSignInAction(fd);

  expect(signIn).toHaveBeenCalledWith("microsoft-entra-id", { redirectTo: "/apply" });
});

it("defaults to the portal home when the form carries no next", async () => {
  await portalYaleSignInAction(new FormData());

  expect(signIn).toHaveBeenCalledWith("microsoft-entra-id", { redirectTo: "/apply" });
});

it("returns a failed Yale sign-in to the portal, not to the hub login page", async () => {
  vi.mocked(signIn).mockRejectedValueOnce(new AuthError("nope"));
  const fd = new FormData();
  fd.set("next", "/apply/spring-2026");

  await expect(portalYaleSignInAction(fd)).rejects.toThrow(
    `redirect:/apply?error=signin&next=${encodeURIComponent("/apply/spring-2026")}`,
  );
});

it("omits the next param when the failure had no deep link to preserve", async () => {
  vi.mocked(signIn).mockRejectedValueOnce(new AuthError("nope"));

  await expect(portalYaleSignInAction(new FormData())).rejects.toThrow("redirect:/apply?error=signin");
});

// The load-bearing test. signIn() signals SUCCESS by throwing NEXT_REDIRECT, so a
// bare `catch` would swallow the redirect and leave the applicant on a page that
// silently did nothing. Every test above still passes against that bug; only this
// one fails. Do not delete it.
it("lets a non-AuthError throw propagate so the OAuth redirect is never swallowed", async () => {
  const nextRedirect = new Error("NEXT_REDIRECT");
  vi.mocked(signIn).mockRejectedValueOnce(nextRedirect);

  await expect(portalYaleSignInAction(new FormData())).rejects.toBe(nextRedirect);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/app/apply/portal-actions.test.ts`

Expected: FAIL. The import of `portalYaleSignInAction` does not resolve, so the file errors before any test runs.

- [ ] **Step 4: Write the implementation**

In `src/app/apply/portal-actions.ts`, add to the existing imports at the top of the file:

```ts
import { AuthError } from "next-auth";
```

and extend the existing `@/platform/auth/auth` import (currently `import { signOut } from "@/platform/auth/auth";`) to:

```ts
import { signIn, signOut } from "@/platform/auth/auth";
```

`redirect` is already imported from `next/navigation` at line 4, and `safeNextPath` / `PORTAL_HOME` are already imported at line 151. Add nothing for those.

Append the action:

```ts
/**
 * Start the Yale (Entra) sign-in from the portal itself, rather than linking to
 * /login. Linking there served the hub's staff login page ON the portal host,
 * so an applicant saw "Sign in to <app>" and had to press the same button a
 * second time. This keeps the portal the only thing an applicant sees before
 * Microsoft.
 *
 * `next` arrives in a form body on a public, unauthenticated page, so it is
 * attacker-controlled and goes through safeNextPath before it is ever used.
 */
export async function portalYaleSignInAction(formData: FormData): Promise<void> {
  const next = safeNextPath(String(formData.get("next") ?? ""));
  try {
    await signIn("microsoft-entra-id", { redirectTo: next });
  } catch (error) {
    // signIn signals SUCCESS by throwing NEXT_REDIRECT, so only a real AuthError
    // may be translated here. Catching broadly would swallow the redirect and
    // strand the applicant on a page that appears to do nothing.
    if (error instanceof AuthError) {
      const param = next === PORTAL_HOME ? "" : `&next=${encodeURIComponent(next)}`;
      return redirect(`/apply?error=signin${param}`);
    }
    throw error;
  }
}
```

Note `return redirect(...)`: `redirect` returns `never` and throws in production, but returning explicitly means the function cannot fall through to the rethrow even if that ever changes.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/app/apply/portal-actions.test.ts`

Expected: PASS, 8 tests (2 pre-existing magic-link tests plus the 6 added here).

- [ ] **Step 6: Commit**

```bash
git add src/app/apply/portal-actions.ts src/app/apply/portal-actions.test.ts
git commit -m "feat(apply): start Yale sign-in from the portal instead of /login"
```

---

### Task 2: The shared button component

A client component both call sites can render. Reviewable on its own: it is a form with a pending state and no branching logic.

**Files:**
- Create: `src/app/apply/yale-sign-in-button.tsx`

**Interfaces:**
- Consumes: `portalYaleSignInAction` from Task 1.
- Produces: `YaleSignInButton({ next, className }: { next: string; className?: string })`, rendered by Task 3 and Task 4.

- [ ] **Step 1: Write the component**

Create `src/app/apply/yale-sign-in-button.tsx`:

```tsx
"use client";
import { useFormStatus } from "react-dom";
import { portalYaleSignInAction } from "./portal-actions";
import { Button } from "@/platform/ui/button";
import { Spinner } from "@/platform/ui/spinner";

/**
 * "Sign in with Yale" for the applicant portal. Submits straight to the Entra
 * sign-in, so the next screen an applicant sees is Microsoft's rather than the
 * hub's staff login page.
 *
 * A client component for two reasons: the OAuth redirect is silent on a slow
 * connection and invites double-taps, so the pending state matters; and the
 * apply wizard is itself "use client", so only a shared component lets both
 * call sites render the same control.
 */
export function YaleSignInButton({ next, className }: { next: string; className?: string }) {
  return (
    <form action={portalYaleSignInAction} className={className}>
      <input type="hidden" name="next" value={next} />
      <SubmitButton />
    </form>
  );
}

// Split out so it can read useFormStatus(), which only reports the status of an
// ancestor form.
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} aria-busy={pending} className="w-full gap-2">
      {pending && <Spinner size="sm" />}
      {pending ? "Signing in…" : "Sign in with Yale"}
    </Button>
  );
}
```

`useFormStatus` must be read by a component *inside* the form, not by the one that renders it. Reading it in `YaleSignInButton` itself would always report `pending: false`. This is the same split as `src/app/login/sign-in-button.tsx`.

- [ ] **Step 2: Verify it compiles and lints**

Run: `npx tsc --noEmit`
Expected: no output.

Run: `npx eslint src/app/apply`
Expected: no errors. (If it flags a styled raw control, the `className` landed on the hidden `input` instead of the `Button`.)

- [ ] **Step 3: Commit**

```bash
git add src/app/apply/yale-sign-in-button.tsx
git commit -m "feat(apply): add a portal Yale sign-in button that submits to Entra"
```

---

### Task 3: Wire the portal home and its failure surface

Swaps the anchor on `/apply` and renders the sign-in error in portal branding. Ends with the e2e assertion updated, because this task is what breaks it.

**Files:**
- Modify: `src/app/apply/page.tsx:26` (searchParams type), `:31-34` (settings load), `:55-60` (the anchor)
- Modify: `e2e/recruitment.spec.ts:115`

**Interfaces:**
- Consumes: `YaleSignInButton` from Task 2.

- [ ] **Step 1: Accept the error param**

In `src/app/apply/page.tsx`, change the signature at line 26 from:

```tsx
export default async function PortalHome({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
```

to:

```tsx
export default async function PortalHome({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
```

- [ ] **Step 2: Replace the anchor with the button**

Still in `src/app/apply/page.tsx`, replace lines 55-60:

```tsx
          <a
            href={`/login?callbackUrl=${encodeURIComponent(safeNext)}`}
            className={buttonClasses("primary", "lg", "mt-6 w-full")}
          >
            Sign in with Yale
          </a>
```

with:

```tsx
          {error === "signin" && (
            <Alert tone="error" className="mt-6">
              We couldn&apos;t sign you in with Yale. Please try again.
            </Alert>
          )}

          <YaleSignInButton next={safeNext} className="mt-6" />
```

- [ ] **Step 3: Fix the imports**

Add to the imports at the top of `src/app/apply/page.tsx`:

```tsx
import { YaleSignInButton } from "./yale-sign-in-button";
```

`Alert` is already imported at line 15. Line 14 reads `import { buttonClasses, Button } from "@/platform/ui/button";`. Line 57 was the file's only use of `buttonClasses` (verified), so change that import to:

```tsx
import { Button } from "@/platform/ui/button";
```

`Button` is still used at line 117 for the sign-out control, so it stays.

- [ ] **Step 4: Update the e2e assertion**

In `e2e/recruitment.spec.ts`, line 115 reads:

```ts
  await expect(page.getByRole("link", { name: /Sign in with Yale/i })).toBeVisible();
```

Replace it with:

```ts
  await expect(page.getByRole("button", { name: /Sign in with Yale/i })).toBeVisible();
  // The portal now starts the Entra sign-in itself, so an applicant must never be
  // handed the hub's staff login page. Regression guard for that detour returning.
  // Scoped to the heading on purpose: the portal's own body copy reads "Sign in to
  // start a new application...", so a bare text match on "Sign in to" matches the
  // portal itself and fails on a correct page.
  await expect(page.getByRole("heading", { name: /Sign in to/i })).toHaveCount(0);
```

The control is a form submit now, so its ARIA role is `button`, not `link`. Leaving this as `link` fails the spec.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit`
Expected: no output. An error about `buttonClasses` being unused means Step 3's cleanup was missed.

Run: `npx eslint src e2e`
Expected: 0 errors. Two pre-existing `no-img-element` warnings in `src/app/credential/[token]/page.tsx` and `src/platform/ui/person-photo.tsx` are expected and unrelated.

- [ ] **Step 6: Commit**

```bash
git add src/app/apply/page.tsx e2e/recruitment.spec.ts
git commit -m "feat(apply): send the portal home's Yale button straight to Microsoft"
```

---

### Task 4: Wire the wizard's renewal gate

The second detour. Separate task because it touches a different file with a different rendering model, and a reviewer could reasonably accept Task 3 and reject this.

**Files:**
- Modify: `src/app/apply/[slug]/apply-wizard.tsx:177` (delete `loginHref`), `:543` (the anchor)

**Interfaces:**
- Consumes: `YaleSignInButton` from Task 2.

- [ ] **Step 1: Delete the dead href**

In `src/app/apply/[slug]/apply-wizard.tsx`, delete line 177:

```tsx
  const loginHref = `/login?callbackUrl=${encodeURIComponent(`/apply/${def.slug}?type=renewal`)}`;
```

- [ ] **Step 2: Replace the anchor**

At line 543, replace:

```tsx
                <a href={loginHref} className={buttonClasses("primary", "lg", "w-full sm:w-auto")}>Sign in with Yale</a>
```

with:

```tsx
                <YaleSignInButton next={`/apply/${def.slug}?type=renewal`} className="w-full sm:w-auto" />
```

- [ ] **Step 3: Fix the imports**

Add to the imports at the top of `src/app/apply/[slug]/apply-wizard.tsx`:

```tsx
import { YaleSignInButton } from "../yale-sign-in-button";
```

Line 12 reads `import { Button, buttonClasses } from "@/platform/ui/button";`. Line 543 was this file's only use of `buttonClasses` (verified), so change that import to:

```tsx
import { Button } from "@/platform/ui/button";
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: no output.

Run: `npx eslint src`
Expected: 0 errors.

Run: `npm test`
Expected: all files pass. Read the printed counts; do not rely on the exit code, and do not pipe this command. If failures mention a missing database column, run `npm run test:prepare` and re-run.

- [ ] **Step 5: Commit**

```bash
git add "src/app/apply/[slug]/apply-wizard.tsx"
git commit -m "feat(apply): send the renewal gate's Yale button straight to Microsoft"
```

---

### Task 5: Verify the real flow in a browser

The unit tests mock `signIn` and e2e cannot complete an Entra round trip, so nothing so far has proven the button actually reaches Microsoft. This task is the only evidence that it does.

**Files:** none (verification only)

- [ ] **Step 1: Start the app**

Run: `npm run dev`

The portal home is at `http://localhost:3000/apply`. The portal-host rewrite is not exercised locally unless `PORTAL_BASE_URL` is set, which does not affect what this task checks.

- [ ] **Step 2: Confirm the one-click path**

Open `http://localhost:3000/apply` signed out. Click **Sign in with Yale**.

Expected: the browser leaves for `login.microsoftonline.com` (or the configured Entra tenant). It must NOT render a page headed "Sign in to ...".

If `AZURE_AD_CLIENT_ID` is unset locally the redirect cannot happen. In that case confirm the button posts to the server action and lands back on `/apply?error=signin` showing the portal-branded alert, and note in the PR that the live redirect was verified only against a deployed preview.

- [ ] **Step 3: Confirm the failure surface**

Visit `http://localhost:3000/apply?error=signin` directly.

Expected: the signed-out card shows "We couldn't sign you in with Yale. Please try again." above the Yale button, in portal branding, with the support link below if a support email is configured.

- [ ] **Step 4: Record the result**

Note in the PR description what was observed, including anything that could not be verified locally. Do not describe the flow as confirmed if step 2 fell back to the `AZURE_AD_CLIENT_ID` branch.

---

## Open risk to flag at PR time

The spec argues no Entra app-registration change is needed, because `/login` is served on the portal host today and already calls `signIn()` there, making the portal host an existing OAuth origin. That reasoning is derived from the proxy pass-through list, not observed in production. Confirm it against a deployed preview on the portal host before release. If the portal host has never actually been used as an OAuth origin, its redirect URI needs registering in Entra, which is an infrastructure change outside this code.
