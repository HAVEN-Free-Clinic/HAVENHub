# UX audit: flow friction, visual hierarchy, and IA (2026-07-28)

## Problem

HAVEN Hub has been audited eleven times, and two of those passes were whole-app UI
reviews (2026-07-11, 132 findings; 2026-07-17, 61 confirmed). Both were defect
audits: contrast ratios, missing ARIA, token drift, anti-patterns. All were burned
down.

None of them asked whether the app is *easy*. A page can pass every contrast check
and still leave a first-time volunteer with no idea what to do next. That is the
gap this audit targets.

A second, concrete complaint motivates it: action feedback in the app is a
server-rendered inline banner that persists until navigation. There is no transient
notification system at all. The desired behavior is a floating pill that confirms an
action and disappears.

## Goals

- Produce a ranked, actionable backlog of experience problems, weighted toward the
  people who use the platform most and understand it least.
- Ship a first batch from that backlog, including a real toast notification system.

## Non-goals

- Re-auditing the accessibility, contrast, and token-drift classes already burned
  down in the 2026-07-11 and 2026-07-17 passes. Regressions get noted opportunistically,
  not swept for.
- Stages 3 and 4 of the existing nav IA program. They are already specced separately.
- Any finding large enough to need its own design. Those get named and deferred,
  not smuggled into a backlog item.

## Lenses

Three, applied together:

1. **Task-flow friction.** Dead ends, unclear next steps, missing feedback, avoidable
   backtracking, state the user must hold that the app should hold for them.
2. **Visual polish and hierarchy.** Density, spacing rhythm, typographic hierarchy,
   scannability, consistency of page shells.
3. **Information architecture.** Whether things live where people expect them.

## Coverage

Weighted by population and frequency. The many use the app rarely and have no
training; directors and admins are few, trained, and in it constantly, so they absorb
friction better.

### Tier 1: browser-driven, full depth

Walked end to end as journeys, because flow friction lives *between* pages. A
page-by-page sweep structurally cannot see "I finished onboarding and had no idea what
to do next."

1. **Applicant applies.** `/apply` landing, sign-in (SSO or magic link), wizard
   sections with conditional questions and file upload, signature, review, submit,
   status tracker.
2. **Accepted applicant onboards.** Acceptance link, contract blocks and agreements,
   signature, Epic provisioning, completion.
3. **New volunteer first login.** `/get-started` gate, dashboard, "Your status"
   clearance card, action feed.
4. **Volunteer clears compliance.** Dashboard action card, `/my-info`, certificate
   upload, completion-date entry, verification-pending state.
5. **Volunteer completes learning and training.** `/learning` course list, SCORM
   player, completion; `/training` quiz and makeup gating.
6. **Volunteer works the schedule.** `/schedule`, `/schedule/full`,
   `/schedule/requests`.
7. **Volunteer reports a concern.** `/incidents`, `/incidents/mine`.
8. **Volunteer files a tech request.** `/support/new`, `/support`.
9. **Volunteer uses clinic tools.** `/clinic/avs`, English and Spanish.
10. **Notifications.** Bell, `/notifications`.

### Tier 2: code-reading, lower depth

Recruitment management (cycles, builder, scoring, speed-route, decisions, interviews,
onboarding, emails), schedule builder and attendings, volunteers compliance/EHS/Spanish
review/offboarding, incidents review and strikes, support all-requests and Epic tools,
learning manage and completion, and the eleven admin pages.

## Finding model

### Severity, in UX terms

- **Blocks or misleads.** The user cannot finish the task, or the app leaves them
  wrong about what happened. A destructive action with no success confirmation is this
  class.
- **Costs time or confidence.** The task completes, but with avoidable backtracking,
  re-reading, or uncertainty about whether it worked.
- **Polish.** Looks unconsidered or inconsistent. No task cost.

### Ranking

Rank on **severity times reach**, not severity alone. Because coverage is weighted by
population, a tier-1 "costs time" item can and should outrank a tier-2 "blocks" item.
A confusing step in the applicant wizard hits every applicant every cycle. A clunky
admin settings page hits one person.

Stating this rule explicitly is what keeps the backlog pointed at everyone using the
platform, rather than drifting toward whatever is most technically offensive.

### Record format

Each finding carries: id; journey and step (tier 1) or `file:line` (tier 2); lens;
severity; reach; evidence; one or two sentences on what is wrong; the concrete fix;
and effort as S (under an hour), M (half a day), or L (multi-day).

### Rules that keep this off the treadmill

1. Every finding names an observed consequence, not a heuristic violation. "Violates
   a Nielsen heuristic" is not a finding. "The review step's only way back is
   browser-back, which drops answers" is.
2. No finding whose fix is "consider improving X." If the fix cannot be written down,
   the finding is not ready.
3. Anything genuinely L moves to a "needs its own brainstorm" appendix instead of
   sitting in the shippable backlog pretending to be a task.

### Cap

40 findings. If more candidates survive, the lowest-ranked are cut and the document
states how many were cut and what they were about. No silent truncation.

## Pre-seeded findings

Two are already confirmed and go in the document without needing rediscovery.

### Toast notification system

**Current state.** Action feedback is a server-rendered inline `<Alert>` driven by
redirect search params: 121 `?error=` sites, 37 `?saved=` sites, plus `?windowsaved=`
and `?status=` one-offs. `Alert` is imported by 73 files. The only floating
notification in the app is the inactivity warning.

**Design.**

