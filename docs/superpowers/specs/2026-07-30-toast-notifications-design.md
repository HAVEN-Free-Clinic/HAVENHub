# Action feedback has nowhere to go but the URL (2026-07-30)

## Problem

Every confirmation and every error in HAVEN Hub is a server-rendered inline `<Alert>` driven by a
redirect search param. Re-verified against `origin/main` on 2026-07-30: **121 `?error=` sites, 37
`?saved=` sites**, `Alert` imported by **74 files**, and `grep -ril toast src` returns **zero
matches**. The only floating notification in the app is the inactivity warning.

Three consequences follow.

**Every confirmation costs a full round trip and leaves a param in the URL.** Refreshing re-fires
the banner, and the URL a user copies or bookmarks carries "Saved." in it.

**Client-only actions have nowhere to report at all.** A copy, a local toggle, a validation that
never reaches the server has no feedback channel, because the only channel is a redirect.

**The two floating elements collide.** `HelpLauncher` renders at `fixed bottom-6 right-6 z-50`
(`src/platform/ui/help/help-launcher.tsx:106`) and the inactivity warning at `fixed bottom-4
right-4 z-50` (`src/platform/auth/inactivity.tsx:62`). They overlap at the same stacking level, and
the thing that loses is a `role="alert"` telling the user they are about to be signed out.

