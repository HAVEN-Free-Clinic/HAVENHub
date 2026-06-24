# Persistent App Shell + Navigation Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tab switches fast by mounting the toolbar once in a shared `(app)` route-group layout (only the page body reloads), and cut per-navigation DB cost via request memoization and a short-TTL onboarding-gate cache.

**Architecture:** Introduce `src/app/(app)/` whose layout owns `AppShell`. Move all authenticated routes under it; URLs are unchanged because route groups are URL-transparent. Module layouts shrink to an access gate + sub-nav. Separately, wrap `getActivePerson`/`getOnboardingStatus` in React `cache()` and add a positive-only ~60s gate-cleared cache so already-onboarded users navigating the app skip ~6 DB queries per page.

**Tech Stack:** Next.js 16 App Router (Server Components), React 19 (`cache()`), Prisma 6, Vitest. Project lives under `src/app`; imports use the `@/` alias.

---

## File structure

**New files**
- `src/app/(app)/layout.tsx` — shared shell: `requirePersonSession` + active-term fetch + `AppShell`. Persists across all `(app)` navigations.
- `src/platform/auth/onboarding-gate-cache.ts` — in-memory positive-only gate-cleared cache (~60s TTL).
- `src/platform/auth/onboarding-gate-cache.test.ts` — unit test for the cache.
- `src/platform/ui/app-shell.importer.test.ts` — guard test: `AppShell` is imported by exactly one route file.

**Moved (via `git mv`, contents then edited)**
- `src/app/page.tsx` -> `src/app/(app)/page.tsx`
- `src/app/loading.tsx` -> `src/app/(app)/loading.tsx`
- `src/app/{schedule,learning,recruitment,admin,volunteers,my-info,training}/` -> `src/app/(app)/<same>/`

**Modified**
- `src/platform/auth/match-person.ts` — wrap `getActivePerson` in `cache()`.
- `src/modules/onboarding/services/onboarding.ts` — wrap `getOnboardingStatus` in `cache()`.
- `src/platform/auth/session.ts` — `enforceOnboarding` consults/sets the gate cache.
- The five moved module layouts — drop `AppShell` + term fetch; keep access gate + `ModuleNav`.
- `src/app/(app)/{page,my-info/page,training/page}.tsx` — drop the inlined `AppShell` wrapper.

**Unchanged / stays at `src/app/` root** (public or own chrome): `layout.tsx`, `globals.css`, `not-found.tsx`, `api/`, `apply/`, `get-started/`, `login/`, `onboard/`, `welcome/`. `src/platform/ui/app-shell.tsx` keeps its current internals.

---

## Task 1: Memoize per-request session lookups

**Files:**
- Modify: `src/platform/auth/match-person.ts`
- Modify: `src/modules/onboarding/services/onboarding.ts`
- Test: `src/platform/auth/match-person.test.ts` (existing — must still pass)

- [ ] **Step 1: Wrap `getActivePerson` in React `cache()`**

In `src/platform/auth/match-person.ts`, add `cache` to the imports and convert the function to a memoized const. Replace:

```ts
import type { Person } from "@prisma/client";
import { prisma } from "@/platform/db";
```
with:
```ts
import { cache } from "react";
import type { Person } from "@prisma/client";
import { prisma } from "@/platform/db";
```

Replace the whole `getActivePerson` declaration:

```ts
export async function getActivePerson(personId: string): Promise<Person | null> {
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person || person.status !== "ACTIVE") return null;
  return person;
}
```
with:
```ts
/**
 * Per-request person lookup for session validation: a person who has been
 * OFFBOARDED (or deleted) after sign-in must lose access immediately, not
 * when their JWT expires (spec §5 "revocations take effect immediately").
 * Memoized per request via React cache() so the multiple guards a single render
 * runs (shared layout + module layout + page) hit the DB once; the cache is
 * per-request, so a status change still takes effect on the next navigation.
 */
export const getActivePerson = cache(
  async (personId: string): Promise<Person | null> => {
    const person = await prisma.person.findUnique({ where: { id: personId } });
    if (!person || person.status !== "ACTIVE") return null;
    return person;
  }
);
```

