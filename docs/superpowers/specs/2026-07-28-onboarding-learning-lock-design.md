# Learning modules inside the locked onboarding flow

**Date:** 2026-07-28
**Status:** Approved (design)

## Problem

An uncleared member (outstanding profile, HIPAA, training, learning, or EHS requirements) is
held at `/get-started` by the onboarding gate in `requirePersonSession`. Every step page renders
inside `OnboardingStepShell`: a slim bar with "Back to checklist", a progress chip, and no module
nav. Every step except one.

The learning step hands the member off into the real app. `/get-started/learning` links to
`/learning/<courseId>?from=onboarding`, which lives in the `(app)` route group, so it renders the
full `AppShell` toolbar and the learning `ModuleNav`. The member sees the whole hub: every module
tab, every dropdown, apparently theirs to use. Clicking any of them re-runs the gate and ejects
them back to `/get-started`. The nav looks live and is not.

Root cause: `ONBOARDING_ALLOWLIST` contains `/learning`, which admits an uncleared person to the
entire learning module (`src/platform/auth/onboarding-allowlist.ts:8`).

### Observed in production

PostHog captured the whole thing on 2026-07-27, person `cmq8z4rd5003mvwplu1fgdo2a`, 15:33 to 15:35
ET. Login, bounce to `/get-started`, `/get-started/learning`, then
`/learning/<courseId>?from=onboarding`, which puts them inside `AppShell`. Over the next twenty
seconds they clicked four nav tabs:

| Time (ET) | Target | Outcome |
| --- | --- | --- |
| 15:34:11.775 | `/recruitment` | bounced to `/get-started` after 147ms |
| 15:34:18.526 | `/support` | `$exception` 334ms later |
| 15:34:28.967 | `/schedule` | bounced to `/get-started` after 157ms |
| 15:34:35.026 | `/my-info` | `$exception` 282ms later |

Both exceptions are the same issue, `019fa512-2f04-71f3-bbe3-f5095eefb12d`, unhandled: minified
React error #310, "Rendered more hooks than during the previous render." The resolved stack lands
entirely in framework internals, with the throwing component being Next's own app router:
`updateWorkInProgressHook` from `updateMemo` from
`next/src/client/components/app-router.tsx:167`. So it is Next 16.2.11 crashing on a `redirect()`
that arrives mid soft navigation, not a conditional hook in a HAVEN component.

The issue has exactly 2 occurrences in 60 days, both from that session, because the learning
allowlist is the only way an uncleared member gets a nav bar to click.

Closing the allowlist removes the trigger, not the underlying framework bug. Any redirect during a
soft navigation could in principle hit it, `requirePermission` to `/no-access` being the obvious
other candidate, though the global nav is permission-filtered and the data shows zero other
occurrences. Worth a separate issue; out of scope here.

## Goals

- An uncleared member never sees app chrome. The course player renders in the same locked shell
  as every other onboarding step.
- Course content and progress persistence keep working from inside that shell.
- A member who has finished their courses but is still blocked on another step can reopen a
  completed course.

## Non-goals

- No change to the cleared-member experience. `/learning` and `/learning/<courseId>` stay exactly
  as they are for anyone past the gate.
- No wizard or auto-advance between courses. The member picks each course from the list, same as
  today.
- No change to the SCORM runtime, the SCO handoff, the beacon, or `ScormPlayer` itself.
- No change to the onboarding engine's clearance logic or to which steps block.

## Decisions (from brainstorming)

- **Chrome:** the course player opens inside `OnboardingStepShell`. Not a guided auto-advancing
  flow, not a single list-plus-player screen.
- **Review access:** the course list and completed courses stay reachable while the member is
  still blocked on another step. Today the step page redirects away the moment learning is
  complete, which leaves no way back into a course.
- **`ScormPlayer` placement:** stays at `src/app/(app)/learning/[courseId]/ScormPlayer.tsx` and is
  imported across route groups. Direct precedent: `/get-started/training` already imports
  `@/app/(app)/training/training-quiz`. Keeps the fragile SCO-handoff file out of the diff.
- **Deep links:** an uncleared member who hits `/learning/<id>` directly lands on `/get-started`.
  No special redirect mapping. Nothing emails such a URL, and the dashboard tile that points at
  `/learning` is only reachable by cleared members.

## Design

### 1. Close the allowlist

`ONBOARDING_ALLOWLIST` becomes `["/get-started", "/login", "/welcome"]`. An uncleared person can
no longer reach any route in the `(app)` group, so `AppShell` never renders for them.

This is safe for SCORM because both runtime endpoints authenticate with `auth()` directly and
never call `requirePersonSession`, so the gate does not apply to either:

- `src/app/(app)/learning/play/[courseId]/[...path]/route.ts` streams the package files the
  iframe loads.
- `src/app/api/learning/persist-cmi/route.ts` is the `navigator.sendBeacon` unload endpoint.

`persistCmiAction` (`src/app/(app)/learning/actions.ts`) does go through the gate, but Next posts
a server action to the current page's URL. From the new route that is `/get-started/learning/...`,
which is allowlisted.

