# Onboarding flow (in-flow task completion) — design

**Date:** 2026-06-11
**Branch:** `feat/onboarding-gate` (PR #34)
**Status:** Approved design, pending implementation plan
**Builds on:** `2026-06-11-onboarding-gate-design.md`

## Problem

The onboarding gate currently deep-links each checklist task to its full app page
(`/my-info`, `/training`, `/learning`). Those pages render inside `AppShell` with the
full module nav, so completing a task drops the volunteer into the live hub and out of
the onboarding context. We want task completion to happen **inside a contained
onboarding flow** so a not-yet-cleared volunteer stays in onboarding until done.

## Shape: hub-and-spoke

The `/get-started` checklist stays the hub. Each task CTA opens an **onboarding-scoped
sub-route** that renders the task's completion UI inside onboarding chrome (no
`AppShell`). Finishing a task returns to the checklist with that task marked done.
Tasks may be done in any order (preserves the existing "finish them in any order" copy).

### Routes (all under `/get-started`, already gate-allowlisted by prefix)

| Route | Renders (reused component) | Data / action (reused) | On success |
|---|---|---|---|
| `/get-started/profile` | `MyInfoForm` | `getMyInfo`, `updateMyInfo` | `redirect("/get-started")` |
| `/get-started/hipaa` | `HipaaPanel` | `listMyCertificates`, `saveCertificate`, `setCertificateCompletionDate`, `parseCertificateUpload`, `complianceStatus` | `redirect("/get-started")` |
| `/get-started/training` | `TrainingQuiz` + slim status header | `getMyTraining`, `submitQuizAction` | `redirect("/get-started")` |
| `/get-started/learning` | assigned-course list | `getMyCourses` | each course launches `/learning/[courseId]` (full-screen player), which returns to `/get-started/learning` |

The learning **list** lives in onboarding chrome; the SCORM **player** stays its existing
full-screen page (it is an immersive iframe sub-app). The player returns to
`/get-started/learning` (see Learning return, below).

## Components

### `OnboardingStepShell` — `src/app/get-started/onboarding-step-shell.tsx`

A presentational wrapper (props in, markup out) used by every sub-route page. Provides
the shared onboarding chrome:

- Calm canvas (`bg-canvas`), centered max-width column, no `AppShell`/module nav.
- Top bar: the HAVEN mark, a **"Back to checklist"** link (`/get-started`), and a slim
  "**N of M** complete" progress chip computed from `getOnboardingStatus`.
- A step title + short description slot.
- Children = the task's reused completion component.

This is the single piece of new chrome. It keeps each sub-route page thin.

### Sub-route pages (4 new, thin)

Each is a server component that:
1. `requirePersonSession()` (so the gate + allowlist still apply).
2. Loads `getOnboardingStatus(personId)` for the progress chip, and redirects to `/`
   if the person is exempt / no active term / already onboarded (never a dead end —
   same guard the checklist page uses).
3. If **this task** is already satisfied, still render it (the underlying component
   shows its own completed state) — do not hard-block re-visiting.
4. Defines the inline `"use server"` action(s) that wrap the reused service calls and
   `redirect("/get-started")` on success (mirroring the existing `/my-info` and
   `/training` page wiring), then renders `OnboardingStepShell` around the reused
   component.

Error/success messaging follows the existing pages' `searchParams` convention
(`?error=`, `?certError=`, quiz `?passed=` etc.), surfaced within the shell.

### Checklist CTA targets — `src/modules/onboarding/services/onboarding.ts`

The `COPY` map's `href`s change from `/my-info`,`/training`,`/learning` to
`/get-started/profile`, `/get-started/hipaa`, `/get-started/training`,
`/get-started/learning`. Nothing else in the aggregator changes.

## Gate allowlist tightening — `src/platform/auth/onboarding-allowlist.ts`

Completion now lives entirely under `/get-started/*`, so a gated volunteer no longer
needs the full `/my-info` or `/training` pages. New allowlist:

```
["/get-started", "/learning", "/login", "/welcome"]
```

- `/get-started` (prefix) covers the checklist **and** all four sub-routes.
- `/learning` (prefix) stays for the SCORM player (`/learning/[courseId]`,
  `/learning/play/*`) launched full-screen from the onboarding learning list.
- `/my-info` and `/training` are **removed** — a not-yet-cleared volunteer can only
  complete via the onboarding flow, never the live pages. (The reused service actions
  are invoked as inline `"use server"` actions that POST to the `/get-started/*` page
  they live on — which is allowlisted — not to `/my-info` or `/training`, so dropping
  those routes does not break completion.)

The allowlist test updates accordingly: assert `/get-started/profile` etc. are
allowlisted, `/my-info` and `/training` are **not**, `/learning/abc` is.

## Learning return

The onboarding learning list links each course to the existing player at
`/learning/[courseId]`. To return the volunteer to onboarding (not the live `/learning`
hub page) after a course, the player's "back"/breadcrumb target is set to
`/get-started/learning` when arrived at from onboarding. Mechanism: pass a `?from=onboarding`
query param on the launch link; the player page reads it and points its back link at
`/get-started/learning` (default stays `/learning`). This is the only change to an
existing learning file and is additive (no behavior change without the param).

## Data flow

```
/get-started checklist  (CTA: /get-started/<task>)
  -> /get-started/<task> page
       requirePersonSession()            [gate + allowlist still apply]
       getOnboardingStatus()             [progress chip; redirect "/" if done/exempt/no-term]
       render OnboardingStepShell > reused task component
       user completes -> inline "use server" action -> reused service call
         -> redirect("/get-started")     [checklist now shows the task done]
  learning: list -> /learning/[courseId]?from=onboarding (full-screen player)
         -> player back -> /get-started/learning
```

## Error handling

- Reuse each component's existing validation + `searchParams`-based error surfacing
  (e.g. `CertificateValidationError` -> `?certError=`, quiz failure -> `?passed=0`).
- Sub-route pages render those messages inside `OnboardingStepShell`.
- The redirect-to-`/` guard prevents dead ends (visiting a sub-route when already
  cleared/exempt/no-term bounces to the hub).

## Testing

- Update `onboarding-allowlist.test.ts`: `/get-started/profile`/`/get-started/learning`
  allowlisted; `/my-info` and `/training` **not** allowlisted; `/learning/abc` allowlisted.
- The sub-route pages are thin wrappers over already-tested services/components; verify
  via typecheck + build + manual smoke (consistent with how the existing pages are
  covered). No new pure logic is introduced beyond the allowlist change.

## Out of scope

- Rebuilding or restyling the reused task components (`MyInfoForm`, `HipaaPanel`,
  `TrainingQuiz`, course list) — they are reused as-is.
- Embedding the SCORM player itself in onboarding chrome (it stays full-screen).
- Any change to the underlying services or the gate logic in `requirePersonSession`.
- The `/get-started` checklist screen itself (only its CTA targets change).

## Files

**New**
- `src/app/get-started/onboarding-step-shell.tsx` (shared chrome)
- `src/app/get-started/profile/page.tsx`
- `src/app/get-started/hipaa/page.tsx`
- `src/app/get-started/training/page.tsx`
- `src/app/get-started/learning/page.tsx`

**Modified**
- `src/modules/onboarding/services/onboarding.ts` (COPY hrefs → `/get-started/*`)
- `src/platform/auth/onboarding-allowlist.ts` (+ `.test.ts`) (drop `/my-info`,`/training`)
- `src/app/learning/[courseId]/page.tsx` (optional `?from=onboarding` back target)