(Delete the old block comment above the original function; it is reproduced above.)

- [ ] **Step 2: Wrap `getOnboardingStatus` in React `cache()`**

In `src/modules/onboarding/services/onboarding.ts`, add the import at the top:

```ts
import { cache } from "react";
```

Replace the declaration line:
```ts
export async function getOnboardingStatus(personId: string): Promise<OnboardingStatus> {
```
with:
```ts
export const getOnboardingStatus = cache(async function getOnboardingStatus(
  personId: string
): Promise<OnboardingStatus> {
```

Then change the function's closing brace at the very end of that function from:
```ts
  return { hasActiveTerm: true, exempt, tasks, completedCount, totalCount, onboarded };
}
```
to:
```ts
  return { hasActiveTerm: true, exempt, tasks, completedCount, totalCount, onboarded };
});
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the affected existing tests**

Run: `npx vitest run src/platform/auth/match-person.test.ts`
Expected: PASS (cache() is transparent to these tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/auth/match-person.ts src/modules/onboarding/services/onboarding.ts
git commit -m "perf: memoize getActivePerson and getOnboardingStatus per request"
```

---

## Task 2: Onboarding gate-cleared cache (positive-only, ~60s TTL)

A process-local cache that remembers only that a person was *cleared* by the gate. Blocking decisions are never cached, so a user who just finished onboarding is never wrongly bounced.

**Files:**
- Create: `src/platform/auth/onboarding-gate-cache.ts`
- Test: `src/platform/auth/onboarding-gate-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/platform/auth/onboarding-gate-cache.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isGateClearedCached,
  markGateCleared,
  _resetOnboardingGateCache,
} from "./onboarding-gate-cache";

afterEach(() => {
  _resetOnboardingGateCache();
  vi.useRealTimers();
});

describe("onboarding gate cache", () => {
  it("reports not-cleared for an unseen person", () => {
    expect(isGateClearedCached("p1")).toBe(false);
  });

  it("reports cleared after marking", () => {
    markGateCleared("p1");
    expect(isGateClearedCached("p1")).toBe(true);
  });

  it("scopes clearance per person", () => {
    markGateCleared("p1");
    expect(isGateClearedCached("p2")).toBe(false);
  });

  it("expires the clearance after the TTL", () => {
    vi.useFakeTimers();
    markGateCleared("p1");
    vi.advanceTimersByTime(60_001);
    expect(isGateClearedCached("p1")).toBe(false);
  });

  it("reset clears all entries", () => {
    markGateCleared("p1");
    _resetOnboardingGateCache();
    expect(isGateClearedCached("p1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/auth/onboarding-gate-cache.test.ts`
Expected: FAIL — cannot find module `./onboarding-gate-cache`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/auth/onboarding-gate-cache.ts`:

```ts
/**
 * Process-local cache of the onboarding gate's CLEARED decision. The gate
 * (enforceOnboarding) runs ~6 DB queries via getOnboardingStatus on every
 * non-allowlisted page render; for the common case of an already-onboarded
 * person navigating the app, caching the cleared result for a short window
 * removes that cost. Only POSITIVE (cleared) decisions are cached: a blocking
 * decision is always recomputed, so a person who just completed onboarding is
 * never wrongly redirected by a stale entry. Bounded staleness: a person whose
 * clearance lapses (e.g. cert expiry) may pass the gate for up to TTL_MS. The
 * separate, uncached getActivePerson() offboarding check is unaffected.
 */
const TTL_MS = 60_000;
const clearedUntil = new Map<string, number>();

/** True when this person was cleared within the TTL window. */
export function isGateClearedCached(personId: string): boolean {
  const expiresAt = clearedUntil.get(personId);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    clearedUntil.delete(personId);
    return false;
  }
  return true;
}

/** Record that the gate cleared this person; valid for TTL_MS. */
export function markGateCleared(personId: string): void {
  clearedUntil.set(personId, Date.now() + TTL_MS);
}

