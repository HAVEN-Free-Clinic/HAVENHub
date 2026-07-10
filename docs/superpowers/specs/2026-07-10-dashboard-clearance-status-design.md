# Dashboard "Your status" full semester clearance

Date: 2026-07-10
Scope: `src/app/(app)/page.tsx` only (dashboard side rail).

## Problem

The dashboard "Your status" card shows only a subset of clearance items: the
HIPAA line plus any training lines, hand-built inline in `page.tsx`. My Info's
Clearance section shows the complete set of items a member needs to be cleared
for the term (profile, HIPAA, training, learning, EHS) and an overall
cleared / not-yet-cleared state. The two are built from different code, so the
dashboard is both incomplete and prone to drift from My Info.

## Goal

Make the dashboard "Your status" card show every item required to be cleared for
the semester, matching My Info, without changing My Info or introducing a second
source of truth.

## Approach

Drive the card from `getOnboardingStatus(personId)` (`@/modules/onboarding/services/onboarding`),
the exact function My Info's Clearance card already uses. It is React-`cache()`d,
so it is one consolidated fetch per request (certs, courses, training tracks,
EHS, profile), and `listMyCertificates` inside it is also `cache()`d, so no
double fetch with the dashboard's existing cert load.

Keep the approved compact side-rail presentation (icon + title + sub + chevron
per row), and add an overall status indicator in the card header.

### What renders

Card header: `Your status` plus an overall indicator, shown only when there is
an active term (tasks present):
- `onboarding.cleared === true`  -> success dot + "Cleared"
- `onboarding.cleared === false` -> warning dot + "Not yet cleared"

`onboarding.cleared` is satisfied only when every task (including non-blocking
EHS) is satisfied, identical to the value My Info's Clearance card uses.

One compact row per task in `onboarding.tasks` whose state is not
`NOT_REQUIRED` (same filter My Info applies):

| Task key         | Label (from onboarding COPY) | Row link  |
|------------------|------------------------------|-----------|
| profile          | Profile & agreements         | /my-info  |
| hipaa            | HIPAA certificate            | /my-info  |
| training         | Volunteer training           | /training |
| directorTraining | Director training            | /training |
| learning         | Learning modules             | /learning |
| ehs              | EHS training                 | /my-info  |

Per row:
- Icon: two-state, unchanged from today. Satisfied (`state === "COMPLETE"`) ->
  green check on success background; otherwise clock on warning background.
- Title: the task label above.
- Sub text: friendly per-state text. HIPAA keeps its existing richer, expiry
  aware sub ("Valid through May 2027" / "Renew before ..." / "Upload a current
  certificate", etc.). Other tasks use short status text derived from the same
  `taskRequirement()` helper My Info uses (Complete / In progress / Not started),
  keeping labels and wording in parity with My Info.
- Chevron on the right, unchanged.

Links go to the real module pages (not the `/get-started` onboarding gate), so
the destinations are valid whether or not the person is already cleared. This
matches the current card, which already links HIPAA -> /my-info and
training -> /training.

### Fallback (no active term)

When `getOnboardingStatus` returns no tasks (no active term), fall back to
today's behavior: render the single HIPAA line (term-independent) with no
overall header indicator, so the card is never empty.

### Removed

The now-redundant inline `trainingLines` construction and its
`requiredTrainingTracks` / `resolveTrainingState` imports are removed from
`page.tsx` (training now comes from `getOnboardingStatus`). `complianceStatus`
and `certExpiresAt` stay: they still power the HIPAA row's expiry sub and the
"My Info" quick-action sub.

## Non-goals

- No change to My Info, the ClearanceCard component, or the onboarding engine.
- No schema, migration, or new component.
- No change to the underlying clearance rules or gating semantics.

## Verification

- `tsc --noEmit` clean (baseline confirmed clean before the change).
- `eslint` clean on the changed file (no-unused-vars for the removed imports;
  repo no-em-dash rule).
- Manual read-through of the rendered rows against My Info's task list.

Note: the full vitest suite is intentionally not run in this worktree. The
repo's `TEST_DATABASE_URL` points at a shared Neon database and the suite's
resetDb would wipe real data. This change is presentation/data-wiring over
existing, already-tested services, covered by typecheck + lint.

## Implementation steps

1. Import `getOnboardingStatus` (and its task type as needed) in `page.tsx`.
2. Call it alongside the existing dashboard data loads.
3. Build the row list from `onboarding.tasks` (filter `NOT_REQUIRED`), mapping
   each task to `{ ok, title, sub, href }` via a small pure helper; HIPAA sub
   reuses the existing expiry-aware line.
4. Compute the header indicator from `onboarding.cleared` (only when tasks exist).
5. Add the no-active-term fallback to the single HIPAA line.
6. Remove the dead `trainingLines` block and unused imports.
7. Render the header indicator and rows in the existing "Your status" Card.
8. `tsc --noEmit` + `eslint` on the file.
