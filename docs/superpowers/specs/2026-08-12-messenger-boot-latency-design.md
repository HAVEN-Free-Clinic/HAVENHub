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

### It must take `requireActiveMembership`

This is the one place this refactor could introduce a **security regression**.

The route enforces the applicant portal's identity rule server-side via
`?requireActiveMembership=1`: identify the person only if they hold a current
ACTIVE term membership, otherwise 403 and fall back to visitor mode. If the
shared function does not carry that flag, then whoever later wires
`initialToken` into the portal's layout will server-mint without the gate and
identify an applicant who has no membership.

It would not surface in any `(app)` testing, because `(app)` always passes
false. So the parameter exists from the start, even though its only caller today
passes false.

### It must return a discriminated result, not `string | null`

The route decides more than "mint or do not mint", and each outcome means
something specific:

| Outcome | Meaning |
| --- | --- |
| 404 | The integration is off, so the route looks absent rather than half-configured |
| 401 | No session, or a session resolving to no active Person. **This is the offboarding revocation check**: an offboarded member must stop getting tokens while their hub JWT is still valid |
| 403 | The membership gate above |
| 503 | `isDbUnreachableError`, so a database blip degrades rather than resolving as "still active" |

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
programming. The Messenger now mounts on six surfaces, and on `/login` there is
never a token, while on `/apply`, `/onboard`, and `/welcome` there legitimately
is none whenever the surface resolves to visitor mode. Visitor mode boots with
`Intercom({ app_id })` and no token at all.

When `initialToken` is present the component boots from it immediately. When it
is absent it falls back to today's fetch, so a server-side mint failure degrades
to current behavior rather than losing support.

### Booting from the prop must set `booted = true`

This is the subtle one, and it fails silently.

The identified path carries a `booted` flag guarding a terminal 401/403 fallback
to visitor mode. That guard exists so a mid-session 401 (a session revoked under
an open tab) keeps retrying rather than yanking an identified tab with a live
conversation over to anonymous.

If booting from `initialToken` does not flip `booted`, the first refresh that
401s downgrades an open conversation to a visitor one. Nothing throws. The
member simply loses their history.

## Preconnect

Rendered from `IntercomMessenger` itself, not from `(app)/layout.tsx`.

The component already returns `null`, so returning two `<link rel="preconnect">`
tags from it is a smaller change than touching six layouts, and React 19 hoists
them into `<head>`. It also covers visitor mode, which is where boot latency
matters most: a stranger on `/login` has no session work to wait on, so the
widget script is the *entire* critical path.

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

- The shared mint returns each discriminated outcome: off, no session, no active
  person, membership gate failing when required, database unreachable, success.
- `requireActiveMembership: true` refuses a person with no ACTIVE membership,
  and the route still maps that to 403. This is the security-relevant case and
  it needs a test even though `(app)` never triggers it.
- The route's existing tests keep passing unchanged, which is the real proof the
  refactor preserved its contract.
- The component boots from `initialToken` without fetching, and schedules the
  refresh from the supplied TTL.
- The component falls back to fetching when `initialToken` is null.
- **Booting from `initialToken` sets `booted`**, proven by a test where a
  subsequent 401 does NOT downgrade to visitor mode. Written so it fails if the
  flag is not set.
- Visitor mode is unaffected: no token, no fetch, no refresh.

## Coordination

`feat/support-ui` (PR #583) is downstream of this branch and already contains
these commits. That session owns the `messenger.tsx` conflict when it merges
forward and has asked that this change be shaped for this branch rather than
contorted around theirs. It must be told when this is pushed.
