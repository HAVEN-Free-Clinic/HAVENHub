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
2. One line on what is broken: the support assistant cannot load, so there is
   no way to reach anyone for help.
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
