# Dashboard Action Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's mixed "quick actions" strip with a smart, ranked feed of personal + role action cards (live counts, verb-forward labels), backfilled with module shortcuts when there aren't enough real actions.

**Architecture:** One pure, unit-tested builder (`buildActionCards`) ranks candidate cards by urgency and appends module-shortcut backfill, capped at 4. The dashboard Server Component (`page.tsx`) gathers inputs (almost all already fetched) and renders the result in the existing compact-card markup. One new cheap query, `countPendingApprovals`, supplies the only input not already on the page.

**Tech Stack:** Next.js App Router (Server Components), TypeScript, Tailwind (OKLCH design tokens), lucide-react icons, Prisma, Vitest.

## Global Constraints

- **No em-dashes** in any UI copy, comments, or commit messages. Use commas, parentheses, or colons.
- **"HAVEN Hub"** is two words in prose/UI; identifiers stay `havenhub`.
- **No `tailwind-merge`.** Compose classes with string concatenation (`cardClasses({...}) + " ..."`), the existing pattern. Do not add className-override libraries.
- **Reuse existing design tokens.** Only one new token is authorized: `--mod-swap`. Training reuses `recruit`.
- **Local test safety (shared-Neon hazard):** NEVER run `npm test` / `vitest run` with no file argument in this worktree. The repo `.env`'s `TEST_DATABASE_URL` may point at the shared Neon DB, and the full suite is DB-backed. Only run the single pure file: `npx vitest run "src/app/(app)/action-cards.test.ts"` (it imports no Prisma). DB-backed integration and `next build` are validated in CI, which uses isolated Neon preview branches.
- **Purity:** `action-cards.ts` must stay pure (plain-data in, plain-data out). Use `import type` for `ComplianceStatus` so no server module is pulled into the test.

---

### Task 1: Add the `--mod-swap` hue token

**Files:**
- Modify: `src/app/globals.css` (light `--mod-*` block ends ~line 74; dark block ends ~line 93)

**Interfaces:**
- Consumes: nothing.
- Produces: CSS custom properties `--mod-swap` and `--mod-swap-bg` (light + dark), consumed by the swap card's inline `var(--mod-swap)` / `var(--mod-swap-bg)` in Task 4.

- [ ] **Step 1: Add the light-mode token**

In `src/app/globals.css`, immediately after the `--mod-recruit-bg:` line in the light block (the one reading `--mod-recruit-bg:    oklch(0.96 0.024 300);`), add:

```css
  --mod-swap:    oklch(0.55 0.11 55);
  --mod-swap-bg: oklch(0.96 0.035 60);
```

- [ ] **Step 2: Add the dark-mode token**

In the dark block, immediately after the dark `--mod-recruit-bg:` line (the one reading `--mod-recruit-bg: oklch(0.30 0.045 300);`), add:

```css
  --mod-swap:    oklch(0.82 0.10 60);
  --mod-swap-bg: oklch(0.30 0.05 60);
```

- [ ] **Step 3: Verify both tokens are defined**

Run: `grep -n "\--mod-swap" src/app/globals.css`
Expected: four lines (two light, two dark) for `--mod-swap` and `--mod-swap-bg`.

- [ ] **Step 4: Commit**

```bash
git add src/app/globals.css
git commit -m "feat(dashboard): add --mod-swap hue token"
```

---

### Task 2: The pure `buildActionCards` builder (TDD)

**Files:**
- Create: `src/app/(app)/action-cards.ts`
- Test: `src/app/(app)/action-cards.test.ts`

**Interfaces:**
- Consumes: `ComplianceStatus` (type only) from `@/platform/compliance/rules` — the union `"COMPLIANT" | "EXPIRING_SOON" | "EXPIRED" | "NO_CERTIFICATE" | "UNKNOWN_DATE" | "PENDING_VERIFICATION"`.
- Produces:
  - `type ActionCard = { key: string; href: string; icon: LucideIcon; hue: string; label: string; sub: string; priority: number }`
  - `type ActionCardInput` (see code below)
  - `function buildActionCards(input: ActionCardInput): ActionCard[]`

  Consumed by Task 4 (`page.tsx`).

- [ ] **Step 1: Write the failing test**