### 2. Onboarding course route

New `src/app/get-started/learning/[courseId]/page.tsx`, following the shape of its `profile`,
`hipaa`, and `training` siblings:

1. `requirePersonSession()`, then `getOnboardingStatus(personId)`.
2. Redirect to `/` when `exempt || !hasActiveTerm || onboarded`, so the page is never a dead end
   for someone who does not belong in the flow.
3. Gate on `learning.access`. This replaces the `requireModuleAccess("learning")` check the
   `(app)` route performed. A member without it gets an in-shell `Alert` telling them to contact
   their director, not a redirect to `/no-access` (which the gate would bounce anyway, and which
   would otherwise leave the player rendering while every save silently failed, the #18 failure
   mode).
4. `getCourseForLearner(personId, courseId)`, which authorizes by course assignment and throws
   `LearningAuthError` otherwise. Same `notFound()` handling as the `(app)` route.
5. Render `<ScormPlayer courseId scos />` inside `OnboardingStepShell`.

`OnboardingStepShell` gains optional `backHref` and `backLabel` props (defaulting to
`/get-started` and "Back to checklist") so the course page reads "Back to courses" and returns to
`/get-started/learning` rather than jumping past it to the checklist.

`/get-started/learning` links to `/get-started/learning/${c.id}`, dropping `?from=onboarding`. The
now-dead `from === "onboarding"` back-link block and its `searchParams` prop are removed from
`src/app/(app)/learning/[courseId]/page.tsx`.

### 3. Review after completion

`/get-started/learning` currently redirects to `/get-started` when the learning task is `COMPLETE`
or `NOT_REQUIRED`. It will redirect only for `NOT_REQUIRED` (nothing to show) and otherwise render
the list, with completed courses carrying their Done badge and staying clickable. The course route
applies the same rule.

Entry point: `TaskRow` in `src/app/get-started/onboarding-checklist.tsx` renders a check glyph and
no link once a task is done. A blanket "Review" link for every completed task would dead-end,
because `/get-started/profile` and `/get-started/hipaa` both redirect away when their step is
complete. So `STEP_DEFAULTS` gains a `reviewable?: boolean` on the `learning` entry, carried
through `EffectiveStep` and `OnboardingTask` the same way `href` and `ctaLabel` already are, and
`TaskRow` renders a quiet outline "Review" link when the task is done, reviewable, and has an
`href`. Like `href` and `ctaLabel`, `reviewable` is app routing and is not term-configurable.

## Error handling

- Unassigned or unknown course id: `LearningAuthError` to `notFound()`, matching the `(app)` route.
  No enumeration.
- Missing `learning.access`: in-shell `Alert`, no redirect.
- Course with no uploaded package: `scos.length === 0` renders the existing "no content uploaded
  yet" copy, inside the shell.
- Save failure: unchanged. `ScormPlayer` already surfaces its own "progress could not be saved"
  warning and the beacon backstop still reaches `/api/learning/persist-cmi`.

## Testing

**Unit**

- `src/platform/auth/onboarding-allowlist.test.ts`: `/learning/abc` and
  `/learning/play/123/index.html` are no longer allowlisted; `/get-started/learning/abc` is.
- `step-config` coverage for `reviewable` surviving the defaults-plus-overrides merge.

**e2e** (`e2e/get-started.spec.ts`, extending the existing gate spec)

- Seed an uncleared VADM volunteer plus `seedCourseWithPackage({ deptCode: "VADM" })`. Log in,
  land on `/get-started`, follow the learning tile to `/get-started/learning`, open the course.
- Assert `iframe[title="Course content"]` is visible and the app toolbar is absent.
- Assert a direct navigation to `/learning/<courseId>` lands on `/get-started`.
- Note: a VADM-scoped course transiently gates the VADM dev volunteers, which is why this fixture
  cannot be org-wide. Safe under `workers: 1` and cleaned up in the fixture teardown.
- `e2e/learning.spec.ts` runs as the exempt admin and is unaffected.

## Files

| File | Change |
| --- | --- |
| `src/platform/auth/onboarding-allowlist.ts` | drop `/learning` from the allowlist |
| `src/platform/auth/onboarding-allowlist.test.ts` | flip the `/learning` assertions |
| `src/app/get-started/learning/[courseId]/page.tsx` | new: player in the locked shell |
| `src/app/get-started/learning/page.tsx` | link to the new route; stop redirecting when complete |
| `src/app/get-started/onboarding-step-shell.tsx` | optional `backHref` / `backLabel` |
| `src/app/get-started/onboarding-checklist.tsx` | "Review" link for a done reviewable task |
| `src/modules/onboarding/services/step-config.ts` | `reviewable` on the `learning` default |
| `src/modules/onboarding/services/onboarding.ts` | carry `reviewable` onto `OnboardingTask` |
| `src/app/(app)/learning/[courseId]/page.tsx` | remove the dead `?from=onboarding` back-link |
| `e2e/get-started.spec.ts` | locked-course-player coverage |