Two sources feed one `<ToastViewport>`, mounted once outside the glass containers.
This placement is required, not stylistic: `.glass-bar`'s `backdrop-filter` creates a
containing block that breaks `fixed` children, which is why `HelpLauncher` is already
mounted outside the toolbar.

1. **Flash params.** A client component reads `saved` / `error` from the URL, pops a
   toast, then strips the param with `router.replace` so a refresh does not re-fire
   it. The 158 existing redirect sites are not touched. The server-action contract
   stays as it is.
2. **Client callers.** A `useToast()` hook for actions that never round-trip the
   server.

   **Correction, 2026-07-29.** This section originally cited the "Copy email" button in
   `src/modules/support/components/epic-request-form.tsx` as the motivating example of a
   silent no-op. Task 10 verified that it was already fixed in commit `f007277b` on
   2026-07-11, before this audit began: `handleCopyEmail` now guards on
   `navigator.clipboard`, awaits the write, and reports both outcomes through an
   `aria-live` region. The example was stale, inherited from the 2026-07-11 audit
   document. It must not appear in the audit findings as a live defect.

**Successes auto-dismiss, errors do not.** This is a deliberate deviation from a
literal "make them disappear." Auto-dismissing an error is a usability failure: the
user may not have been looking, and an error usually requires action. Success and
info auto-dismiss at roughly four seconds. Error and warning persist until dismissed
and carry a close button. All are click-dismissible.

**Inline alerts do not all go away.** Form validation bound to a specific field stays
inline. "Enter a valid email address" belongs next to the input, not floating at the
bottom of the screen. The migration rule is: page-level flash confirmations become
toasts, form-bound validation stays put. Without that rule, a mass migration makes
error UX worse.

**Visual.** Solid brand-dark pill in both themes, tone carried by the leading icon
rather than a filled background. This matches the reference screenshot and is already
the stated principle in `src/platform/ui/alert.tsx`: color lives in the leading tone
icon, not a filled banner. Bottom-center placement. Polite live region for success and
info, assertive for errors, mirroring current `Alert` semantics. `prefers-reduced-motion`
respected. Three visible at once, the rest queued.

**Staging.** This is two backlog items, not one. Building the system is small. Removing
the inline flash `Alert` renders from the roughly 30 to 40 pages that show them is the
expensive half, and leaving both would double-report every action. System plus
highest-traffic pages first, remainder as a follow-up.

### Bottom-right overlay collision

`HelpLauncher` sits at `fixed bottom-6 right-6`
(`src/platform/ui/help/help-launcher.tsx:106`) and the inactivity warning at
`fixed bottom-4 right-4` (`src/platform/auth/inactivity.tsx:62`). They overlap when
both are visible. This is part of why toasts go bottom-center.

## Method

### Environment

**Amended 2026-07-28 after the pre-flight scan.** This section originally called for
Docker. That was wrong: a native Postgres already listens on port 5434 with the same
`haven` role and `haven_dev` password the compose file uses, hosting the repo's
per-worktree databases, so `npm run db:up` would fail to bind the port. The audit
instead uses a dedicated `havenhub_uxaudit` database on the running instance. Docker is
not involved, which removes this spec's named single point of failure.

Persona switching goes through the local dev email form on `/login`, which accepts any
seeded Person outside production.

The journey walks use Playwright MCP rather than the Chrome extension, which is not
connected in this environment.

### Fixture gap

The seed produces a working app, not a realistic one. Several tier-1 journeys need
states that do not exist fresh: a volunteer with a pending HIPAA certificate, an open
cycle with a half-finished draft application, a course with an actual SCORM package.
These get built through the UI where possible and a throwaway script under `scripts/`
where not. `prisma/seed.ts` is not permanently changed.

### Journeys that cannot be fully walked

Magic-link login depends on queued email delivery, SCORM upload depends on Blob
storage plus a real package, and Yale SSO does not exist locally. Where a step cannot
be walked it gets a code-reading pass and is labeled as such in the finding. Uneven
coverage stated plainly beats implied coverage that did not happen.

### Evidence

Screenshots live in the session scratchpad and are not committed; a few dozen PNGs is
real repo bloat for a document that will be stale within a month. Findings cite
`file:line` and describe what the screenshot showed. If a single finding is genuinely
unintelligible without the image, that one image is committed under `docs/assets/`.

## Deliverable

`docs/full-app-ux-audit-2026-07-29.md`, matching the existing `docs/full-app-*-audit-*.md`
naming. Committed on `worktree-design+ux-audit-flow-friction` as its own PR, so a
document review never blocks a fix.

The implementation batch selected from it gets separate branches and its own spec and
plan.

## Verification

The document itself needs prose review only.

The implementation batch that follows needs: unit tests on the toast queue and the
flash-param-to-toast conversion; e2e coverage on at least one converted action, since
the e2e suite runs in CI and UI label changes break it; `npx eslint src e2e` while
iterating (plain `npm run lint` walks the gitignored design-system directory and
produces noise); full `npm run lint` before push; `npm run typecheck`.

No em-dashes anywhere. That is a CI-enforced lint rule in this repo (`local/no-em-dash`).

## Open risks

- ~~**Docker is not currently running.**~~ Retired 2026-07-28: the audit uses the
  already-running native Postgres instead, so there is no Docker dependency. The
  residual risk is smaller: if the dev server or that Postgres instance goes down
  mid-audit, tier 1 stalls until it is restarted.
- **The 40-finding cap may bind hard.** Three lenses across ten journeys can plausibly
  generate more than 40 real findings. The cut list is reported rather than hidden, but
  if the cap binds badly it is a signal to split the audit by tier instead of raising it.