Create `src/app/(app)/action-cards.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Users } from "lucide-react";
import { buildActionCards, type ActionCard, type ActionCardInput } from "./action-cards";

const base: ActionCardInput = {
  hasScheduleAccess: true,
  hasMyInfoAccess: true,
  upcomingCount: 0,
  nextShiftDaysAway: null,
  pendingSwapCount: 0,
  pendingApprovals: 0,
  compliance: "COMPLIANT",
  trainingIncomplete: 0,
  trainingHref: "/training",
  profileIncomplete: false,
  backfill: [],
};

const shortcut = (key: string, href: string): ActionCard => ({
  key,
  href,
  icon: Users,
  hue: "volunteers",
  label: key,
  sub: "",
  priority: 0,
});

describe("buildActionCards", () => {
  it("ranks approvals above an imminent schedule above swap", () => {
    const cards = buildActionCards({
      ...base,
      pendingApprovals: 2,
      nextShiftDaysAway: 1,
      upcomingCount: 3,
      pendingSwapCount: 1,
    });
    const keys = cards.map((c) => c.key);
    expect(keys[0]).toBe("approvals");
    expect(keys.indexOf("schedule")).toBeLessThan(keys.indexOf("swap"));
  });

  it("omits schedule and swap without schedule access", () => {
    const cards = buildActionCards({ ...base, hasScheduleAccess: false, upcomingCount: 5 });
    expect(cards.find((c) => c.key === "schedule")).toBeUndefined();
    expect(cards.find((c) => c.key === "swap")).toBeUndefined();
  });

  it("shows swap only when there is an upcoming shift", () => {
    expect(buildActionCards({ ...base, upcomingCount: 0 }).find((c) => c.key === "swap")).toBeUndefined();
    expect(buildActionCards({ ...base, upcomingCount: 1 }).find((c) => c.key === "swap")).toBeDefined();
  });

  it("surfaces the most urgent my-info concern, else standing", () => {
    const urgent = buildActionCards({ ...base, compliance: "EXPIRED", profileIncomplete: true })
      .find((c) => c.key === "my-info");
    expect(urgent?.sub).toBe("Upload HIPAA certificate");
    expect(urgent?.priority).toBe(90);

    const standing = buildActionCards(base).find((c) => c.key === "my-info");
    expect(standing?.sub).toBe("View & update");
    expect(standing?.priority).toBe(20);
  });

  it("backfills remaining slots after real actions, never before", () => {
    const cards = buildActionCards({
      ...base,
      backfill: [shortcut("volunteers", "/volunteers"), shortcut("admin", "/admin")],
    });
    const keys = cards.map((c) => c.key);
    expect(keys.slice(0, 2)).toEqual(["schedule", "my-info"]);
    expect(keys).toContain("volunteers");
    expect(keys.indexOf("volunteers")).toBeGreaterThan(keys.indexOf("my-info"));
  });

  it("never returns more than the limit", () => {
    const cards = buildActionCards({
      ...base,
      pendingApprovals: 1,
      trainingIncomplete: 2,
      upcomingCount: 3,
      nextShiftDaysAway: 5,
      backfill: [
        shortcut("volunteers", "/volunteers"),
        shortcut("recruitment", "/recruitment"),
        shortcut("admin", "/admin"),
      ],
    });
    expect(cards.length).toBe(4);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "src/app/(app)/action-cards.test.ts"`
Expected: FAIL — cannot resolve `./action-cards` (module does not exist yet).

- [ ] **Step 3: Write the builder**

Create `src/app/(app)/action-cards.ts`:

```ts
import {
  CalendarDays,
  Repeat,
  UserRoundPen,
  GraduationCap,
  ClipboardCheck,
  type LucideIcon,
} from "lucide-react";
import type { ComplianceStatus } from "@/platform/compliance/rules";

export type ActionCard = {
  key: string;
  href: string;
  icon: LucideIcon;
  hue: string; // a --mod-<hue> token key
  label: string;
  sub: string;
  priority: number; // ranking only; not rendered
};

export type ActionCardInput = {
  hasScheduleAccess: boolean;
  hasMyInfoAccess: boolean;
  upcomingCount: number;
  nextShiftDaysAway: number | null; // null when no upcoming shift
  pendingSwapCount: number;
  pendingApprovals: number;
  compliance: ComplianceStatus;
  trainingIncomplete: number;
  trainingHref: string;
  profileIncomplete: boolean;
  backfill: ActionCard[]; // module shortcuts, in preference order, priority 0
  limit?: number; // default 4
};

/**
 * The My info card folds HIPAA and the profile "confirm" task into one /my-info
 * nudge, surfacing only the single most-pressing concern. The side rail still
 * lists the full clearance checklist, so this is intentionally not exhaustive.
 */
function myInfoCard(input: ActionCardInput): ActionCard {
  const base = { key: "my-info", href: "/my-info", icon: UserRoundPen, hue: "info", label: "My info" };
  if (input.compliance === "EXPIRED" || input.compliance === "NO_CERTIFICATE") {
    return { ...base, priority: 90, sub: "Upload HIPAA certificate" };
  }
  if (input.profileIncomplete) {
    return { ...base, priority: 85, sub: "1 to confirm" };
  }
  if (input.compliance === "EXPIRING_SOON") {
    return { ...base, priority: 70, sub: "Renew HIPAA soon" };
  }
  if (input.compliance === "PENDING_VERIFICATION" || input.compliance === "UNKNOWN_DATE") {
    return { ...base, priority: 40, sub: "HIPAA in review" };
  }
  return { ...base, priority: 20, sub: "View & update" };
}

function scheduleCard(input: ActionCardInput): ActionCard {
  const base = { key: "schedule", href: "/schedule", icon: CalendarDays, hue: "schedule", label: "Schedule" };
  const d = input.nextShiftDaysAway;
  if (d != null && d <= 2) {
    const sub = d <= 0 ? "Today" : d === 1 ? "Tomorrow" : `In ${d} days`;
    return { ...base, priority: 60, sub };
  }
  const sub = input.upcomingCount > 0 ? `${input.upcomingCount} upcoming` : "View shifts";
  return { ...base, priority: 30, sub };
}

function swapCard(input: ActionCardInput): ActionCard {
  const base = { key: "swap", href: "/schedule", icon: Repeat, hue: "swap", label: "Request a swap" };
  if (input.pendingSwapCount > 0) {
    return { ...base, priority: 40, sub: `${input.pendingSwapCount} pending` };
  }
  return { ...base, priority: 25, sub: "Find cover" };
}

/**
 * Ranked smart action feed for the dashboard. Pure: all inputs are plain data,
 * so this is unit-tested without a database. Real (personal + role) actions rank
 * by urgency; module shortcuts in `backfill` fill any remaining slots. Capped at
 * `limit` (default 4). Array.sort is stable, so equal-priority cards keep their
 * insertion order.
 */
export function buildActionCards(input: ActionCardInput): ActionCard[] {
  const cards: ActionCard[] = [];

  if (input.pendingApprovals > 0) {
    cards.push({
      key: "approvals",
      href: "/schedule/builder",
      icon: ClipboardCheck,
      hue: "admin",
      label: "Approvals",
      sub: `${input.pendingApprovals} to review`,
      priority: 95,
    });
  }

  if (input.hasMyInfoAccess) {
    cards.push(myInfoCard(input));
  }

  if (input.trainingIncomplete > 0) {
    cards.push({
      key: "training",
      href: input.trainingHref,
      icon: GraduationCap,
      hue: "recruit",
      label: "Training",
      sub: input.trainingIncomplete === 1 ? "To complete" : `${input.trainingIncomplete} to complete`,
      priority: 80,
    });
  }

  if (input.hasScheduleAccess) {
    cards.push(scheduleCard(input));
    if (input.upcomingCount > 0) {
      cards.push(swapCard(input));
    }
  }

  cards.sort((a, b) => b.priority - a.priority);

  const limit = input.limit ?? 4;
  return [...cards, ...input.backfill].slice(0, limit);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "src/app/(app)/action-cards.test.ts"`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/action-cards.ts" "src/app/(app)/action-cards.test.ts"
