# Onboarding gate ("Get started") — design

**Date:** 2026-06-11
**Branch:** `worktree-feat+onboarding-gate` (off `origin/main`)
**Status:** Approved design, pending implementation plan

## Problem

A volunteer who is signed in but not yet cleared for the active term can currently
roam the hub freely, even though they cannot be scheduled until they finish a fixed
set of requirements. New volunteers and returning-but-lapsed volunteers should be
guided through those requirements before they can use the rest of the hub.

We want a **blocking, full-screen "Get started" gate** that lists the outstanding
onboarding tasks, deep-links to where each is completed, and lifts itself the moment
the volunteer is fully cleared.

## Audience and exemption

The gate applies to a signed-in, matched, ACTIVE `Person` when **all** of these hold:

1. They do **not** hold the `admin.access` permission. This is the closest existing
   proxy for "IT / super-admin" in the RBAC (it gates the admin panel: Roles, Sync,
   Settings). Directors and leads who only hold module permissions such as
   `recruitment.access` or `volunteers.view` are still gated.
2. There **is an active term** (`Term.status === "ACTIVE"`). With no active term there
   is nothing to be cleared *for*, so the gate is dormant and nobody is blocked.
3. Their onboarding is **incomplete** (at least one required task is unmet).

If any condition fails, the person is not gated.

> Note: `admin.access` is used as the exemption signal because no dedicated "IT" role
> exists today. If a finer-grained IT permission is introduced later, swap the single
> `EXEMPT_PERMISSION` constant.

## The four tasks

Each task reuses an existing service as its source of truth, and — critically — each
must be **completable from inside the hub**. A hard gate must never trap a person
behind a task that has no in-app completion path.

| Task key   | Label                | "Done" rule                                                                 | Fix-it link |
|------------|----------------------|------------------------------------------------------------------------------|-------------|
| `profile`  | Profile & agreements | Required profile fields present on the `Person` (see below)                  | `/my-info`  |
| `hipaa`    | HIPAA certificate    | `complianceStatus(cert, termEnd)` ∈ {`COMPLIANT`, `EXPIRING_SOON`}           | `/my-info`  |
| `training` | Volunteer training   | `getMyTraining(personId).state === "COMPLETE"`                               | `/training` |
| `learning` | Learning modules     | every course from `getMyCourses(personId)` is `COMPLETE`; none assigned ⇒ done | `/learning` |

### Task states

Each task resolves to one of: `COMPLETE`, `IN_PROGRESS`, `INCOMPLETE`, `NOT_REQUIRED`.

- `hipaa`: `COMPLETE` when compliant/expiring-soon; otherwise `INCOMPLETE`
  (`EXPIRED`, `UNKNOWN_DATE`, `NO_CERTIFICATE` all read as "Action needed").
- `training`: `COMPLETE` when state is `COMPLETE`; `IN_PROGRESS` when an attempt
  exists but not passed (drives "Resume training" copy); else `INCOMPLETE`.
- `learning`: `COMPLETE` when all assigned courses are complete or none are assigned
  (`NOT_REQUIRED` is folded into `COMPLETE` for gating); `IN_PROGRESS` when at least
  one course is started but not all complete; else `INCOMPLETE`.
- `profile`: `COMPLETE` when required fields are present; else `INCOMPLETE`.

A task counts as **satisfied** for gating when its state is `COMPLETE` or
`NOT_REQUIRED`. The person is **onboarded** when every task is satisfied.

### Design decisions (resolved)

1. **"Profile & agreements" gates on profile fields, not signatures.** The signed
   acknowledgements (volunteer agreement, professionalism policy) are collected in the
   pre-account invite form at `/onboard/[token]`, which has **no in-hub equivalent**.
   Gating on signatures would trap any person created via admin/sync without a
   contract. So the `profile` task gates on profile-completeness fields editable in
   `/my-info`, and signatures are treated as already handled upstream. The task is
   still labeled "Profile & agreements" for the volunteer.

   **Required profile fields** (the exact set is finalized in the plan against the
   `Person` model, but the intent is core contact identity): name, contact email,
   phone, and any field `/my-info` exposes as required. If `/my-info` has no notion of
   "required profile fields," the `profile` task resolves `NOT_REQUIRED` rather than
   blocking — never gate on a field with no in-hub editor.

2. **No active term ⇒ gate dormant** (see Audience above).

3. **Term-scoped tasks use the single active term.** HIPAA's term bar, training, and
   learning all resolve against `Term.status === "ACTIVE"`, consistent with the
   existing services.

## Architecture

### 1. Status service — `src/modules/onboarding/services/onboarding.ts`