/** Test-only: clear the cache between cases. */
export function _resetOnboardingGateCache(): void {
  clearedUntil.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/auth/onboarding-gate-cache.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/auth/onboarding-gate-cache.ts src/platform/auth/onboarding-gate-cache.test.ts
git commit -m "perf: add positive-only onboarding gate-cleared cache"
```

---

## Task 3: Wire the gate cache into `enforceOnboarding`

**Files:**
- Modify: `src/platform/auth/session.ts:29-37`

- [ ] **Step 1: Add the import**

In `src/platform/auth/session.ts`, add after the existing `isAllowlistedPath` import:

```ts
import { isGateClearedCached, markGateCleared } from "./onboarding-gate-cache";
```

- [ ] **Step 2: Update `enforceOnboarding`**

Replace:

```ts
async function enforceOnboarding(personId: string): Promise<void> {
  const path = (await headers()).get("x-pathname");
  if (!path || isAllowlistedPath(path)) return;

  const status = await getOnboardingStatus(personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) return;

  redirect("/get-started");
}
```
with:
```ts
async function enforceOnboarding(personId: string): Promise<void> {
  const path = (await headers()).get("x-pathname");
  if (!path || isAllowlistedPath(path)) return;

  // Fast path: a recently-cleared person skips the ~6 onboarding queries.
  if (isGateClearedCached(personId)) return;

  const status = await getOnboardingStatus(personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) {
    markGateCleared(personId); // cache only the cleared decision
    return;
  }

  redirect("/get-started");
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the auth test suite**

Run: `npx vitest run src/platform/auth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/auth/session.ts
git commit -m "perf: short-circuit onboarding gate with cleared-cache"
```

---

## Task 4: Create the shared `(app)` shell layout

The directory `src/app/(app)/` has literal parentheses — always quote the path in shell commands.

**Files:**
- Create: `src/app/(app)/layout.tsx`

- [ ] **Step 1: Create the directory and shared layout**

```bash
mkdir -p "src/app/(app)"
```

Create `src/app/(app)/layout.tsx`:

```tsx
import type { ReactNode } from "react";
import { requirePersonSession } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { AppShell } from "@/platform/ui/app-shell";

/**
 * Shared shell for every authenticated route. Owns the toolbar (AppShell) so it
 * mounts once and persists across cross-module navigation: only the page body
 * (and a module's own ModuleNav) reload on a tab switch. Public routes (login,
 * apply, onboard, welcome, get-started) live outside this group and keep their
 * own chrome.
 */
export default async function AppGroupLayout({ children }: { children: ReactNode }) {
  const person = await requirePersonSession();
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  return (
    <AppShell
      userName={person.name}
      termLabel={activeTerm?.name ?? null}
      personId={person.personId}
    >
      {children}
    </AppShell>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (The layout is inert until routes move under it.)

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/layout.tsx"
git commit -m "feat: add shared (app) shell layout"
```

---

## Task 5: Migrate the five module segments

Each module moves under `(app)` and its layout drops `AppShell` + the term fetch, keeping only the access gate and `ModuleNav`. Do them one at a time so the build stays green and each is independently revertible. `git mv` of a whole directory carries its `loading.tsx` and pages with it.

> Why the body changes: `AppShell` and the active-term query now live in the shared `(app)/layout.tsx`. The thin layout returns a fragment because the shared `AppShell` already provides `<main>`.

- [ ] **Step 1: Move + rewrite `schedule`**

```bash
git mv src/app/schedule "src/app/(app)/schedule"
```

Overwrite `src/app/(app)/schedule/layout.tsx` with:

```tsx
import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function ScheduleLayout({ children }: { children: ReactNode }) {
  await requireModuleAccess("schedule");
  const mod = getModule("schedule")!;
  return (
    <>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </>
  );
}
```

- [ ] **Step 2: Move + rewrite `learning`**

```bash
git mv src/app/learning "src/app/(app)/learning"
```

Overwrite `src/app/(app)/learning/layout.tsx` with:

```tsx
import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function LearningLayout({ children }: { children: ReactNode }) {
  await requireModuleAccess("learning");
  const mod = getModule("learning")!;
  return (
    <>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </>
  );
}
```

- [ ] **Step 3: Move + rewrite `recruitment`**

```bash
git mv src/app/recruitment "src/app/(app)/recruitment"
```

Overwrite `src/app/(app)/recruitment/layout.tsx` with:

```tsx
import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function RecruitmentLayout({ children }: { children: ReactNode }) {
  await requireModuleAccess("recruitment");
  const mod = getModule("recruitment")!;
  return (
    <>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </>
  );
}
```

- [ ] **Step 4: Move + rewrite `admin`**

```bash
git mv src/app/admin "src/app/(app)/admin"
```

Overwrite `src/app/(app)/admin/layout.tsx` with:

```tsx
import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { ModuleNav } from "@/platform/ui/module-nav";

// Admin declares accessPermission: "admin.access", so requireModuleAccess
// resolves to requirePermission("admin.access").
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireModuleAccess("admin");
  const mod = getModule("admin")!;
  return (
    <>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </>
  );
}
```

- [ ] **Step 5: Move + rewrite `volunteers`**

```bash
git mv src/app/volunteers "src/app/(app)/volunteers"
```

Overwrite `src/app/(app)/volunteers/layout.tsx` with:

```tsx
import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getModule } from "@/platform/modules/registry";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function VolunteersLayout({ children }: { children: ReactNode }) {
  await requireModuleAccess("volunteers");
  const mod = getModule("volunteers")!;
  return (
    <>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: move modules under (app), drop per-module AppShell"
```

---

## Task 6: Migrate the hub page and its loading screen

**Files:**
- Move: `src/app/page.tsx` -> `src/app/(app)/page.tsx`
- Move: `src/app/loading.tsx` -> `src/app/(app)/loading.tsx`

- [ ] **Step 1: Move the files**

```bash
git mv src/app/page.tsx "src/app/(app)/page.tsx"
git mv src/app/loading.tsx "src/app/(app)/loading.tsx"
```

- [ ] **Step 2: Remove the `AppShell` import**

In `src/app/(app)/page.tsx`, delete this import line:

```ts
import { AppShell } from "@/platform/ui/app-shell";
```

- [ ] **Step 3: Replace the `AppShell` wrapper with a fragment**

Replace the opening tag:
```tsx
    <AppShell userName={person.name} termLabel={term?.name ?? null} personId={person.personId}>
```
with:
```tsx
    <>
```

Replace the closing tag (the final `</AppShell>` before the function's closing brace):
```tsx
    </AppShell>
  );
}
```
with:
```tsx
    </>
  );
}
```

(`person` and `term` are still used elsewhere in the page, so `requirePersonSession()` and the schedule/term lookups stay.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move hub page under (app), drop inlined AppShell"
```

---

## Task 7: Migrate `my-info` and `training` (inlined-shell pages)

These two have no module layout and inlined `AppShell` in the page. They get no new layout; the shared shell wraps them.

**Files:**
- Move: `src/app/my-info/` -> `src/app/(app)/my-info/`
- Move: `src/app/training/` -> `src/app/(app)/training/`

- [ ] **Step 1: Move both directories**

```bash
git mv src/app/my-info "src/app/(app)/my-info"
git mv src/app/training "src/app/(app)/training"
```

- [ ] **Step 2: Strip `AppShell` from `my-info/page.tsx`**

In `src/app/(app)/my-info/page.tsx`, delete the import:
```ts
import { AppShell } from "@/platform/ui/app-shell";
```

Replace the opening wrapper:
```tsx
    <AppShell userName={person.name} termLabel={activeTerm?.name ?? null} personId={person.personId}>
```
with:
```tsx
    <>
```

Replace the closing wrapper:
```tsx
    </AppShell>
  );
}
```
with:
```tsx
    </>
  );
}
```

- [ ] **Step 3: Strip `AppShell` from `training/page.tsx`**

In `src/app/(app)/training/page.tsx`, delete the import:
```ts
import { AppShell } from "@/platform/ui/app-shell";
```

Replace the opening wrapper:
```tsx
    <AppShell userName={person.name} termLabel={my.term.name} personId={person.personId}>
