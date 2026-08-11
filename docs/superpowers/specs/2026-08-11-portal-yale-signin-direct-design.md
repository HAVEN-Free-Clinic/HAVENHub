# Apply portal: send "Sign in with Yale" straight to Microsoft (2026-08-11)

## Problem

An applicant on the public portal clicks **Sign in with Yale** and does not reach Yale. They reach
the HAVEN Hub staff login page, where they must find and click a second **Sign in with Yale** button
before anything happens.

Two distinct costs, and the first is the serious one.

**It reads as the wrong product.** `/apply/page.tsx:55` renders the button as
`<a href="/login?callbackUrl=...">`. Because `login` is a reserved pass-through in the portal proxy
(`portal-routing.ts:16-24`), that page is served *on the portal host*. The URL bar still says
`apply.havenfreeclinic.org`, but the page says "Sign in to {appName}", shows the Hub's building
photo, and offers a member magic-link section addressed to active members. A prospective applicant
who has never heard of the Hub is asked to log into it. Some read that as "I need an account I do
not have" and stop.

**It costs a click that explains nothing.** The interstitial adds no information. Its only working
control is a button with the same label the applicant just pressed.

The same detour exists a second time inside the wizard: the renewal gate at `apply-wizard.tsx:543`
links to the same `loginHref` built at line 177.

## Approach

The portal stops borrowing the Hub's login page and calls the identity provider itself. The next
screen after the button is Microsoft's. `/login` is never rendered for an applicant.

This is not new machinery. `/login`'s own button is a server action calling
`signIn("microsoft-entra-id", { redirectTo })` (`login/page.tsx:109-126`); the portal gets its own
copy of that call, wired to portal-appropriate redirect targets and a portal-appropriate error
surface. The detour exists because the portal was reusing a page rather than a mechanism.

### Rejected: rebrand the interstitial

Giving the portal its own "Apply to {orgName}" middle page fixes the wrong-product reading but keeps
a click that carries no information. Rejected as a half-measure.

### Rejected: also rebrand `/login` on the portal host

Making `/login` detect the portal host and change its own branding was considered as a safety net for
stale links. It adds a conditional to a security-sensitive page to serve a path that, after this
change, nothing links to. Deferred until evidence that applicants actually arrive there.

## Design

### The action

New export in `src/app/apply/portal-actions.ts`, which is already a `"use server"` module and already
owns the portal's other auth actions (`requestMagicLinkAction`, `applicantSignOutAction`):

```ts
export async function portalYaleSignInAction(formData: FormData): Promise<void> {
  const next = safeNextPath(String(formData.get("next") ?? ""));
  try {
    await signIn("microsoft-entra-id", { redirectTo: next });
  } catch (error) {
    if (error instanceof AuthError) {
      redirect(`/apply?error=signin${next === PORTAL_HOME ? "" : `&next=${encodeURIComponent(next)}`}`);
    }
    throw error;
  }
}
```

Two constraints this shape exists to satisfy:

**The catch must be `AuthError`-only.** `signIn()` signals success by throwing `NEXT_REDIRECT`. A
bare `catch` swallows the redirect and the applicant sits on a page that silently did nothing. This
is the same guard as `login/page.tsx:115-121`, and it is the single most breakable line in the
change.

**`next` is sanitized server-side.** It arrives in a form body on a public, unauthenticated page, so
it is attacker-controlled. `safeNextPath()` (`portal-next.ts`) already rejects `//evil.com`,
`/\evil.com`, absolute URLs, and embedded control characters, and is the same helper the magic-link
path uses. The value is never trusted as it arrives.

### The button

New client component exporting `YaleSignInButton` from `src/app/apply/yale-sign-in-button.tsx`: a
`<form action={portalYaleSignInAction}>` holding a hidden `next` input and a submit button that reads
`useFormStatus()` to show "Signing in…". Its one prop is `next: string`.

It is a client component for two reasons. The pending state matters, because the OAuth redirect is
silent on a slow connection and invites double-taps, which is why `login/sign-in-button.tsx` exists
in the same shape. And the wizard (`apply-wizard.tsx`) is itself `"use client"`, so a shared
component is the only way both call sites render the same control; a client component may sit in a
`<form action={...}>` bound to an imported server action.

### Call sites

| File | Today | After |
| --- | --- | --- |
| `apply/page.tsx:55-60` | `<a href="/login?callbackUrl=…">` | `<YaleSignInButton next={safeNext} />` |
| `apply/[slug]/apply-wizard.tsx:543` | `<a href={loginHref}>` | `<YaleSignInButton next={`/apply/${def.slug}?type=renewal`} />` |
| `apply/[slug]/apply-wizard.tsx:177` | `const loginHref = …` | deleted |

`apply/page.tsx` already computes `safeNext` at line 38 for exactly this purpose; the deep link an
applicant was headed to survives the round trip unchanged.

### Failure surface

`apply/page.tsx` reads `error` from `searchParams` alongside the existing `next`. When it is
`"signin"`, the signed-out card renders an `Alert tone="error"` above the button:

> We couldn't sign you in with Yale. Please try again.

followed by the existing `SupportLink`, which the card already renders when a support email is
configured. The applicant stays on the portal, in portal branding, with the button in reach.

Today this failure lands on the Hub's `/login` error panel: the same wrong-product confusion, in the
path where the applicant is already having a bad time.

### Explicitly unchanged

- `/login` keeps its current behavior as the staff and member entrance.
- The portal's magic-link path (`SignInForm`, `/apply/verify`) is untouched.
- No Entra app-registration change. `signIn()` already builds its callback from the serving host, and
  `/login` is served on the portal host today, so the portal host is already in use as an OAuth
  origin. This change moves *which page* calls `signIn()`, not *from what host*.

## Testing

**Unit, in `portal-actions.test.ts` (exists).** With `signIn` mocked:

1. A safe `next` reaches `signIn` as `redirectTo` unchanged.
2. A hostile `next` (`//evil.com`) is collapsed to `/apply` before reaching `signIn`.
3. An `AuthError` from `signIn` redirects to `/apply?error=signin`.
4. **A non-`AuthError` throw propagates.** This is the `NEXT_REDIRECT` guard. Written as: throw a
   plain `Error` from the mocked `signIn` and assert the action rejects rather than redirecting. A
   test that only covers cases 1-3 passes just as happily against a bare `catch`, which is the bug.

**E2E, in `recruitment.spec.ts:115`.** It asserts
`getByRole("link", { name: /Sign in with Yale/i })`. The anchor becomes a form submit, so this must
become `getByRole("button", ...)`. Without that edit the spec fails, which is the correct signal, but
it should be updated in the same change rather than discovered in CI.

A full Entra round trip is not reachable from e2e. What is reachable, and worth asserting on the
portal home: the control is a button, and the page does not render the Hub's "Sign in to" heading.

## Risks

**The `AuthError`-only catch.** Getting this wrong produces a button that appears to do nothing, on
the app's public front door, in a path no e2e test can walk. Mitigated by unit test 4 above, which is
the reason that test is called out rather than left implied.

**Portal host as OAuth origin.** The reasoning that no Entra registration changes, that `/login` is
already served on the portal host and already calls `signIn()` there, is derived from the proxy
pass-through list, not observed in production. It should be confirmed against a real portal-host
sign-in before release. If the portal host turns out never to have been exercised as an OAuth origin,
its redirect URI needs registering in Entra, and that is an infrastructure change outside this code.