```
getOnboardingStatus(personId): Promise<OnboardingStatus>
```

Aggregates the four existing services (compliance, training, learning, profile) for
the active term into a typed result:

```ts
type OnboardingTaskKey = "profile" | "hipaa" | "training" | "learning";
type OnboardingTaskState = "COMPLETE" | "IN_PROGRESS" | "INCOMPLETE" | "NOT_REQUIRED";

type OnboardingTask = {
  key: OnboardingTaskKey;
  label: string;
  description: string;   // HAVEN-voice, concrete
  href: string;          // fix-it link
  state: OnboardingTaskState;
  ctaLabel: string;      // "Upload certificate" / "Resume training" / ...
};

type OnboardingStatus = {
  hasActiveTerm: boolean;
  exempt: boolean;          // holds EXEMPT_PERMISSION
  tasks: OnboardingTask[];  // ordered for display
  completedCount: number;
  totalCount: number;
  onboarded: boolean;       // every task satisfied (or dormant/exempt)
};
```

The service fetches the active term once, then calls the existing services. It does
**no** presentation work beyond assembling labels/descriptions/CTAs from a static map.

### 2. Pure mapping — `src/modules/onboarding/engine/status.ts` (+ `status.test.ts`)

All branching that turns raw service outputs into `OnboardingTaskState` and the
overall `onboarded` flag lives in pure functions with no DB or Prisma imports, so they
are fully unit-testable (mirrors `src/platform/compliance/rules.ts` and
`src/modules/learning/engine/status.ts`). The service in (1) is a thin adapter that
gathers inputs and calls these pure functions.

Pure functions (illustrative):
- `deriveHipaaTaskState(complianceStatus): OnboardingTaskState`
- `deriveTrainingTaskState(myTraining): OnboardingTaskState`
- `deriveLearningTaskState(courses): OnboardingTaskState`
- `deriveProfileTaskState(profileInputs): OnboardingTaskState`
- `summarize(taskStates): { completedCount; totalCount; onboarded }`

### 3. Path exposure — `middleware.ts` (new, repo root)