Audit findings **R11** and **R12** (PR #474), plus **B6**, the migration that R11 staged away.
Jack chose on 2026-07-30 to do all three in one change.

## What the audit got wrong about the scale

The audit modelled this as "a client component reads `saved` / `error` from the URL" across "roughly
30 to 40 pages". The real surface, inventoried on 2026-07-30, is larger and more varied:

**57 pages** read a flash-ish param, and roughly **30 distinct param names** are in play. Beyond
`error`, `message`, and `saved` there is a whole suffixed-error family (`rosterError` 29 uses,
`rbacError` 18, `senderError`, `manageError`, `certError`, `scoreError`, `routeError`,
`incidentError`, `attachmentError`, `commentError`, `epicError`, `lastError`) and a long tail of
success flags (`submitted`, `sent`, `skipped`, `copied`, `retried`, `retriedAll`, `connected`,
`tested`, `senderTested`, `senderSaved`, `certSaved`, `stepsSaved`, `scheduled`, `cancelled`,
`withdrawn`, `requested`).

**`status` is a filter, not a flash.** It is validated against an enum on
`support/all`, `admin/notifications`, `admin/email`, `volunteers/master`, and `incidents/review`. A
reader that stripped `?status=` would silently break filtering on five pages. Same for `page`, `q`,
`tab`, `token`, `type`, `term`, `track`, `next`, `callbackUrl`, `view`, `mode`, `date`, `dept`.

**`message` is not an independent flash.** It is the detail payload for `error=validation`
(`admin/notifications/page.tsx:94-99`). It must be consumed with `error`, never on its own.

This is why the design below is a **registry with a convention**, not a hardcoded pair of param
names. A hardcoded pair would have missed most of the surface; a pure heuristic would have eaten the
filters.

## Goals

Give every action a transient, non-URL feedback channel, give client-only actions any feedback
channel at all, and stop the session-expiry warning from being covered by the help bubble.

## Non-goals

- **Changing the 158 redirect sites.** Server actions keep redirecting with params exactly as they
  do. Only the consuming side changes. This keeps the diff to pages and one new module.
- Replacing form-bound validation. See the migration rule below.
- Any change to `Alert` itself. It stays, and stays used.

## Design

### 1. One viewport, mounted in the root layout

`<ToastViewport>` mounts in `src/app/layout.tsx` beside `InactivityTracker`, **not** in `AppShell`.

Two reasons, both load-bearing. Flash params exist outside the `(app)` group: `login/page.tsx`,
`login/verify`, `apply/page.tsx`, `apply/verify`, `apply/[slug]`, and three `get-started` pages all
carry them, and `AppShell` does not wrap those. And `.glass-bar`'s `backdrop-filter` creates a
containing block that breaks `fixed` children, which is why `HelpLauncher` is already mounted
outside the toolbar. The root layout is outside every glass container by construction.

### 2. Classify params by convention, with a registry for the exceptions

The reader needs to know, for a given param, whether it is a flash at all, what tone it carries, and
what text to show. Three value shapes exist in the codebase today:

1. **The value IS the message.** `{sp.error}`, `{rbacError}`. The redirect encodes human text.
2. **The param is a flag, the page hardcodes the text.** `saved === "1"` renders "Saved."
3. **The param is a count and the page composes a sentence.** `sp.sent !== undefined` renders a
   sentence built from the count.

So:

**Convention handles shape 1**, which is the large majority. A param named `error`, or matching
`/Error$/`, is an error-tone flash whose message is its own value. That single rule covers all 121
`error` sites and the entire suffixed-error family with no per-param registration, and it is why the
migration is tractable at 57 pages.

**Amended 2026-07-30, after Task 1 shipped.** Shape 1 is not uniform, and this spec originally
missed it. There are **two** error conventions in the codebase:

- **85 sites encode a human message**: `?error=${encodeURIComponent(err.message)}`, which is what
  `runAction`'s `errorRedirect` produces. The value is the text. The convention above is correct
  for these.
- **Roughly 36 sites send a slug**: `?error=validation` (18), `?error=forbidden` (7),
  `?error=not-found` (4), plus `person-not-found`, `subject-not-found`, `link`, `future-date`,
  `blank-description`, `bad-category`. The value is a *code*, and the page owns an `ERROR_MESSAGES`
  lookup that turns it into text with a generic fallback. **Eight pages** do this.

A classifier that always treats the value as the message would show a user the raw string
"forbidden". So the module also needs a code table: if a value matches a known code, the toast shows
that code's text; otherwise the value is the message.

**Corrected 2026-07-31, after the whole-branch review.** This section first said an unrecognised
code should fall back to a generic "An unexpected error occurred.", matching what those pages do.
That is wrong as a module-level rule and was **not** implemented. The classifier cannot tell an
unrecognised *code* from a *message*, and the overwhelming majority of values are messages: 85 sites
send `encodeURIComponent(err.message)`. A generic fallback would replace every one of those with
"An unexpected error occurred.", destroying far more information than it saves. So an unrecognised
value is treated as the message, which is exactly right for the 85 and merely imperfect for a
handful of unregistered slugs. The per-page generic fallback still exists on the pages that own
their own vocabulary, which are ruled INLINE and keep their `Alert`.

The eight tables do **not** share one vocabulary, so this is not a mechanical merge.
`incidents/page.tsx:44-48` maps `forbidden` / `subject-not-found` / `validation`, while
`login/page.tsx:17-23` maps NextAuth's `CredentialsSignin` and `MemberLinkExpired`. Only the
genuinely generic codes belong in the shared table. **A page whose codes are its own vocabulary is
ruled INLINE**, and `login` is the clearest case: an authentication failure belongs next to the
sign-in form, not floating at the bottom of the screen. That is the migration rule below doing its
job, not an exception to it.

**An explicit registry handles shapes 2 and 3**, and nothing else. Each entry declares the param or
params it owns, the tone, and a function from their values to the message. `saved` maps to "Saved."

**An entry can own more than one param.** `recruitment/cycles/[id]/decisions/page.tsx:36-40` renders
a single Alert from `sent` *and* `skipped`: "Released N acceptance email(s); skipped M conflicted
applicant(s)." One toast, two params, both stripped together. A registry keyed strictly one param to
one message could not express that and would fire two half-sentences.

**A param not matching the error convention and not in the registry is left completely alone**,
which is what protects `status`, `page`, `q`, and the rest of the filter vocabulary.

**Amended 2026-07-30, after the Task 2 inventory. Registry entries are pathname-scoped.** This spec
assumed a param name meant one thing app-wide. The inventory disproved that:

- **`saved` is not one message.** The seeded `saved` to "Saved." entry is correct for about five
  sites. At least six more pages render their own text ("Changes saved.", "Assignment saved.",
  "Campaign saved.", "Availability saved successfully."), and two map `saved` through a per-page
  whitelist to entirely different sentences.
- **`sent` means three different things**: a count paired with `skipped` on the decisions page, a
  flag paired with `promoted` on the waitlist page, and a standalone recipient count on the campaign
  page.
- **`?error=not-found` conflicts outright**: "The incident report could not be found." on
  `incidents/[id]` versus "The disciplinary action could not be found." on `incidents/strikes`.

So a registry entry, and an entry in the error-code table, may carry an optional pathname scope. An
unscoped entry is the default for that param; a scoped entry wins where it matches. Without this the
migration would silently rewrite user-facing copy on a dozen pages, which is the kind of change
nobody asks for and nobody notices until it is wrong.

**Three more corrections from the same inventory:**

- `schedule/page.tsx` sets `message=reminded` and `message=already_reminded` **with no `error`
  present**. The shipped classifier claims `message` only alongside `error`, so these would silently
  vanish. They need their own registry entries.
- Two pages use **`err` and `msg`**, not `error` and `message`
  (`recruitment/cycles/[id]/onboarding`, `.../training`). The convention does not claim them, and
  they must fire as two independent toasts rather than one composed group.
- **`lastError` is not a URL param at all**, it is a database column. It appeared in this spec's own
  suffixed-error list by mistake. Do not register it.

And one pre-existing bug the inventory surfaced, **not caused by this branch and not fixed by it**:
on `admin/people/[id]`, a roster edit pops "Saved." on the unrelated profile form, because both
share the `saved` param. Worth a follow-up.

The registry lives in one module so that adding a flash param is one edit in one reviewable place,
and so the reader and the pages cannot drift apart about who owns a param.

### 3. The reader strips what it consumes

A client component reads the URL, pops a toast for each param the convention or registry claims,
then removes exactly those params with `router.replace`, leaving every other param untouched. A
refresh then does not re-fire the toast, and filters survive.

`message` is special-cased as `error`'s payload: consumed together, stripped together, never
independently.

### 4. `useToast()` for client callers

A hook for actions that never round-trip the server. This is the half of R11 that is genuinely new
capability rather than a relocation of existing feedback.

### 5. Successes auto-dismiss, errors do not

A deliberate deviation from a literal "make them disappear". Auto-dismissing an error is a usability
failure: the user may not have been looking, and an error usually requires action. Success and info
auto-dismiss at about four seconds. Error and warning persist until dismissed and carry a close
button. All are click-dismissible. Three visible at once, the rest queued.

Polite live region for success and info, assertive for errors, mirroring what `Alert` already does
(`alert.tsx:52`). `prefers-reduced-motion` respected.

### 6. Visual

Solid brand-dark pill in both themes, tone carried by the leading icon rather than a filled
background. That is already the stated principle in `alert.tsx`: "Color lives in the leading tone
icon, not a filled banner." Bottom-center placement.

### 7. One bottom-center lane, and the help bubble keeps its corner

R12. The inactivity warning moves from `bottom-4 right-4` into the same bottom-center lane as the
toast viewport, stacked so the two can never overlap. `HelpLauncher` is left alone in the
bottom-right corner it already owns. Both the warning and the viewport live in the root layout, so
sharing a lane is a natural consequence of where they mount rather than a coordinated offset.

### 8. The migration rule

**Page-level flash confirmations become toasts. Form-bound validation stays inline.** "Enter a valid
email address" belongs next to the input, not floating at the bottom of the screen. Without this
rule a mass migration makes error UX worse.

**A page must never render both a toast and its own inline `Alert` from the same param**, or every
action double-reports. This is the one invariant that makes the migration all-or-nothing per param:
the moment the registry claims a param, every page reading that param must drop its inline render in
the same change.

## Consequences

**This is a large diff touching most route groups.** 57 pages, chosen deliberately over a staged
migration, because a half-migrated app has two feedback idioms at once and that is worse than either
endpoint.

**Messages that pages currently compose move into the registry.** Shapes 2 and 3 mean some
user-facing strings relocate from a page into a shared module. That centralizes copy that was
previously per-page, which is mostly good and occasionally a loss of context. Where a message
genuinely depends on page-local data the page should keep composing it and call `useToast()`
directly rather than forcing it into the registry.

**The URL still carries the param on first paint.** The reader strips it after mount, so there is a
brief window where the param is in the address bar. That is a visible improvement over today, where
it stays forever, but it is not the same as never putting it there.

## Testing

- The convention classifies `error` and `*Error` as error-tone flashes and leaves `status`, `page`,
  `q`, `tab`, `token`, `view`, `mode` untouched. **Assert the filter names explicitly**, because
  eating one silently breaks a page's filtering with no error.
- `message` is consumed and stripped only alongside `error`, never alone.
- The reader strips exactly the params it consumed and preserves every other param on the URL,
  including when a flash param and a filter param are present together.
- A refresh after the strip does not re-fire the toast.
- Success and info auto-dismiss; error and warning persist until dismissed.
- The live region is polite for success and assertive for error.
- No page renders both a toast and an inline `Alert` from the same param. This is worth a
  repo-wide check rather than a per-page one.
- The inactivity warning and the toast viewport cannot overlap when both are visible.

## Risks

- **Eating a filter param is the highest-consequence failure mode**, and it fails silently: the
  page just stops filtering. The convention is deliberately narrow (`error` and `/Error$/` only) and
  everything else must be explicitly registered for exactly this reason.
- **57 pages is a lot of individually small judgment calls.** The registry is what keeps the
  judgment in one reviewable file instead of spread across the diff, but each page still needs
  someone to decide whether its alert is page-level flash or form-bound validation.
- **The inventory was built by pattern matching and over-matches.** `count` in
  `incidents/page.tsx`, for one, is a word in a code comment rather than a param at all. Every
  candidate must be confirmed against its actual read site before it goes in the registry, and the
  cost of guessing wrong in the permissive direction is eating a filter.
- **The audit's own scale estimate was wrong by roughly half**, which is worth remembering when its
  size estimates are used to sequence anything else in the backlog.
