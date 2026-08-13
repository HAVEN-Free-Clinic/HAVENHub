# Content blocker gate

Date: 2026-08-11
Branch: `feat/content-blocker-gate`, based on `feat/intercom-support` (PR #579)

## Problem

Content blockers break the Intercom Messenger, and a member whose Messenger is
blocked has no way to reach support and no indication that anything is wrong.
The Help bubble is simply dead.

The Messenger has two independently blockable halves:

1. `/api/support/messenger-token`, our own first-party route. Filter lists match
   on URL substrings, so first-party paths are not safe by construction. This
   already happened once: `/api/intercom/token` was blocked outright, observed
   as Chrome `(blocked:other)` against our own origin, which is why the route
   carries the name it does today. See the comment on `MESSENGER_TOKEN_PATH` in
   `src/platform/intercom/messenger.tsx`.
2. `widget.intercom.io` / `js.intercomcdn.com`, which EasyPrivacy blocks by
   default. Nothing we do on our side changes this.

Either one being blocked means support is unreachable.

## Decision

When a content blocker is breaking the Messenger, block the app with a modal
that cannot be dismissed. The user disables the blocker or they do not proceed.

This is deliberately the strongest option available, chosen with the tradeoff
understood: a false positive is a total lockout with no self-serve recovery.
The design compensates on the detection side rather than by weakening the gate,
and it always offers an out-of-band contact route (see "The modal", item 5).

### Non-goals

- Detecting content blockers in general. A blocker that does not break the
  Messenger breaks nothing the user can see, so there is nothing to demand.
  Bait requests and cosmetic-filter bait elements are explicitly not used.
- Protecting PostHog. Analytics loss is a cost to us, not to the member, and
  is not grounds for locking someone out of clinic work.
- Being unbypassable. This is client-side and can be defeated with devtools or
  by disabling JavaScript. It enforces compliance, not security. There is no
  server-side way to detect a client content blocker.

## Scope

Authenticated hub routes only, via the `(app)` layout.

`/login`, the applicant portal (`apply.havenfreeclinic.org`), public passport
pages (`/credential/...`), `/onboard/[token]`, and `/get-started` are all
untouched. Gating the applicant portal would stop a prospective volunteer from
submitting an application, and gating a public credential page would show a
blocker demand to whoever a member shared their passport with.

## Architecture

Two new files under `src/platform/intercom/`:

| File | Responsibility |
| --- | --- |
| `blocker-probe.ts` | Detection. Pure async, no DOM, no React. Unit-testable against a mocked `fetch`. |
| `blocker-gate.tsx` | Client component. Runs the probe, renders the modal, handles re-checking. |

`BlockerGate` mounts in `src/app/(app)/layout.tsx` beside `IntercomMessenger`,
under the same `supportAppId ?` guard.

Reusing that guard rather than adding a feature flag is load-bearing:

- `intercomAppId()` is null wherever `NEXT_PUBLIC_INTERCOM_APP_ID` is unset,
  which is local dev, CI, the Playwright e2e suite, preview deploys, and the
  demo deploy. The gate is inert in all of them.
- That is what keeps a hard block from breaking the comprehensive e2e suite.
  A gate that could fire in CI would take the whole suite down.
- The gate cannot outlive the feature it protects. Turning the Messenger off
  turns the gate off in the same motion.

`branding.supportEmail` is read in the server layout and passed to
`BlockerGate` as a prop, the same way other branding values reach client
components.

### Amendment, 2026-08-12: the runtime kill switch

Everything above still holds; the `supportAppId` guard stays exactly as
described. The gate carries one **additional** condition on top of it: the
`support.blockerGateEnabled` setting (registry, category Operations, default
true), read in the same server layout via `getSetting`.

The reason is a case the detection cannot answer, raised by the final review.
An Intercom outage at the *network* layer (DNS, TCP, or TLS failure rather than
an HTTP 503) rejects the widget fetch exactly the way a content blocker does,
while the control probe still passes, because our own origin is fine. Detection
cannot tell those apart from inside the browser, so such an outage would gate
every member at once. The only recovery available was unsetting
`NEXT_PUBLIC_INTERCOM_APP_ID`, which is inlined at build time and therefore
needs a full rebuild, and which takes the Messenger down as well.

The condition is deliberately one-way: `IntercomMessenger` still mounts on
`supportAppId` alone, so standing the gate down stops the app blocking anyone
without removing support from the members who can still reach it. A flip takes
effect inside `getSetting`'s 30 second cache, with no deploy.

The setting is read in the server layout, so it applies on a member's next full
page load rather than mid-session. That is the right granularity here: the probe
itself runs once per page load, and a member already stuck behind the modal
cannot navigate anyway, so reloading (the obvious thing to do when a page seems
stuck) is what picks the change up. The help text says so.

This does not weaken "the gate cannot outlive the feature it protects": the
setting can only ever subtract the gate, never add it where the Messenger is
absent.

## Detection

Three fetches, issued together, once the tab is visible and `navigator.onLine`
is true.

| Probe | Request | Blocked signal |
| --- | --- | --- |
| A. Token endpoint | `GET /api/support/messenger-token`, `cache: "no-store"` | promise rejects (`TypeError`) |
| B. Messenger widget | `GET https://widget.intercom.io/widget/<appId>`, `mode: "no-cors"`, `cache: "no-store"` | promise rejects |
| Control | `GET /brand/haven-mark.svg`, `cache: "no-store"` | promise rejects |

The probe runs once per full page load, on mount. `BlockerGate` lives in the
`(app)` layout, so it survives soft navigation and does not re-probe on every
route change. It runs again only on the re-check paths described under
"The modal".

### Decision rule

Evaluated in order:

1. `navigator.onLine === false`: stand down, no gate.
2. The tab is hidden: defer, and run the probe when it next becomes visible.
   This is not a stand-down. A member who opens the hub in a background tab
   still gets gated once they look at it.
3. Control rejects: the network or the server is the problem, not a blocker.
   Stand down, no gate.
4. A responds `404`: the integration is switched off server-side, so there is
   nothing to protect. Stand down, no gate. This matches the rule
   `messenger.tsx` already applies to the same status.
5. A responds with any other status, including `401`, `500`, and `503`: not
   blocked. A response of any kind proves the request left the browser.
6. Control succeeds and (A rejects or B rejects): retry the rejecting probes
   once after 2 seconds. If the rejection repeats, gate. The delay is long
   enough to clear a momentary fault and short enough that a genuinely blocked
   member is not left staring at a working-looking app.

Rule 0, added 2026-08-12: every request is bounded by a 5 second
`AbortController` deadline, matching `INTERCOM_LOOKUP_TIMEOUT_MS`. A timeout
counts as **reached**, never as blocked. A blocker rejects immediately, so a
request still in flight after the deadline is evidence of a slow network, and a
firewall that drops rather than rejects packets (the usual corporate and clinic
posture) would otherwise leave the fetch pending for minutes with the re-check
button disabled throughout.

**Exception, also 2026-08-12: a timed-out control is not proof the network
works.** Rule 0 makes a timeout `reached: true` for every probe, including the
control, so that a merely slow network can never gate anyone. But rules 3 and
6 test `!control.reached` (now `!controlProvesNetwork(control)` in
`blocker-probe.ts`) as the check for "the network is at fault, stand down".
Those are two different questions answered by the same field. For the token
and widget probes, a timeout deliberately means "not blocked". For the
control, whose only job is to prove the network works, a timeout means the
opposite: it proves nothing, because the request never actually got an
answer. Treating `reached: true` on the control as sufficient would read a
control that HANGS as a control that SUCCEEDED, so a network where the
control times out while token and widget both reject on both rounds would
gate the user on a network that never actually answered anything. Both
control checks (the initial one and the one on the retry path) therefore
require `status !== null` in addition to `reached`, via the
`controlProvesNetwork` helper, so a timed-out control stands the gate down
the same as an unreachable one.

### Why each guard exists

- **The control probe** is what makes a hard block defensible. An offline
  laptop, a Neon blip, and a Vercel hiccup all fail the control too, so none of
  them can masquerade as a blocker. Without it, every transient network fault
  would lock a member out.
- **The control is on a different path prefix from A** so the two are
  independent. Sharing a prefix would mean a filter matching that prefix fails
  both, and rule 3 would silently stand down on exactly the case we most want
  to catch.
- **Any-status-is-a-pass on A** avoids conflating server errors with blocking.
  A 503 from a DB outage is not a content blocker.
- **The 404 stand-down** keeps the gate dormant wherever the integration is
  off, belt-and-braces with the `supportAppId` mount guard.
- **The single retry** absorbs one transient hiccup without meaningfully
  delaying a real detection.
- **The visibility deferral** avoids background-tab fetch throttling reading as
  a block.

### Why the control is a static asset

`/brand/haven-mark.svg` already exists and is served statically, so the control
costs nothing on the server. It cannot reuse `/api/health`, which runs two
queries per call and would add that cost to every authenticated page load, and
it does not need a new route.

It also degrades well. The rule is "control rejects means the network is at
fault", and a renamed or deleted asset returns a `404`, which *resolves*. A
future asset rename therefore cannot silently disable the gate, which is the
failure mode a purpose-built route would have had.

## The modal

Portalled to `document.body`, for the reason `HelpLauncher` does the same:
`backdrop-filter` ancestors trap `fixed` descendants. Styled to match the
existing `Modal` primitive (`glass-panel` on the panel, the fixed dark scrim
behind it, canonical radii) so it reads as the same kind of object as every
other dialog in the hub, and layered above the help bubble and the toast
viewport.

It does not reuse the `Modal` primitive itself. `Modal` renders an
unconditional close button and calls `onClose` on Escape and backdrop click.
Passing a no-op `onClose` would leave a dead X on screen, which reads as
broken exactly when the user most needs to trust the page. The gate borrows
`Modal`'s focus-trap and scroll-lock technique instead of its contract.

It is a real block: full-viewport overlay, body scroll locked, focus trapped,
`role="dialog"` with `aria-modal`, no close affordance, and Escape does
nothing.

Content, in order:

1. A heading naming the cause plainly.
2. One line on what is broken: something is blocking HAVEN Hub, so critical
   parts of the app will not work.

   Amended 2026-08-12. This deliberately claims more than the probe measures,
   which only proves the Messenger is broken. Naming support alone invited the
   reasonable reply "I do not need support right now", which makes a block with
   no way past it look disproportionate and arbitrary. What the member is
   actually facing is an app they cannot use, and anything aggressive enough to
   kill the Messenger is routinely killing other requests too. The line is kept
   symptom-level ("something is blocking") rather than diagnostic for the same
   reason the heading is: an Intercom network outage produces this signal too,
   and the copy must not assert a cause we cannot prove.
3. How to fix it, covering more than browser extensions, because the detection
   catches all of them: the extension icon and disabling for this site, Brave
   Shields, Safari content blockers, and an acknowledgement of network-level
   filters (Pi-hole, managed devices) that the user cannot toggle per site.
4. An "I've turned it off" button that re-runs the probe and clears the gate in
   place on success, with no reload. The gate also re-probes on window focus,
   since disabling a blocker means leaving the tab and coming back.
5. `branding.supportEmail` as a plain `mailto:`, via the existing `SupportLink`.
   This is not a way into the app. It is the only contact channel a blocker
   cannot kill, and it is what a user on a managed device or behind a
   network-level filter has left.

### Telemetry

One PostHog capture when the gate appears, tagged with which probe failed (A,
B, or both), and one when it clears. `/ingest` is same-origin proxied, so these
usually survive the blocker that triggered them, and they are the only way to
learn how often this fires and how many people get stuck.

## Testing

### `blocker-probe.test.ts`

One case per branch of the decision rule, against a mocked `fetch`. The
false-positive guards are the point of most of them.

| Case | Expected |
| --- | --- |
| Control rejects | no gate |
| A responds 404 | no gate |
| A responds 401 | no gate |
| A responds 503 | no gate |
| A rejects, control succeeds | gate |
| B rejects, control succeeds | gate |
| A and B both reject | gate, tagged with both |
| Rejects once, succeeds on retry | no gate |
| `navigator.onLine === false` | no gate |

### `blocker-gate.test.tsx`

Follows the `env-banner` and `global-nav` component-test precedent: renders
nothing when the probe is clean, renders the dialog when it is not, and clears
the dialog on a successful re-check.

### Not covered by tests

No e2e. The gate is inert without `NEXT_PUBLIC_INTERCOM_APP_ID`, and setting it
in the e2e env would boot the real Messenger across the entire suite for the
sake of one test.

The real behaviour is therefore verified manually: uBlock Origin against a
preview deploy, confirming both that the gate fires and that turning the
blocker off clears it. That manual step is the only proof that the probes match
what blockers actually do, so it is required before merge, not optional.