git commit -m "feat(dashboard): pure buildActionCards ranked feed builder"
```

---

### Task 3: `countPendingApprovals` service function

**Files:**
- Modify: `src/modules/schedule/services/requests.ts` (insert after `canManageRequestsForDept`, ~line 129)

**Interfaces:**
- Consumes: existing `getActiveTerm`, `manageableRequestDepartmentIds`, and `prisma` (all already imported in this file).
- Produces: `async function countPendingApprovals(personId: string): Promise<number>` — consumed by Task 4.

- [ ] **Step 1: Add the function**

In `src/modules/schedule/services/requests.ts`, immediately after the closing brace of `canManageRequestsForDept` (the function that ends around line 129), insert:

```ts

/**
 * How many PENDING shift-change requests this person is responsible for deciding,
 * across every department they can manage requests for, in the active term. Used
 * by the dashboard action feed. Returns 0 when there is no active term or the
 * person manages no departments. One count query; reuses the same scope resolver
 * as the approve/deny path.
 */
export async function countPendingApprovals(personId: string): Promise<number> {
  const term = await getActiveTerm();
  if (!term) return 0;

  const departmentIds = await manageableRequestDepartmentIds(personId);
  if (departmentIds.length === 0) return 0;

  return prisma.shiftRequest.count({
    where: { termId: term.id, departmentId: { in: departmentIds }, status: "PENDING" },
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (No local DB test: the shared-Neon hazard forbids running the DB-backed suite here. This is a thin count wrapper over the already-covered `manageableRequestDepartmentIds`; CI's full suite exercises it against an isolated Neon preview branch.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/modules/schedule/services/requests.ts
git commit -m "feat(schedule): countPendingApprovals for dashboard feed"
```

---

### Task 4: Wire the feed into the dashboard

**Files:**
- Modify: `src/app/(app)/page.tsx`

**Interfaces:**
- Consumes: `buildActionCards`, `type ActionCard` (Task 2); `countPendingApprovals` (Task 3); the `--mod-swap` token (Task 1).
- Produces: user-visible action feed. No exports consumed downstream.

- [ ] **Step 1: Update imports**

In `src/app/(app)/page.tsx`, replace the lucide import block (currently importing `CalendarDays, UserRoundPen, Users, ClipboardList, Settings, Stethoscope, ArrowRight, Repeat, Check, Clock, ChevronRight, type LucideIcon`) with only the icons still used directly by the page:

```ts
import {
  CalendarDays,
  ClipboardList,
  Stethoscope,
  ArrowRight,
  Repeat,
  Check,
  Clock,
  ChevronRight,
} from "lucide-react";
```

Then add these two imports alongside the existing service imports (after the `mySchedule` import line):

```ts
import { countPendingApprovals } from "@/modules/schedule/services/requests";
import { buildActionCards, type ActionCard } from "./action-cards";
```

- [ ] **Step 2: Add the `hueVars` helper and simplify `hueStyle`**

Replace the existing `hueStyle` function (the one reading `function hueStyle(id: string): CSSProperties { const hue = HUE_BY_MODULE[id] ?? "schedule"; return { ... }; }`) with:

```ts
/** CSS vars for a given hue token key, so Tailwind's static scan never sees dynamic hues. */
function hueVars(hue: string): CSSProperties {
  return {
    ["--mh" as string]: `var(--mod-${hue})`,
    ["--mhbg" as string]: `var(--mod-${hue}-bg)`,
  } as CSSProperties;
}

/** Module-tile hue, keyed by module id. */
function hueStyle(id: string): CSSProperties {
  return hueVars(HUE_BY_MODULE[id] ?? "schedule");
}
```

- [ ] **Step 3: Fetch the approvals count**

Change the `Promise.all` destructuring (currently `const [schedule, certificates, isPanelist, orgName, onboarding] = await Promise.all([...])`) to add the count:

```ts
  const [schedule, certificates, isPanelist, orgName, onboarding, pendingApprovals] = await Promise.all([
    mySchedule(person.personId),
    listMyCertificates(person.personId),
    isInterviewPanelist(person.personId),
    getSetting<string>("branding.orgName"),
    getOnboardingStatus(person.personId),
    countPendingApprovals(person.personId),
  ]);
```

- [ ] **Step 4: Replace the quick-actions computation**

Delete the entire old quick-actions block (from the comment `// --- Quick actions (real links, access-filtered, capped at 4) ---` through `const quick = quickAll.filter((q) => q.show).slice(0, 4);`, including the `hipaaShort` const). Replace it with:

```ts
  // --- Smart action feed: personal + role actions ranked by urgency, module
  // shortcuts backfilling any remaining slots (see action-cards.ts). ---
  const trainingTasks = onboarding.tasks.filter(
    (t) =>
      (t.key === "training" || t.key === "directorTraining" || t.key === "learning") &&
      t.state !== "COMPLETE" &&
      t.state !== "NOT_REQUIRED",
  );
  const profileTask = onboarding.tasks.find((t) => t.key === "profile");

  // Navigational shortcuts, only shown when there aren't enough real actions.
  const backfill: ActionCard[] = [];
  for (const id of ["volunteers", "recruitment"] as const) {
    const m = activeModules.find((mm) => mm.id === id);
    if (m) {
      backfill.push({ key: m.id, href: `/${m.id}`, icon: m.icon, hue: HUE_BY_MODULE[m.id] ?? "schedule", label: m.title, sub: m.description, priority: 0 });
    }
  }
  if (isPanelist) {
    backfill.push({ key: "my-interviews", href: "/recruitment/interviews", icon: ClipboardList, hue: "recruit", label: "My interviews", sub: "Panel assignments", priority: 0 });
  }
  const adminModule = activeModules.find((mm) => mm.id === "admin");
  if (adminModule) {
    backfill.push({ key: "admin", href: "/admin", icon: adminModule.icon, hue: HUE_BY_MODULE.admin, label: adminModule.title, sub: adminModule.description, priority: 0 });
  }

  const cards = buildActionCards({
    hasScheduleAccess: accessible.has("schedule"),
    hasMyInfoAccess: accessible.has("my-info"),
    upcomingCount: upcoming.length,
    nextShiftDaysAway: next ? daysAway : null,
    pendingSwapCount: schedule.pendingRequests.size,
    pendingApprovals,
    compliance: status,
    trainingIncomplete: trainingTasks.length,
    trainingHref: trainingTasks[0]?.key === "learning" ? "/learning" : "/training",
    profileIncomplete: profileTask?.state === "INCOMPLETE",
    backfill,
  });
```

- [ ] **Step 5: Replace the quick-actions render**

Replace the render block (the `{quick.length > 0 && ( ... )}` JSX that maps over `quick`) with the new feed, mapping over `cards`:

```tsx
          {/* Action feed */}
          {cards.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {cards.map((card) => {
                const Icon = card.icon;
                return (
                  <Link
                    key={card.key}
                    href={card.href}
                    style={hueVars(card.hue)}
                    className={cardClasses({ size: "compact", interactive: true, pad: false }) + " flex items-center gap-3 p-3.5"}
                  >
                    <span
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
                      style={{ color: "var(--mh)", background: "var(--mhbg)" }}
                    >
                      <Icon aria-hidden className="h-[18px] w-[18px]" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-foreground">{card.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">{card.sub}</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If it flags an unused import (e.g. a lucide icon or `LucideIcon`), remove that specific symbol from the import in Step 1 and re-run.

- [ ] **Step 7: Lint**

Run: `npm run lint`
Expected: no errors (no unused vars, no `react-hooks/purity` violations).

- [ ] **Step 8: Re-run the builder unit test (regression)**

Run: `npx vitest run "src/app/(app)/action-cards.test.ts"`
Expected: PASS — 6 tests.

- [ ] **Step 9: Optional manual check**

Run `npm run dev`, open `/`, and confirm the strip below the hero shows ranked action cards (Schedule, Request a swap, My info, Training/Approvals as applicable) with the amber swap tile rendering. Skip if the dev environment lacks a database.

- [ ] **Step 10: Commit**

```bash
git add "src/app/(app)/page.tsx"
git commit -m "feat(dashboard): render smart action feed below hero"
```

---

## Notes for the executor

- Do not run bare `npm test` or `vitest run` (no file arg) in this worktree. Only `npx vitest run "src/app/(app)/action-cards.test.ts"`.
- After all tasks, push the branch and open a PR against `main` only when the user asks. CI runs typecheck, lint, `next build`, and the full DB-backed + e2e suites against isolated Neon preview branches.
