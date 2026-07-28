# Learning Modules Inside the Locked Onboarding Flow: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a not-yet-cleared member entirely inside the locked `/get-started` onboarding flow when they do their assigned learning courses, instead of handing them off into the full hub with a live-looking nav bar that ejects them on every click.

**Architecture:** The SCORM course player moves to a new `/get-started/learning/[courseId]` route that renders the existing `ScormPlayer` client component inside `OnboardingStepShell` (the same chrome the profile, HIPAA, and training steps already use). `/learning` then comes off the onboarding allowlist, so an uncleared member can no longer reach any route in the `(app)` group and `AppShell` never renders for them. The course list stays reachable after the learning step completes, so someone still blocked on another step can reopen a finished course.

**Tech Stack:** Next.js 16.2.11 App Router (Server Components, `redirect()` from `requirePersonSession`), React 19, Prisma, Tailwind, Vitest (`renderToStaticMarkup` for component tests, local Postgres for service tests), Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-07-28-onboarding-learning-lock-design.md`

## Global Constraints

- **No em-dash characters (U+2014) anywhere in `src/**`.** CI-enforced by the `local/no-em-dash` eslint rule. Use a comma, a colon, or a full stop.
- **No styled raw `button`/`input`/`select`/`textarea` with a `className`** in `src/app/**` or `src/modules/**`. Use the primitives in `@/platform/ui`. A genuinely required raw element needs an `eslint-disable-next-line no-restricted-syntax` with a one-line reason.
- **`src/platform/**` must not import `src/modules/**`.** Enforced twice in `eslint.config.mjs`. No task here needs a new exception.
- **Copy style:** HAVEN voice, sentence case, no em-dashes.
- **`href` and `ctaLabel` on onboarding steps are app routing and are NOT term-configurable.** The new `reviewable` flag follows the same rule: it lives only in `STEP_DEFAULTS` and is never read off a `TermOnboardingStep` override row.
- **Lint with `npx eslint src e2e`,** not `npm run lint`. The repo has an untracked, gitignored `HAVEN Free Clinic Design System` directory that `npm run lint` walks and floods with noise.

## Setup (once, before Task 1)

This worktree has no `node_modules` and no test database yet.

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub/.claude/worktrees/onboarding-learning-lock
npm install
```

Create a dedicated test database for this worktree. Do NOT reuse `havenhub_test` (other worktrees share it and deadlock) and never point tests at Neon. The `haven` role cannot `CREATE DATABASE` on :5434; the `jcarney` role there is a superuser:

```bash
psql "postgresql://jcarney@localhost:5434/postgres" -c "CREATE DATABASE havenhub_test_onblearn OWNER haven"
export TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_onblearn"
DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL_UNPOOLED="$TEST_DATABASE_URL" npx prisma migrate deploy
```

Keep `TEST_DATABASE_URL` exported in every shell that runs vitest. If the suite hangs with zero output, Postgres on :5434 is not running (`npm run db:up`). If vitest reports a column that does not exist, that is a stale shared Prisma client, not a schema problem: do NOT run `prisma generate`.

The Playwright e2e suite cannot be run locally (it needs the CI database). Task 6 is written to be verified in CI.

---

### Task 1: `OnboardingStepShell` gains back-link and width props

The shell currently hardcodes a "Back to checklist" link to `/get-started` and a `max-w-3xl` container. The course player needs to return to the course list instead, and needs the same `max-w-6xl` width the SCORM iframe gets inside `AppShell` today (`src/platform/ui/app-shell.tsx:143`), or the player will render noticeably narrower than it does now.

**Files:**
- Modify: `src/app/get-started/onboarding-step-shell.tsx`
- Test: `src/app/get-started/onboarding-step-shell.test.tsx` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `OnboardingStepShell` accepting three new optional props, consumed by Task 2:
  ```ts
  backHref?: string   // default "/get-started"
  backLabel?: string  // default "Back to checklist"
  wide?: boolean      // default false; true swaps max-w-3xl for max-w-6xl
  ```

- [ ] **Step 1: Write the failing test**

Create `src/app/get-started/onboarding-step-shell.test.tsx`. `next/link` is mocked to a plain anchor so the test does not depend on an app-router context:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { OnboardingStepShell } = await import("./onboarding-step-shell");

describe("OnboardingStepShell", () => {
  it("defaults the back link to the checklist", () => {
    const out = renderToStaticMarkup(
      <OnboardingStepShell title="HIPAA certificate" completedCount={1} totalCount={4}>
        <p>body</p>
      </OnboardingStepShell>
    );
    expect(out).toContain('href="/get-started"');
    expect(out).toContain("Back to checklist");
  });

  it("uses the supplied back link and label", () => {
    const out = renderToStaticMarkup(
      <OnboardingStepShell
        title="Bloodborne Pathogens"
        completedCount={2}
        totalCount={4}
        backHref="/get-started/learning"
        backLabel="Back to courses"
      >
        <p>body</p>
      </OnboardingStepShell>
    );
    expect(out).toContain('href="/get-started/learning"');
    expect(out).toContain("Back to courses");
    expect(out).not.toContain("Back to checklist");
  });

  it("keeps the narrow container by default and widens when asked", () => {
    const narrow = renderToStaticMarkup(
      <OnboardingStepShell title="Profile" completedCount={0} totalCount={4}>
        <p>body</p>
      </OnboardingStepShell>
    );
    expect(narrow).toContain("max-w-3xl");
    expect(narrow).not.toContain("max-w-6xl");

    const wide = renderToStaticMarkup(
      <OnboardingStepShell title="Course" completedCount={0} totalCount={4} wide>
        <p>body</p>
      </OnboardingStepShell>
    );
    expect(wide).toContain("max-w-6xl");
    expect(wide).not.toContain("max-w-3xl");
  });

  it("renders the progress chip and the title", () => {
    const out = renderToStaticMarkup(
      <OnboardingStepShell title="Learning modules" completedCount={2} totalCount={5}>
        <p>body</p>
      </OnboardingStepShell>
    );
    expect(out).toContain("2 of 5 complete");
    expect(out).toContain("Learning modules");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/get-started/onboarding-step-shell.test.tsx`
Expected: FAIL. The two default-behavior tests pass, but "uses the supplied back link and label" and the `wide` half of the container test fail, because `OnboardingStepShell` does not accept `backHref`, `backLabel`, or `wide` yet (TypeScript also errors on the unknown props).

- [ ] **Step 3: Implement the props**

Replace the component signature and the two container `div`s in `src/app/get-started/onboarding-step-shell.tsx`. The whole file after the edit:

```tsx
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { HavenMark } from "@/platform/ui/haven-mark";

/**
 * Shared chrome for the onboarding task sub-routes: a slim sticky top bar with a
 * back link, an "N of M complete" progress chip, and the HAVEN mark, over the
 * calm canvas. No AppShell / module nav -- that is what keeps a not-yet-cleared
 * volunteer inside the onboarding flow.
 *
 * backHref/backLabel default to the checklist. The course player passes the
 * course list instead, so a member steps back one level rather than jumping
 * past it. `wide` swaps the reading-width container for the same max-w-6xl the
 * app shell gives a page, so the SCORM iframe is not narrower here than it is
 * for a cleared member.
 */