```
with:
```tsx
    <>
```

Replace the closing wrapper:
```tsx
    </AppShell>
  );
}
```
with:
```tsx
    </>
  );
}
```

(`getAccessibleModules` is still imported and used for `canSchedule` — leave it.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move my-info and training under (app), drop inlined AppShell"
```

---

## Task 8: Structural guard test — single AppShell importer

Locks in the invariant: after the migration, exactly one route file renders `AppShell`. Prevents a future page from re-inlining it and reintroducing the remount.

**Files:**
- Create: `src/platform/ui/app-shell.importer.test.ts`

- [ ] **Step 1: Write the test**

Create `src/platform/ui/app-shell.importer.test.ts`:

```ts
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("AppShell single-importer invariant", () => {
  it("is imported only by the shared (app) layout", () => {
    // List every file under src/app that imports AppShell. Expect exactly one:
    // the shared route-group layout. Any other hit means a page/layout re-inlined
    // the shell, which reintroduces the cross-module remount this work removed.
    const out = execSync(
      "grep -rl \"ui/app-shell\" src/app || true",
      { encoding: "utf8" }
    ).trim();
    const files = out ? out.split("\n").sort() : [];
    expect(files).toEqual(["src/app/(app)/layout.tsx"]);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/platform/ui/app-shell.importer.test.ts`