A minimal middleware stamps the incoming pathname into an `x-pathname` request header
so server components can read the current path (Next.js's standard pattern). It
matches page routes only and **excludes** `/api`, `/_next`, and static assets via its
`matcher`. It does no auth and no DB work.

### 4. The guard — extend `src/platform/auth/session.ts`

`requirePersonSession()` is the single chokepoint every authenticated page already
calls. Extend it so that, after resolving the active person:

```
const path = readPathname();              // from x-pathname header
if (!isAllowlisted(path) && !(await isExempt(personId))) {
  const status = await getOnboardingStatus(personId);
  if (status.hasActiveTerm && !status.onboarded) redirect("/get-started");
}
```

- **Allowlist** (no gate, so tasks are reachable and we avoid redirect loops):
  `/get-started`, `/my-info`, `/training`, `/learning`, `/login`, `/welcome`.
  (Prefix match, so sub-paths like `/learning/[courseId]` are covered.)
- **Exempt** = `can(personId, EXEMPT_PERMISSION)` where `EXEMPT_PERMISSION = "admin.access"`.
- The extra status query runs **only** for gated, non-allowlisted page loads — exempt
  users and allowlisted pages skip it, keeping the common path cheap.
- Enforcement is a no-op when no `x-pathname` header is present (e.g. server actions
  or contexts middleware did not stamp), so POST server actions are never redirected
  mid-mutation.

To keep `requirePersonSession`'s existing callers untouched, the redirect logic is a
private helper invoked at the end of `requirePersonSession`; its return type is
unchanged.

### 5. The screen — `src/app/get-started/page.tsx`

A server component implementing **Variant B (split rail)**:

- Calls `getOnboardingStatus(personId)`. If `exempt` or `onboarded` or
  `!hasActiveTerm`, `redirect("/")` — the route is never a dead end.
- Left rail: navy hero gradient (Yale-blue → deep-navy, faint translucent glow),
  HAVEN lockup, eyebrow (`Getting started · <Term>`), warm second-person headline
  (`Let's get you cleared, <first name>`), supportive paragraph, and a progress meter
  (`<completedCount> of <totalCount>`). "Need help? Contact your recruitment director."
- Right panel: the ordered task list. Each task is a card (module-hue icon tile, title,
  status pill, concrete description, and either a CTA `Link` to `href` or a completed
  checkmark). A sign-out escape hatch ("Wrong account? Sign out") at the bottom, reusing
  the existing `signOut` server action from `/welcome`.
- Design-system fidelity per the project's cohesion rules: Hanken-only, `rounded-2xl`
  cards, `rounded-lg` controls, the `Card` primitive where it fits, Tailwind v4 tokens
  from `globals.css`, Lucide icons (no emoji), sentence case, no em-dashes.

This screen renders **outside** `AppShell` (no nav/side rail), since it is a blocking
takeover, not a hub page.

### 6. Presentation components

Keep the page lean by extracting `OnboardingChecklist` and `OnboardingTaskRow` as
small presentational components (props in, markup out — no data fetching), so the page
file stays focused and the rows are reusable/testable.

## Data flow

```
page load
  → requirePersonSession()                  [every authed page]
      → resolve ACTIVE person
      → if !allowlisted(path) && !exempt:
          getOnboardingStatus(personId)
            → active term + compliance + training + learning + profile
            → pure status mapping (engine/status.ts)
          → if active term && !onboarded → redirect /get-started
  → /get-started page
      → getOnboardingStatus(personId)
      → if exempt | onboarded | no term → redirect /
      → render split-rail checklist (Variant B)
  → volunteer clicks a task CTA → /my-info | /training | /learning  [allowlisted]
      → completes the task in that feature
  → next gated navigation recomputes; when all satisfied the guard stops redirecting
```

## Testing

- `engine/status.test.ts` (pure, no DB) covers: each task's state mapping across all
  inputs (e.g. every `ComplianceStatus`, training COMPLETE/in-progress/none, learning
  none/partial/all, profile present/absent), the `summarize` rollup, dormancy when no
  active term, and the satisfied-vs-blocking distinction.
- Service-level behavior (`getOnboardingStatus` wiring, exemption, allowlist) is
  validated through the pure functions plus a thin DB-backed test only if the existing
  suite's Postgres harness is available; otherwise the pure layer carries coverage,
  consistent with how `compliance/rules.ts` is tested.
- Guard behavior is exercised by asserting the allowlist/exempt/no-term short-circuits
  in the pure helpers; the `redirect` call itself is a thin wrapper.

## Out of scope

- Building an in-hub acknowledgement-signing step (signatures stay in `/onboard/[token]`).
- Making the task list admin-configurable.
- Any change to the four underlying features (HIPAA, training, learning, my-info).
- A dismissible/soft variant — this is a hard gate by decision.

## Files

**New**
- `src/modules/onboarding/services/onboarding.ts`
- `src/modules/onboarding/engine/status.ts`
- `src/modules/onboarding/engine/status.test.ts`
- `src/platform/auth/onboarding-allowlist.ts` (+ `.test.ts`)
- `src/app/get-started/page.tsx`
- `src/app/get-started/onboarding-checklist.tsx` (presentational)
- `src/proxy.ts`

**Modified**
- `src/platform/auth/session.ts` (add onboarding enforcement to `requirePersonSession`)

## Implementation notes (decisions made during build)

1. **Next 16 proxy, not middleware.** Next 16 renamed `middleware.ts` → `proxy.ts`
   (export `proxy`, Node runtime). It lives at `src/proxy.ts` to match the `src/app`
   layout. Verified detected as `ƒ Proxy (Middleware)` in the build.

2. **Enforcement lives in `requirePersonSession`, not a layout.** A root-layout gate is
   bypassable: Next.js does not re-render layouts on soft (client `<Link>`) navigations,
   so a gated volunteer could click the `AppShell` nav into another module page ungated.
   `requirePersonSession` is the page-level chokepoint that *does* re-run on every soft
   navigation (page Server Components always re-render; layouts do not), so the gate is
   airtight there. The proxy alternative was rejected: it would run the full status
   query on every link prefetch.

3. **One documented `platform → module` exception.** Putting the gate in
   `requirePersonSession` (platform) means importing `getOnboardingStatus` (a module
   service). This is the single sanctioned breach of the platform→module ESLint boundary,
   marked with an inline `eslint-disable` and a justifying comment. The aggregator must
   stay in the module layer because it reads data owned by my-info/recruitment/learning.

4. **Allowlist extracted + unit-tested.** `ONBOARDING_ALLOWLIST` / `isAllowlistedPath`
   live in a pure `src/platform/auth/onboarding-allowlist.ts` (no Next/DB imports) with
   exact-or-prefix matching, covered by `onboarding-allowlist.test.ts` (incl. the
   `/my-information` ≠ `/my-info` sibling case).

5. **No `Card` primitive dependency.** `card.tsx` is not in `main` (it is on an unmerged
   branch), so task rows use raw Tailwind matching the home/training pages
   (`rounded-2xl border bg-white shadow-sm`).
