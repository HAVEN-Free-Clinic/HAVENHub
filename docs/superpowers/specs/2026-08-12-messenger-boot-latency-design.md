# Messenger boot latency

Date: 2026-08-12
Branch: `feat/content-blocker-gate` (PR #581)

## Problem

The support launcher takes visibly long to appear, and it feels like it is
waiting for the rest of the page. It is.

Nothing about the Messenger can start until this fully serial chain completes:

1. HTML arrives, the client bundle downloads, React hydrates. The mount effect
   cannot run before this, which is the "waits for everything else" symptom.
2. `fetch("/api/support/messenger-token")`, a full round trip to a
   `force-dynamic` Node route.
3. That route runs `auth()`, then `getActivePerson()`, then
   `getEffectivePermissions()`, then signs the JWT. Sequential, two of them
   database queries.
4. Only now does `Intercom({...})` inject the widget script.
5. DNS, TCP, TLS, and download from `widget.intercom.io`.
6. The widget boots and paints the launcher.

Steps 2 and 5 are two separate round trips that cannot overlap, and step 2 is
database-bound. The third-party script does not begin downloading until our own
server has finished its RBAC lookups.

## Decision

Two independent changes.

1. **Server-mint the first token.** The `(app)` layout already runs server-side
   queries in a `Promise.all`. It mints the JWT there and passes it to
   `IntercomMessenger` as an `initialToken` prop, so the widget script starts
   loading the moment React hydrates. Steps 2 and 3 leave the critical path
   entirely.
2. **Preconnect to the Intercom hosts**, so step 5 pays for neither DNS nor the
   TLS handshake.

The existing route and refresh loop stay exactly as they are. The route is what
a long-lived tab calls for a fresh token, which is the reason it exists.

### Non-goals

- **Booting anonymously and upgrading to the JWT later.** This would be the
  fastest possible launcher and is rejected outright: it creates an unverified
  Intercom session first, which is precisely the impersonation hole identity
  verification exists to close.
- **Changing what the route returns to its own callers.** Its status-code
  contract is load-bearing (see below) and stays intact.

## Shared minting

The mint moves out of the route body into one function both callers use, so a
server-rendered token and a refreshed token can never drift apart in claims,
TTL, or authorization.

Three things the shared function must carry, each of which is a real defect if
dropped. All three were identified by the session working downstream on
`feat/support-ui`, which has since extended the Messenger to five more surfaces.

### The membership gate: a hazard for downstream, NOT a parameter to add here

Corrected after checking this branch's actual code rather than trusting the
description of it.

The downstream `feat/support-ui` session reported that the route enforces the
applicant portal's identity rule via `?requireActiveMembership=1`, and advised
carrying that flag through the shared mint function so a future portal wiring
cannot server-mint past the gate.

**That gate does not exist on this branch.** `GET()` here takes no request
argument, reads no query parameter, and never returns 403. Its only outcomes are
404, 401, 503, and success. The gate, the 403, and the visitor fallback are all
additions on `feat/support-ui`, which is downstream of this branch.

So adding a `requireActiveMembership` parameter here would be a dead argument
gating nothing, and it would rightly be flagged as speculative generality.

The underlying hazard is real, but it belongs to whoever owns the gate. Stated
plainly so it survives the merge:

> When `feat/support-ui` merges this forward, its membership gate must be
> threaded through the shared mint function. Otherwise a later wiring of
> `initialToken` into the applicant portal's layout would server-mint without
> the gate and identify an applicant holding no ACTIVE membership. It would not
> surface in `(app)` testing, because `(app)` has no gate to trip.

The discriminated result below is shaped so adding that outcome is additive: a
new variant, not a change to the existing ones.

### It must return a discriminated result, not `string | null`

The route decides more than "mint or do not mint", and each outcome means
something specific:

| Outcome | Meaning |
| --- | --- |
| 404 | The integration is off, so the route looks absent rather than half-configured |
| 401 | No session, or a session resolving to no active Person. **This is the offboarding revocation check**: an offboarded member must stop getting tokens while their hub JWT is still valid |
| 503 | `isDbUnreachableError`, so a database blip degrades rather than resolving as "still active" |

(No 403 on this branch. See the membership-gate note above: that outcome
belongs to `feat/support-ui` and is additive when it lands.)

A `string | null` return collapses all of that, forcing the layout either to
re-derive it or to skip it silently. The function returns a discriminated union;
the route maps it to status codes, and the layout maps it to "pass a token or
pass null".

The 503 case deserves emphasis: on the server-render path a database blip must
produce **no token**, never an optimistic one. Degrading to the existing fetch
path is correct; inventing a token is not.

### It must return the TTL with the token

The route returns `{ token, expiresInSeconds }`. A bare token string would leave
the refresh loop falling back to `INTERCOM_FALLBACK_TTL_SECONDS` (15 minutes),
which is a guess rather than the truth. `initialToken` carries
`{ token, expiresInSeconds }` so the first refresh is scheduled honestly.

## The component

`initialToken` is **optional and nullable**, and that is not defensive
programming.

On this branch it is nullable because a server-side mint can legitimately return
nothing: the integration is off, the session resolves to no active Person, or
the database is briefly unreachable. In each case the component must fall back,
not receive a fabricated token.

It matters more downstream. `feat/support-ui` mounts the Messenger on six
surfaces, and on `/login` there is never a token, while on `/apply`, `/onboard`,
and `/welcome` there legitimately is none whenever the surface resolves to
visitor mode, which boots with `Intercom({ app_id })` and no token at all. A
required or non-nullable `initialToken` would break every one of those. It stays
optional here so it does not have to be widened there.

When `initialToken` is present the component boots from it immediately. When it
is absent it falls back to today's fetch, so a server-side mint failure degrades
to current behavior rather than losing support.

### Booting from the prop must set `booted = true`

This is the subtle one, and it fails silently. The downstream session flagged it;
the reason differs on this branch, and the requirement is the same.

Downstream, `booted` guards a terminal 401/403 fallback to visitor mode. On this
branch there is no visitor mode, and `booted` does something simpler and just as
load-bearing: it selects `update()` over a fresh `Intercom()` call on refresh.
The existing comment says why, and it is the whole point of the flag: `update`
hands over a new token without tearing down an open conversation, which
re-booting would.

So if booting from `initialToken` does not flip `booted`, the first refresh calls
`Intercom()` again instead of `update()`, re-booting the widget underneath a
member who may be mid-conversation. Nothing throws.

Same requirement either way, which is why it is worth stating rather than
inheriting: set `booted = true` when booting from the prop.

## Preconnect

Rendered from `IntercomMessenger` itself, not from `(app)/layout.tsx`.

The component already returns `null`, so returning two `<link rel="preconnect">`
tags from it costs nothing structurally, and React 19 hoists them into `<head>`.

On this branch the Messenger mounts in exactly one place, so putting the tags in
`(app)/layout.tsx` would work equally well today. Putting them in the component
is chosen for where this is going: downstream mounts it on six surfaces, and
that placement covers all of them without editing six layouts, including the
visitor surfaces where boot latency matters most. A stranger on `/login` has no
session work to wait on, so the widget script is the *entire* critical path
there.

```
https://widget.intercom.io
https://js.intercomcdn.com   (crossOrigin, it serves the script)
```

## The purity rule, checked

The route's own doc comment claims minting lives in a route handler partly
because "the lint purity rule keeps [the wall clock] out of render". That
reasoning does not survive checking, and the comment should be corrected as part
of this work.

The rule is real: `react-hooks/purity`, supplied by `eslint-config-next` rather
than declared in `eslint.config.mjs`, and it does flag async Server Components.
But it flags `Date.now()` and `Math.random()`, not the `new Date()`
constructor, and it flags calls in a component's own body, not calls inside a
function that body imports. The `exp` stamp happens inside `jose`.

So the constraint is narrower than the comment implies: **do not call
`Date.now()` in the layout body.** Nothing about this design requires it.

The comment's second reason is real and is preserved: a long-lived tab needs
somewhere to go for a fresh token, which is why the route and the refresh loop
both stay.

This must still be confirmed empirically with `npx eslint src e2e` rather than
by reasoning, because the whole point of the note is that the original comment
reasoned its way to the wrong conclusion.

## Testing

- The shared mint returns each discriminated outcome: integration off, no
  session, no active person (the revocation check), database unreachable, and
  success carrying both token and TTL.
- **The route's existing tests keep passing completely unchanged.** That is the
  real proof the refactor preserved its contract, and it is worth more than any
  new test written alongside the new code. If a route test needs editing, the
  refactor changed behavior and something is wrong.
- The component boots from `initialToken` without fetching at all, and schedules
  its refresh from the supplied TTL rather than the 15 minute fallback guess.
- The component falls back to fetching when `initialToken` is null or absent.
- **Booting from `initialToken` sets `booted`**, proven by a test asserting the
  first refresh calls `update()` and not `Intercom()`. It must be written so it
  fails when the flag is not set: assert on which SDK function was called, not
  merely that the component survived.

## Coordination

`feat/support-ui` (PR #583) is downstream of this branch and already contains
these commits. That session owns the `messenger.tsx` conflict when it merges
forward and has asked that this change be shaped for this branch rather than
contorted around theirs. It must be told when this is pushed.