Expected: PASS (the only importer is `src/app/(app)/layout.tsx`).

- [ ] **Step 3: Commit**

```bash
git add src/platform/ui/app-shell.importer.test.ts
git commit -m "test: enforce single AppShell importer (persistent shell)"
```

---

## Task 9: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm no stale references to moved paths**

Run: `grep -rn "app/schedule\|app/learning\|app/recruitment\|app/admin\|app/volunteers\|app/my-info\|app/training" src --include=*.ts --include=*.tsx | grep -v "src/app/(app)/"`
Expected: no output (routes are referenced by URL like `/schedule`, never by `app/...` path). If anything prints, investigate before continuing.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 3: Production build (also captures the bundle report)**

Run: `npm run build`
Expected: build succeeds. Review the printed route/first-load-JS table. Note any single client chunk that looks oversized for follow-up; do NOT refactor speculatively here.

- [ ] **Step 4: Full unit test suite**

Run: `npx vitest run`
Expected: same pass count as the recorded baseline plus the new tests (gate cache: 5, importer: 1). The pre-existing `form-builder.test.ts` FK failure is unrelated to this work; if it is the only failure, it is acceptable.

- [ ] **Step 5: Manual smoke (dev server)**

Run: `npm run dev`, sign in, then verify:
- Navigate schedule -> learning -> recruitment -> admin: the toolbar does NOT flash/reload; only the body and sub-nav change.
- The term badge appears in every module (intended change).
- Visit `/login` and `/get-started` while signed out / not-onboarded: the authenticated toolbar is NOT shown.
- As a not-yet-onboarded user, navigating to `/schedule` redirects to `/get-started`; after completing onboarding, entering the app is NOT bounced back.

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore: verification fixups for persistent app shell" || echo "nothing to commit"
```

---

## Spec coverage check

- Persistent shell via `(app)` route group -> Tasks 4-7.
- Thin per-module layouts (gate + sub-nav) -> Task 5.
- Drop inlined `AppShell` from hub/my-info/training -> Tasks 6-7.
- Term badge shown everywhere -> Task 4 (shared layout fetches active term).
- React `cache()` on `getActivePerson` + `getOnboardingStatus` -> Task 1.
- ~60s positive-only onboarding-gate cache, offboarding unaffected -> Tasks 2-3.
- Bundle measurement, fix only clear wins -> Task 9 Step 3.
- Public routes keep own chrome / no URL changes -> Tasks 4-7 (route group is URL-transparent; public dirs stay at root).
- Verification (tests, typecheck, lint, build, manual) -> Tasks 8-9.