export function OnboardingStepShell({
  title,
  description,
  completedCount,
  totalCount,
  backHref = "/get-started",
  backLabel = "Back to checklist",
  wide = false,
  children,
}: {
  title: string;
  description?: string;
  completedCount: number;
  totalCount: number;
  backHref?: string;
  backLabel?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const container = wide ? "max-w-6xl" : "max-w-3xl";
  return (
    <main className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-10 border-b border-border bg-canvas/85 backdrop-blur">
        <div className={`mx-auto flex ${container} items-center justify-between gap-4 px-6 py-3.5`}>
          <Link
            href={backHref}
            className="inline-flex items-center gap-2 text-[13px] font-semibold text-foreground-soft transition-colors hover:text-foreground"
          >
            <ArrowLeft aria-hidden className="h-4 w-4" />
            {backLabel}
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-[12px] font-semibold text-muted-foreground">
              {completedCount} of {totalCount} complete
            </span>
            <HavenMark className="h-7 w-7 text-brand-fg" />
          </div>
        </div>
      </header>
      <div className={`mx-auto ${container} px-6 py-8`}>
        <h1 className="text-[22px] font-extrabold tracking-tight text-foreground">{title}</h1>
        {description && <p className="mt-1 text-[14px] leading-relaxed text-foreground-soft">{description}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/get-started/onboarding-step-shell.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/app/get-started`
Expected: clean. The three existing callers (`profile`, `hipaa`, `training`) pass none of the new props and keep their current behavior via the defaults.

- [ ] **Step 6: Commit**

```bash
git add src/app/get-started/onboarding-step-shell.tsx src/app/get-started/onboarding-step-shell.test.tsx
git commit -m "feat(onboarding): let the step shell take a back link and a wide container"
```

---

### Task 2: Course player route inside the onboarding shell

**Files:**
- Create: `src/app/get-started/learning/[courseId]/page.tsx`
- Modify: `src/app/get-started/learning/page.tsx:30` (the course card link)
- Modify: `src/app/(app)/learning/[courseId]/page.tsx` (remove the now-dead `?from=onboarding` back-link)

**Interfaces:**
- Consumes: `OnboardingStepShell` with `backHref` / `backLabel` / `wide` from Task 1.
- Produces: the route `/get-started/learning/[courseId]`, which Task 3 relies on being the only way an uncleared member reaches a course, and Task 6 drives in e2e.

Background the implementer needs:

- `ScormPlayer` is a client component at `src/app/(app)/learning/[courseId]/ScormPlayer.tsx`. Import it across route groups rather than moving it. There is direct precedent: `src/app/get-started/training/page.tsx:11` already imports `@/app/(app)/training/training-quiz`. Do not move or edit `ScormPlayer`; its SCO handoff and unload beacon are delicate.
- `ScormPlayer` loads package files from `/learning/play/<courseId>/<href>` and beacons to `/api/learning/persist-cmi`. Both are route handlers that authenticate with `auth()` directly and never call `requirePersonSession`, so neither is affected by the onboarding gate. Nothing about them changes.
- `getCourseForLearner` (`src/modules/learning/services/enrollment.ts:147`) does the real authorization: it throws `LearningAuthError` when the course is not assigned to the person.
- The `(app)` route gates on `requireModuleAccess("learning")`, which redirects to `/no-access` when the person lacks `learning.access`. This route must not do that: `/no-access` is itself gated, so the onboarding gate would bounce an uncleared member straight back to `/get-started`, and dropping the check entirely would render a player whose every save fails with a 403 (the silent-progress-loss failure mode from #18). Render an in-shell Alert instead.

- [ ] **Step 1: Create the route**

Create `src/app/get-started/learning/[courseId]/page.tsx`:

```tsx
import { notFound, redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { Alert } from "@/platform/ui/alert";
import { getCourseForLearner } from "@/modules/learning/services/enrollment";
import { LearningAuthError } from "@/modules/learning/services/errors";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { ScormPlayer } from "@/app/(app)/learning/[courseId]/ScormPlayer";
import { OnboardingStepShell } from "../../onboarding-step-shell";

/**
 * The SCORM player for a not-yet-cleared member, rendered in the locked
 * onboarding chrome instead of the app shell. A member who is still blocked
 * must never see the module nav: every tab in it bounces them back to
 * /get-started, which reads as the app breaking rather than as a gate.
 *
 * Authorization is getCourseForLearner (course must be assigned). The
 * learning.access check replaces requireModuleAccess, which would send them to
 * the gated /no-access page.
 */
export default async function OnboardingCoursePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);
  // Never a dead end: anyone who does not belong in the flow goes to the hub,
  // where the normal /learning route serves them.
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");

  const { courseId } = await params;

  const shell = {
    completedCount: status.completedCount,
    totalCount: status.totalCount,
    backHref: "/get-started/learning",
    backLabel: "Back to courses",
  };

  if (!(await can(person.personId, "learning.access"))) {
    return (
      <OnboardingStepShell title="Learning modules" {...shell}>
        <Alert tone="info">
          Your courses are not available yet. Contact your department director.
        </Alert>
      </OnboardingStepShell>
    );
  }

  let course;
  try {
    course = await getCourseForLearner(person.personId, courseId);
  } catch (err) {
    if (err instanceof LearningAuthError) notFound();
    throw err;
  }

  return (
    <OnboardingStepShell title={course.title} description={course.description ?? undefined} wide {...shell}>
      {course.scos.length > 0 ? (
        <ScormPlayer courseId={course.id} scos={course.scos} />
      ) : (
        <p className="text-sm text-muted-foreground">This course has no content uploaded yet. Check back soon.</p>
      )}
    </OnboardingStepShell>
  );
}
```

- [ ] **Step 2: Point the course list at the new route**

In `src/app/get-started/learning/page.tsx`, change the card link on line 30 from the app route to the onboarding route, and drop the `?from=onboarding` marker (nothing reads it after Step 3):

```tsx
          <Link key={c.id} href={`/get-started/learning/${c.id}`} className="block">
```

While in this file, update the step description on line 24 so it no longer promises a hand-off:

```tsx
      description="Complete the courses your department assigned to you. Each one opens here; you return to this list when you are done."
```

- [ ] **Step 3: Remove the dead onboarding back-link from the app route**

In `src/app/(app)/learning/[courseId]/page.tsx`, nothing links in with `?from=onboarding` any more, so delete the marker plumbing. The whole file after the edit:

```tsx
import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { getCourseForLearner } from "@/modules/learning/services/enrollment";
import { LearningAuthError } from "@/modules/learning/services/errors";
import { ScormPlayer } from "./ScormPlayer";

export default async function LearningCoursePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const person = await requireModuleAccess("learning");
  const { courseId } = await params;

  let course;
  try {
    course = await getCourseForLearner(person.personId, courseId);
  } catch (err) {
    if (err instanceof LearningAuthError) notFound();
    throw err;
  }

  return (
    <>
      <PageHeader title={course.title} description={course.description ?? undefined} />
      <div className="mt-6 space-y-4">
        {course.scos.length > 0 ? (
          <ScormPlayer courseId={course.id} scos={course.scos} />
        ) : (
          <p className="text-sm text-muted-foreground">This course has no content uploaded yet. Check back soon.</p>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 4: Typecheck, lint, and confirm nothing still references the marker**

Run:
```bash
npx tsc --noEmit
npx eslint src e2e
grep -rn "from=onboarding" src e2e
```
Expected: tsc clean, eslint clean, and the grep returns no matches.

- [ ] **Step 5: Run the learning and onboarding unit suites**

Run: `npx vitest run src/modules/learning src/modules/onboarding`
Expected: PASS. No service behavior changed, so this is a regression check.

- [ ] **Step 6: Commit**

```bash
git add "src/app/get-started/learning/[courseId]/page.tsx" src/app/get-started/learning/page.tsx "src/app/(app)/learning/[courseId]/page.tsx"
git commit -m "feat(onboarding): play assigned courses inside the locked onboarding shell"
```

---

### Task 3: Close the learning hole in the onboarding allowlist

This is the change that actually stops an uncleared member from seeing the hub. It comes after Task 2 so the flow is never broken between commits.

**Files:**
- Modify: `src/platform/auth/onboarding-allowlist.ts`
- Test: `src/platform/auth/onboarding-allowlist.test.ts:18-21` (rewrite that block)

**Interfaces:**
- Consumes: the `/get-started/learning/[courseId]` route from Task 2, which is already covered by the existing `/get-started` prefix entry.
- Produces: `ONBOARDING_ALLOWLIST === ["/get-started", "/login", "/welcome"]`.

- [ ] **Step 1: Flip the failing assertions**

In `src/platform/auth/onboarding-allowlist.test.ts`, change the roots loop on line 6 to drop `/learning`:

```ts
    for (const p of ["/get-started", "/login", "/welcome"]) {
```

Then replace the whole `"matches the SCORM player under /learning"` block (lines 18-21) with:

```ts
  it("no longer allowlists the learning module: the course player moved into /get-started", () => {
    expect(isAllowlistedPath("/learning")).toBe(false);
    expect(isAllowlistedPath("/learning/abc")).toBe(false);
    expect(isAllowlistedPath("/learning/play/123/index.html")).toBe(false);
  });

  it("allowlists the onboarding course player", () => {
    expect(isAllowlistedPath("/get-started/learning")).toBe(true);
    expect(isAllowlistedPath("/get-started/learning/abc")).toBe(true);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/auth/onboarding-allowlist.test.ts`
Expected: FAIL. Both new expectations of `false` return `true`, because `/learning` is still allowlisted.

- [ ] **Step 3: Remove `/learning` from the allowlist**

The whole of `src/platform/auth/onboarding-allowlist.ts` after the edit:

```ts
/**
 * Paths a not-yet-cleared volunteer may reach: the onboarding flow
 * (`/get-started` and its sub-routes) and the auth escape hatches.
 * Prefix-matched, so sub-paths (e.g. /get-started/learning/abc) are covered.
 *
 * `/learning` is deliberately NOT here. It lives in the (app) route group, so
 * admitting an uncleared member to it rendered the whole AppShell toolbar and
 * module nav around the course player: every tab looked live, and clicking one
 * re-ran the gate and ejected them back to /get-started. The onboarding course
 * player is `/get-started/learning/[courseId]` instead, covered by the prefix
 * above. The SCORM content route and the persist-cmi beacon authenticate with
 * auth() directly, never requirePersonSession, so they are unaffected by this
 * list.
 *
 * Pure (no Next or DB imports) so it stays unit-testable and cheap to evaluate
 * on every page render.
 */
export const ONBOARDING_ALLOWLIST = ["/get-started", "/login", "/welcome"];

/** True when `path` is the gate, a task fix-it page, or an auth route. */
export function isAllowlistedPath(path: string): boolean {
  return ONBOARDING_ALLOWLIST.some((p) => path === p || path.startsWith(`${p}/`));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/auth/onboarding-allowlist.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full platform auth suite**

Run: `npx vitest run src/platform/auth`
Expected: PASS. `onboarding-gate-cache.test.ts` and the match-person / safe-next suites are untouched but confirm nothing else keyed off the allowlist contents.

- [ ] **Step 6: Commit**

```bash
git add src/platform/auth/onboarding-allowlist.ts src/platform/auth/onboarding-allowlist.test.ts
git commit -m "fix(onboarding): stop admitting uncleared members to the learning module"
```

---

### Task 4: A `reviewable` flag on the learning step

Plumbing only. Task 5 renders it. Kept separate because this half is service and config code with a database test, and the other half is UI.

**Files:**
- Modify: `src/modules/onboarding/services/step-config.ts` (`StepDefault`, `STEP_DEFAULTS.learning`, `EffectiveStep`, `effective()`)
- Modify: `src/modules/onboarding/services/onboarding.ts` (`OnboardingTask`, `buildTask`)
- Test: `src/modules/onboarding/services/step-config.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: an optional `reviewable?: boolean` on `StepDefault`, `EffectiveStep`, and `OnboardingTask`. `true` only for `learning`; `undefined` for every other kind. Task 5 reads `task.reviewable` off `OnboardingTask`.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/onboarding/services/step-config.test.ts`, inside the existing top-level `describe` (or as a new one at the end of the file):

```ts
describe("reviewable", () => {
  it("marks only the learning step reviewable", async () => {
    const term = await activeTerm();
    const steps = await loadEffectiveSteps(term.id);
    expect(steps.get("learning")?.reviewable).toBe(true);
    for (const kind of ["profile", "hipaa", "training", "directorTraining", "ehs"] as const) {
      expect(steps.get(kind)?.reviewable).toBeUndefined();
    }
  });

  it("keeps reviewable when a term overrides the step, since it is app routing not config", async () => {
    const term = await activeTerm();
    const admin = await prisma.person.create({
      data: { name: "Term Admin", contactEmail: "term-admin-reviewable@x.edu", status: "ACTIVE" },
    });
    await grant(admin.id, "admin.manage_terms");
    await setStepConfig(admin.id, term.id, "learning", { label: "Assigned trainings", order: 1 });

    const steps = await loadEffectiveSteps(term.id);
    expect(steps.get("learning")?.label).toBe("Assigned trainings");
    expect(steps.get("learning")?.reviewable).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/onboarding/services/step-config.test.ts`
Expected: FAIL on `expect(steps.get("learning")?.reviewable).toBe(true)`, received `undefined`. TypeScript also errors: `reviewable` is not on `EffectiveStep`.

- [ ] **Step 3: Add the flag to the step config**

In `src/modules/onboarding/services/step-config.ts`:

Add the field to `StepDefault` (after `ctaLabel`):

```ts
export type StepDefault = {
  label: string;
  description: string;
  order: number;
  blocking: boolean;
  href?: string;
  ctaLabel?: string;
  /** The step's page stays useful after completion, so the checklist offers a
   *  "Review" link once it is done. Only learning: the profile and HIPAA pages
   *  redirect away when their step is complete, so a link there would dead-end. */
  reviewable?: boolean;
};
```

Update the doc comment above `STEP_DEFAULTS` so the not-configurable rule covers the new field:

```ts
/** Built-in defaults for each onboarding step (HAVEN voice; sentence case; no
 *  em-dashes). href/ctaLabel/reviewable are app-routing and are NOT
 *  term-configurable. */
```

Set it on the `learning` entry:

```ts
  learning: {
    label: "Learning modules",
    description: "Complete the courses your department assigned to you.",
    order: 4,
    blocking: true,
    href: "/get-started/learning",
    ctaLabel: "Open courses",
    reviewable: true,
  },
```

Add the field to `EffectiveStep` (after `ctaLabel`):

```ts
  ctaLabel?: string;
  reviewable?: boolean;
```

And carry it through `effective()`, next to the other default-only fields:

```ts
    href: d.href,
    ctaLabel: d.ctaLabel,
    reviewable: d.reviewable,
```

- [ ] **Step 4: Carry the flag onto the task**

In `src/modules/onboarding/services/onboarding.ts`, add it to `OnboardingTask` (after `ctaLabel`):

```ts
  href?: string;
  ctaLabel?: string;
  /** The checklist offers a "Review" link for a COMPLETE task with this set. */
  reviewable?: boolean;
```

And to the object `buildTask` returns, alongside the other step-sourced fields:

```ts
        href: s.href,
        ctaLabel: s.ctaLabel,
        reviewable: s.reviewable,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/modules/onboarding`
Expected: PASS, including the two new tests and the existing `step-config`, `onboarding`, and `clearance` suites.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/modules/onboarding/services/step-config.ts src/modules/onboarding/services/step-config.test.ts src/modules/onboarding/services/onboarding.ts
git commit -m "feat(onboarding): mark the learning step reviewable after completion"
```

---

### Task 5: Keep the course list reachable after the learning step completes

Today `/get-started/learning` redirects to the checklist the instant the learning task is `COMPLETE`, and the checklist renders a bare checkmark with no link for a completed task. Together that means a member who finished every course but is still blocked on HIPAA cannot reopen a course at all: `/learning` is gated (Task 3) and `/get-started/learning` bounces.

**Files:**
- Modify: `src/app/get-started/learning/page.tsx:17` (the redirect condition)
- Modify: `src/app/get-started/onboarding-checklist.tsx` (`TaskRow`)
- Test: `src/app/get-started/onboarding-checklist.test.tsx` (create)

**Interfaces:**
- Consumes: `OnboardingTask.reviewable` from Task 4.
- Produces: no new exports. `/get-started/learning` renders for `INCOMPLETE`, `IN_PROGRESS`, and `COMPLETE`, and redirects only when the task is absent or `NOT_REQUIRED`.

- [ ] **Step 1: Write the failing test**

Create `src/app/get-started/onboarding-checklist.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { OnboardingTask } from "@/modules/onboarding/services/onboarding";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { OnboardingChecklist } = await import("./onboarding-checklist");

const learning = (over: Partial<OnboardingTask> = {}): OnboardingTask => ({
  key: "learning",
  label: "Learning modules",
  description: "Complete the courses your department assigned to you.",
  href: "/get-started/learning",
  ctaLabel: "Open courses",
  reviewable: true,
  state: "COMPLETE",
  blocking: true,
  ...over,
});

describe("OnboardingChecklist", () => {
  it("offers a Review link for a completed reviewable task", () => {
    const out = renderToStaticMarkup(<OnboardingChecklist tasks={[learning()]} />);
    expect(out).toContain('href="/get-started/learning"');
    expect(out).toContain("Review");
  });

  it("does not offer Review for a completed task that is not reviewable", () => {
    const out = renderToStaticMarkup(
      <OnboardingChecklist
        tasks={[
          learning({
            key: "hipaa",
            label: "HIPAA certificate",
            href: "/get-started/hipaa",
            ctaLabel: "Upload certificate",
            reviewable: undefined,
          }),
        ]}
      />
    );
    expect(out).not.toContain("Review");
    expect(out).not.toContain('href="/get-started/hipaa"');
  });

  it("does not offer Review for a NOT_REQUIRED task, whose page redirects away", () => {
    const out = renderToStaticMarkup(
      <OnboardingChecklist tasks={[learning({ state: "NOT_REQUIRED" })]} />
    );
    expect(out).toContain("Not required");
    expect(out).not.toContain("Review");
  });

  it("still shows the primary CTA while the task is incomplete", () => {
    const out = renderToStaticMarkup(
      <OnboardingChecklist tasks={[learning({ state: "INCOMPLETE" })]} />
    );
    expect(out).toContain("Open courses");
    expect(out).not.toContain("Review");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/get-started/onboarding-checklist.test.tsx`
Expected: FAIL on the first test. A `COMPLETE` task currently renders only the check glyph, so neither the href nor "Review" appears.

- [ ] **Step 3: Render the Review link**

In `src/app/get-started/onboarding-checklist.tsx`, inside `TaskRow`, replace the trailing ternary. The current shape is:

```tsx
      {done ? (
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-success text-white">
          <Check aria-hidden className="h-4 w-4" strokeWidth={3} />
        </span>
      ) : task.href ? (
```

Change the `done` branch to pair the check glyph with a Review link when the step stays useful. Note the condition is `task.state === "COMPLETE"`, not `done`: `done` also covers `NOT_REQUIRED`, whose page redirects away and would dead-end:

```tsx
      {done ? (
        <div className="flex shrink-0 items-center gap-2">
          {task.state === "COMPLETE" && task.reviewable && task.href ? (
            <Link href={task.href} className={buttonClasses("outline", "sm")}>
              Review
            </Link>
          ) : null}
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-success text-white">
            <Check aria-hidden className="h-4 w-4" strokeWidth={3} />
          </span>
        </div>
      ) : task.href ? (
```

- [ ] **Step 4: Stop the course list redirecting when the step is complete**

In `src/app/get-started/learning/page.tsx`, replace the task guard on line 17:

```tsx
  const task = status.tasks.find((t) => t.key === "learning");
  if (!task || task.state === "COMPLETE" || task.state === "NOT_REQUIRED") redirect("/get-started");
```

with a guard that only turns away a member with nothing to show. A COMPLETE step still lists the courses, so someone blocked on another step can reopen one:

```tsx
  // A COMPLETE learning step still renders: the member may be blocked on another
  // step and want to reopen a finished course, and /learning is no longer
  // reachable to them. Only an absent or not-applicable step has nothing to show.
  const task = status.tasks.find((t) => t.key === "learning");
  if (!task || task.state === "NOT_REQUIRED") redirect("/get-started");
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/app/get-started`
Expected: PASS, both the new checklist tests and the Task 1 shell tests.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint src e2e
git add src/app/get-started/onboarding-checklist.tsx src/app/get-started/onboarding-checklist.test.tsx src/app/get-started/learning/page.tsx
git commit -m "feat(onboarding): let a blocked member reopen a finished course"
```

---

### Task 6: End-to-end coverage of the locked course player

**Files:**
- Modify: `e2e/fixtures.ts:167-178` (`seedUnclearedVolunteer` gains a department option and a Volunteer role grant)
- Modify: `e2e/get-started.spec.ts` (add one test)

**Interfaces:**
- Consumes: everything above.
- Produces: `seedUnclearedVolunteer(opts?: { deptCode?: string })`, still returning `{ person, cleanup }`.

Background the implementer needs:

- The full Playwright suite runs in CI against a fresh Postgres with `workers: 1`, serially. It cannot be run locally (it needs the CI database), so this task is verified by CI, not by a local run.
- `seedUnclearedVolunteer` currently hardcodes VADM, which is where the seeded `dev.volunteer` and `dev.director` also live (`prisma/seed.ts:214-215`). A VADM-scoped course would therefore transiently gate those two dev users on the learning task and could flake login-based specs. Seed this test into a department with no dev users instead. `FOOD` (Food Pharmacy) is one; see `prisma/department-catalog.ts`.
- A bare `TermMembership` grants no permissions. Since #158 the Volunteer baseline is a `RoleAssignment`, not something derived from membership kind, and the `Volunteer` system role is what carries `learning.access` (`src/platform/rbac/system-roles.ts:28-30`). Without that assignment the new page renders its "not available yet" Alert instead of the player. `RoleAssignment.person` cascades on delete, so `cleanupPerson` needs no change.
- The stable selectors for the app chrome are `nav[aria-label="Modules"]` (`src/platform/ui/global-nav.tsx:166`) and `a[aria-label="Go to hub home"]` (`src/platform/ui/app-shell.tsx:85`). Asserting both are absent is the assertion that this whole plan exists for.

- [ ] **Step 1: Extend the uncleared-volunteer fixture**

Replace `seedUnclearedVolunteer` in `e2e/fixtures.ts`:

```ts
/**
 * An ACTIVE Person with a term membership but no phone and no HIPAA cert, so
 * the onboarding gate holds them at /get-started.
 *
 * deptCode defaults to VADM. Pass a department with no seeded dev users (e.g.
 * FOOD) when the test also seeds a course there: a department-scoped course is
 * assigned to every member of that department, and VADM is where dev.volunteer
 * and dev.director live, so a VADM course would transiently gate them too.
 *
 * The Volunteer system role is assigned explicitly. Since #158 nothing derives
 * a baseline role from the membership kind, and Volunteer is what carries
 * learning.access, without which the course player cannot be opened.
 */
export async function seedUnclearedVolunteer(opts: { deptCode?: string } = {}) {
  const t = tag();
  const term = await activeTerm();
  const department = await dept(opts.deptCode ?? "VADM");
  const person = await prisma.person.create({
    data: { name: `E2E Uncleared ${t}`, contactEmail: `uncleared-${t}@yale.edu` },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: department.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  const volunteerRole = await prisma.role.findFirstOrThrow({ where: { name: "Volunteer" } });
  // Cascades with the person, so cleanupPerson needs no change.
  await prisma.roleAssignment.create({
    data: { roleId: volunteerRole.id, personId: person.id, termId: term.id },
  });
  return { person, cleanup: () => cleanupPerson(person.id) };
}
```

- [ ] **Step 2: Write the failing e2e test**

Append to `e2e/get-started.spec.ts`:

```ts
/**
 * The learning step must stay inside the locked onboarding flow. Before this
 * was fixed, /learning was on the onboarding allowlist, so the course player
 * rendered inside the full AppShell: an uncleared member saw every module tab,
 * and clicking one re-ran the gate and ejected them back to /get-started.
 */
test("get-started gate: the course player renders with no app nav, and /learning is closed", async ({ page }) => {
  // FOOD, not VADM: a department-scoped course is assigned to every member of
  // that department, and VADM is where the seeded dev users live.
  const v = await seedUnclearedVolunteer({ deptCode: "FOOD" });
  const c = await seedCourseWithPackage({ deptCode: "FOOD" });
  try {
    await page.goto("/login");
    await page.fill('input[name="email"]', v.person.contactEmail ?? "");
    await page.click('button:has-text("Dev sign in")');
    await page.waitForURL((url) => url.pathname.startsWith("/get-started"), { timeout: 15_000 });

    // Checklist to the course list to the course.
    await page.goto("/get-started/learning");
    await page.locator("a").filter({ hasText: c.course.title }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/get-started/learning/"), { timeout: 10_000 });

    // The player is there.
    await expect(page.locator('iframe[title="Course content"]')).toBeVisible();
    // And none of the app chrome is.
    await expect(page.locator('nav[aria-label="Modules"]')).toHaveCount(0);
    await expect(page.locator('a[aria-label="Go to hub home"]')).toHaveCount(0);
    // The locked shell's own way back.
    await expect(page.getByRole("link", { name: "Back to courses" })).toBeVisible();

    // The old app route is now gated like every other hub page.
    await page.goto(`/learning/${c.course.id}`);
    await page.waitForURL((url) => url.pathname.startsWith("/get-started"), { timeout: 10_000 });
  } finally {
    await c?.cleanup();
    await v?.cleanup();
  }
});
```

Update the import at the top of the file:

```ts
import { seedCourseWithPackage, seedUnclearedVolunteer } from "./fixtures";
```

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src e2e`
Expected: clean. Do not try to run Playwright locally; it needs the CI database.

- [ ] **Step 4: Commit**

```bash
git add e2e/fixtures.ts e2e/get-started.spec.ts
git commit -m "test(e2e): cover the locked onboarding course player"
```

- [ ] **Step 5: Full local verification**

Run:
```bash
npx tsc --noEmit
npx eslint src e2e
npx vitest run
```
Expected: tsc clean, eslint clean, vitest green. If vitest shows scattered unrelated failures, check for zombie processes first (`ps aux | grep vitest`, then `pkill -f vitest`) and re-run; a shared test database with stray workers produces unique-constraint failures that look like regressions.

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin worktree-onboarding-learning-lock
```

The PR body should state that CI is the only place the new e2e test runs, and link the spec. Watch the e2e job specifically: it is the only coverage for the assertion that the app nav is absent.

---

## Manual verification (after CI is green)

Against a local dev server with a seeded uncleared volunteer who has an assigned course:

1. Sign in. You land on `/get-started`, not the hub.
2. Open the learning tile. The course list shows in the locked shell.
3. Open a course. The player renders full width, the top bar reads "Back to courses", and there is no module nav anywhere on the page.
4. Type `/learning` and `/schedule` into the address bar. Both land on `/get-started`.
5. Finish the course. The checklist tile flips to Done and gains a "Review" link that reopens the list.
6. Sign in as a cleared member. `/learning` and `/learning/<courseId>` behave exactly as before, inside the app shell.
