# Onboarding Gate ("Get started") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block any not-yet-cleared volunteer behind a full-screen `/get-started` clearance gate listing their four onboarding tasks, until every requirement for the active term is satisfied.

**Architecture:** A pure status engine maps existing service outputs (compliance, training, learning, profile) into per-task states. A thin service aggregates them for a person against the active term. A new `middleware.ts` exposes the request path; `requirePersonSession()` — the single gate every authenticated page already calls — redirects gated, non-allowlisted page loads to `/get-started`, which renders a split-rail checklist in the HAVEN design system.

**Tech Stack:** Next.js 15 App Router (async `headers()`/`searchParams`), React Server Components, Prisma, Tailwind v4, vitest, Lucide icons.

**Spec:** `docs/superpowers/specs/2026-06-11-onboarding-gate-design.md`

---

## File Structure

**New**
- `src/modules/onboarding/engine/status.ts` — pure task-state derivation + summary (no DB).
- `src/modules/onboarding/engine/status.test.ts` — unit tests for the engine.
- `src/modules/onboarding/services/onboarding.ts` — `getOnboardingStatus(personId)` adapter; aggregates existing services for the active term.
- `src/proxy.ts` — stamps `x-pathname` header on page requests. (Next 16 renamed `middleware.ts` → `proxy.ts`, export `proxy`, Node runtime; placed under `src/` to match the `src/app` layout. Verified detected as `ƒ Proxy (Middleware)` in the build.)
- `src/app/get-started/page.tsx` — the blocking split-rail screen (server component).
- `src/app/get-started/onboarding-checklist.tsx` — presentational checklist + rows.

**Modified**
- `src/platform/auth/session.ts` — add onboarding enforcement to `requirePersonSession`.

### Existing signatures this plan depends on (verified against `origin/main`)

```ts
// @/platform/compliance/rules
export type TrainingState = "COMPLETE" | "PENDING";
export type ComplianceStatus = "COMPLIANT" | "EXPIRING_SOON" | "EXPIRED" | "UNKNOWN_DATE" | "NO_CERTIFICATE";
export function complianceStatus(cert: { completionDate: Date | null } | null, termEnd: Date | null, now?: Date): ComplianceStatus;

// @/modules/my-info/services/my-info
export function listMyCertificates(personId: string): Promise<HipaaCertificate[]>; // newest-first; [0] is latest

// @/modules/recruitment/services/training
export function getMyTraining(personId: string): Promise<MyTraining>; // { state: TrainingState; attemptsUsed: number; ... } — THROWS if no active term

// @/modules/learning/services/enrollment
export type MyCourseRow = { id: string; title: string; description: string | null; status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE" };
export function getMyCourses(personId: string): Promise<MyCourseRow[]>; // [] when none assigned

// @/platform/rbac/engine
export function can(personId: string, permission: string): Promise<boolean>;

// @/platform/db
export const prisma; // PrismaClient

// @/platform/ui/button
export function buttonClasses(variant?: "primary"|"outline"|"danger"|"ghost", size?: "sm"|"md", extra?: string): string;
export function cx(...parts: (string|undefined|false|null)[]): string;

// @/platform/ui/badge
export function Badge(props: { tone?: "default"|"brand"|"success"|"warning"|"critical" } & ComponentProps<"span">): JSX.Element;

// @/platform/ui/haven-logo
export function HavenLogo(props: { className?: string }): Promise<JSX.Element>; // async server component

// @/platform/auth/auth
export const signOut; // server action, used as: await signOut({ redirectTo: "/login" })
```

Module-hue CSS vars available in `globals.css`: `--mod-info(-bg)`, `--mod-recruit(-bg)`, `--mod-volunteers(-bg)`, `--mod-admin(-bg)`, `--mod-schedule(-bg)`. Brand gradient utility (from home hero): `bg-gradient-to-br from-brand to-brand-deep`.

---

## Task 1: Pure status engine

**Files:**
- Create: `src/modules/onboarding/engine/status.ts`
- Test: `src/modules/onboarding/engine/status.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/onboarding/engine/status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  deriveProfileTaskState,
  deriveHipaaTaskState,
  deriveTrainingTaskState,
  deriveLearningTaskState,
  isSatisfied,
  summarize,
} from "./status";

describe("deriveProfileTaskState", () => {
  it("is COMPLETE when contactEmail and phone are both present", () => {
    expect(deriveProfileTaskState({ contactEmail: "a@b.c", phone: "203" })).toBe("COMPLETE");
  });
  it("is INCOMPLETE when a required field is missing or blank", () => {
    expect(deriveProfileTaskState({ contactEmail: "a@b.c", phone: null })).toBe("INCOMPLETE");
    expect(deriveProfileTaskState({ contactEmail: "", phone: "203" })).toBe("INCOMPLETE");
    expect(deriveProfileTaskState({ contactEmail: "a@b.c", phone: "   " })).toBe("INCOMPLETE");
  });
});

describe("deriveHipaaTaskState", () => {
  it("is COMPLETE when compliant or expiring soon", () => {
    expect(deriveHipaaTaskState("COMPLIANT")).toBe("COMPLETE");
    expect(deriveHipaaTaskState("EXPIRING_SOON")).toBe("COMPLETE");
  });
  it("is INCOMPLETE otherwise", () => {
    expect(deriveHipaaTaskState("EXPIRED")).toBe("INCOMPLETE");
    expect(deriveHipaaTaskState("UNKNOWN_DATE")).toBe("INCOMPLETE");
    expect(deriveHipaaTaskState("NO_CERTIFICATE")).toBe("INCOMPLETE");
  });
});

describe("deriveTrainingTaskState", () => {
  it("is COMPLETE when state is COMPLETE", () => {
    expect(deriveTrainingTaskState({ state: "COMPLETE", attemptsUsed: 0 })).toBe("COMPLETE");
  });
  it("is IN_PROGRESS when pending with at least one attempt", () => {
    expect(deriveTrainingTaskState({ state: "PENDING", attemptsUsed: 2 })).toBe("IN_PROGRESS");
  });
  it("is INCOMPLETE when pending with no attempts", () => {
    expect(deriveTrainingTaskState({ state: "PENDING", attemptsUsed: 0 })).toBe("INCOMPLETE");
  });
});

describe("deriveLearningTaskState", () => {
  it("is NOT_REQUIRED when no courses are assigned", () => {
    expect(deriveLearningTaskState([])).toBe("NOT_REQUIRED");
  });
  it("is COMPLETE when every assigned course is complete", () => {
    expect(deriveLearningTaskState([{ status: "COMPLETE" }, { status: "COMPLETE" }])).toBe("COMPLETE");
  });
  it("is IN_PROGRESS when some progress exists but not all complete", () => {
    expect(deriveLearningTaskState([{ status: "COMPLETE" }, { status: "NOT_STARTED" }])).toBe("IN_PROGRESS");
    expect(deriveLearningTaskState([{ status: "IN_PROGRESS" }])).toBe("IN_PROGRESS");
  });
  it("is INCOMPLETE when nothing is started", () => {
    expect(deriveLearningTaskState([{ status: "NOT_STARTED" }, { status: "NOT_STARTED" }])).toBe("INCOMPLETE");
  });
});

describe("isSatisfied", () => {
  it("treats COMPLETE and NOT_REQUIRED as satisfied", () => {
    expect(isSatisfied("COMPLETE")).toBe(true);
    expect(isSatisfied("NOT_REQUIRED")).toBe(true);
    expect(isSatisfied("IN_PROGRESS")).toBe(false);
    expect(isSatisfied("INCOMPLETE")).toBe(false);
  });
});

describe("summarize", () => {
  it("counts satisfied tasks and flags onboarded only when all are satisfied", () => {
    expect(summarize(["COMPLETE", "NOT_REQUIRED", "COMPLETE", "COMPLETE"])).toEqual({
      completedCount: 4, totalCount: 4, onboarded: true,
    });
    expect(summarize(["COMPLETE", "INCOMPLETE", "IN_PROGRESS", "NOT_REQUIRED"])).toEqual({
      completedCount: 2, totalCount: 4, onboarded: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/onboarding/engine/status.test.ts`
Expected: FAIL — "Failed to resolve import './status'".

- [ ] **Step 3: Write minimal implementation**

Create `src/modules/onboarding/engine/status.ts`:

```ts
import type { ComplianceStatus, TrainingState } from "@/platform/compliance/rules";

/** The four onboarding requirements a volunteer clears for the active term. */
export type OnboardingTaskKey = "profile" | "hipaa" | "training" | "learning";

/** Per-task resolution. NOT_REQUIRED means the task does not apply (e.g. no
 *  courses assigned) and is treated as satisfied for gating. */
export type OnboardingTaskState = "COMPLETE" | "IN_PROGRESS" | "INCOMPLETE" | "NOT_REQUIRED";

function present(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** Profile is complete when the core contact identity editable in /my-info is filled. */
export function deriveProfileTaskState(p: { contactEmail: string | null; phone: string | null }): OnboardingTaskState {
  return present(p.contactEmail) && present(p.phone) ? "COMPLETE" : "INCOMPLETE";
}

/** A HIPAA cert that is valid today (compliant or merely expiring soon) clears the task. */
export function deriveHipaaTaskState(status: ComplianceStatus): OnboardingTaskState {
  return status === "COMPLIANT" || status === "EXPIRING_SOON" ? "COMPLETE" : "INCOMPLETE";
}

/** Training is complete when passed; a started-but-unpassed attempt reads as in progress. */
export function deriveTrainingTaskState(t: { state: TrainingState; attemptsUsed: number }): OnboardingTaskState {
  if (t.state === "COMPLETE") return "COMPLETE";
  return t.attemptsUsed > 0 ? "IN_PROGRESS" : "INCOMPLETE";
}

/** Learning clears when every assigned course is complete; none assigned ⇒ not required. */
export function deriveLearningTaskState(courses: { status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE" }[]): OnboardingTaskState {
  if (courses.length === 0) return "NOT_REQUIRED";
  if (courses.every((c) => c.status === "COMPLETE")) return "COMPLETE";
  if (courses.some((c) => c.status !== "NOT_STARTED")) return "IN_PROGRESS";
  return "INCOMPLETE";
}

/** COMPLETE and NOT_REQUIRED both satisfy the gate. */
export function isSatisfied(state: OnboardingTaskState): boolean {
  return state === "COMPLETE" || state === "NOT_REQUIRED";
}

/** Roll up task states into display counts + the overall onboarded flag. */
export function summarize(states: OnboardingTaskState[]): { completedCount: number; totalCount: number; onboarded: boolean } {
  const completedCount = states.filter(isSatisfied).length;
  return { completedCount, totalCount: states.length, onboarded: completedCount === states.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/onboarding/engine/status.test.ts`
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
git add src/modules/onboarding/engine/status.ts src/modules/onboarding/engine/status.test.ts
git commit -m "feat(onboarding): pure task-state engine for the clearance gate"
```

---

## Task 2: Status service (aggregator)

**Files:**
- Create: `src/modules/onboarding/services/onboarding.ts`

This is a thin DB adapter over Task 1's pure engine and existing services. It is not unit-tested in isolation (no DB harness in this environment, matching how `compliance/rules.ts` carries the tested logic while its callers are integration-only); correctness of the mapping is covered by Task 1, and wiring is verified by typecheck + build in Task 7.

- [ ] **Step 1: Write the service**

Create `src/modules/onboarding/services/onboarding.ts`:

```ts
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { complianceStatus } from "@/platform/compliance/rules";
import { listMyCertificates } from "@/modules/my-info/services/my-info";
import { getMyTraining } from "@/modules/recruitment/services/training";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import {
  deriveProfileTaskState,
  deriveHipaaTaskState,
  deriveTrainingTaskState,
  deriveLearningTaskState,
  summarize,
  type OnboardingTaskKey,
  type OnboardingTaskState,
} from "../engine/status";

/** The permission that exempts a person from the gate (IT / super-admin proxy). */
export const EXEMPT_PERMISSION = "admin.access";

export type OnboardingTask = {
  key: OnboardingTaskKey;
  label: string;
  description: string;
  href: string;
  ctaLabel: string;
  state: OnboardingTaskState;
};

export type OnboardingStatus = {
  hasActiveTerm: boolean;
  exempt: boolean;
  tasks: OnboardingTask[];
  completedCount: number;
  totalCount: number;
  onboarded: boolean;
};

/** Static presentation copy per task (HAVEN voice; sentence case; no em-dashes). */
const COPY: Record<OnboardingTaskKey, { label: string; description: string; href: string; ctaLabel: string }> = {
  profile: {
    label: "Profile & agreements",
    description: "Confirm your contact details so we can reach you about shifts.",
    href: "/my-info",
    ctaLabel: "Complete profile",
  },
  hipaa: {
    label: "HIPAA certificate",
    description: "Upload your current HIPAA certificate so we can verify it is valid through the term.",
    href: "/my-info",
    ctaLabel: "Upload certificate",
  },
  training: {
    label: "Volunteer training",
    description: "Finish this term's training to be cleared for shifts.",
    href: "/training",
    ctaLabel: "Go to training",
  },
  learning: {
    label: "Learning modules",
    description: "Complete the courses your department assigned to you.",
    href: "/learning",
    ctaLabel: "Open courses",
  },
};

function task(key: OnboardingTaskKey, state: OnboardingTaskState): OnboardingTask {
  return { key, state, ...COPY[key] };
}

/**
 * Compute a person's onboarding clearance for the active term. Returns a dormant
 * (onboarded:true) status when there is no active term, so the gate never blocks.
 */
export async function getOnboardingStatus(personId: string): Promise<OnboardingStatus> {
  const exempt = await can(personId, EXEMPT_PERMISSION);

  const term = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  if (!term) {
    return { hasActiveTerm: false, exempt, tasks: [], completedCount: 0, totalCount: 0, onboarded: true };
  }

  const [person, certs, training, courses] = await Promise.all([
    prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { contactEmail: true, phone: true } }),
    listMyCertificates(personId),
    getMyTraining(personId), // safe: active term exists
    getMyCourses(personId),
  ]);

  const tasks: OnboardingTask[] = [
    task("profile", deriveProfileTaskState(person)),
    task("hipaa", deriveHipaaTaskState(complianceStatus(certs[0] ?? null, term.endDate))),
    task("training", deriveTrainingTaskState({ state: training.state, attemptsUsed: training.attemptsUsed })),
    task("learning", deriveLearningTaskState(courses)),
  ];

  const { completedCount, totalCount, onboarded } = summarize(tasks.map((t) => t.state));
  return { hasActiveTerm: true, exempt, tasks, completedCount, totalCount, onboarded };
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: no errors. (Confirms every imported symbol/field name resolves: `term.endDate`, `training.state`, `training.attemptsUsed`, `MyCourseRow.status`, `person.contactEmail/phone`.)

- [ ] **Step 3: Commit**

```bash
git add src/modules/onboarding/services/onboarding.ts
git commit -m "feat(onboarding): aggregate clearance status for the active term"
```

---

## Task 3: Path-exposing middleware

**Files:**
- Create: `middleware.ts` (repo root)

- [ ] **Step 1: Write the middleware**

Create `middleware.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";

/**
 * Stamp the incoming pathname into a request header so server components
 * (notably requirePersonSession's onboarding gate) can read the current path.
 * Page routes only — API, Next internals, and static assets are excluded by the
 * matcher below, so this never runs on data/asset requests.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add middleware.ts
git commit -m "feat(onboarding): expose request pathname via x-pathname header"
```

---

## Task 4: Gate enforcement in requirePersonSession

**Files:**
- Modify: `src/platform/auth/session.ts`

`requirePersonSession()` currently resolves the active person and returns. We add a private `enforceOnboarding` step before the return. Allowlisted paths and exempt users skip the extra query; absence of `x-pathname` (server actions) is a no-op so POST mutations are never redirected.

- [ ] **Step 1: Add imports**

At the top of `src/platform/auth/session.ts`, add to the existing imports:

```ts
import { headers } from "next/headers";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
```

(`redirect` from `next/navigation` is already imported.)

- [ ] **Step 2: Add the allowlist + enforcement helper**

Add near the top of the file, after the imports / `PersonSession` type:

```ts
/** Paths reachable without being onboarded: the gate itself, the fix-it pages
 *  for each task, and the auth escape hatches. Prefix-matched so sub-paths
 *  (e.g. /learning/abc) are covered. */
const ONBOARDING_ALLOWLIST = ["/get-started", "/my-info", "/training", "/learning", "/login", "/welcome"];

function isAllowlistedPath(path: string): boolean {
  return ONBOARDING_ALLOWLIST.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Hard gate: send a gated, not-yet-cleared person to /get-started. No-op when
 * there is no path context (server actions), on allowlisted paths, for exempt
 * users, when there is no active term, or when already onboarded.
 */
async function enforceOnboarding(personId: string): Promise<void> {
  const path = (await headers()).get("x-pathname");
  if (!path || isAllowlistedPath(path)) return;

  const status = await getOnboardingStatus(personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) return;

  redirect("/get-started");
}
```

- [ ] **Step 3: Call it from requirePersonSession**

In `requirePersonSession`, replace the final `return { ... }` so enforcement runs first:

```ts
  const result: PersonSession = {
    personId: person.id,
    name: person.name,
    email: person.contactEmail ?? session.user?.email ?? null,
  };
  await enforceOnboarding(person.id);
  return result;
```

(`redirect` throws to interrupt rendering, so a gated request never reaches `return`.)

- [ ] **Step 4: Verify typecheck + existing pure tests still pass**

Run: `npx tsc --noEmit && npx vitest run src/platform/compliance/rules.test.ts src/modules/onboarding/engine/status.test.ts`
Expected: no type errors; tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/auth/session.ts
git commit -m "feat(onboarding): redirect not-yet-cleared volunteers to /get-started"
```

---

## Task 5: Checklist presentational component

**Files:**
- Create: `src/app/get-started/onboarding-checklist.tsx`

A client-free presentational component: props in, markup out. Renders the right-hand task list of the split-rail screen.

- [ ] **Step 1: Write the component**

Create `src/app/get-started/onboarding-checklist.tsx`:

```tsx
import type { CSSProperties } from "react";
import Link from "next/link";
import { Check, UserRoundPen, ShieldCheck, GraduationCap, BookOpen, type LucideIcon } from "lucide-react";
import { Badge } from "@/platform/ui/badge";
import { buttonClasses } from "@/platform/ui/button";
import type { OnboardingTask, OnboardingTaskKey } from "@/modules/onboarding/services/onboarding";
import type { OnboardingTaskState } from "@/modules/onboarding/engine/status";

const ICON: Record<OnboardingTaskKey, LucideIcon> = {
  profile: UserRoundPen,
  hipaa: ShieldCheck,
  training: GraduationCap,
  learning: BookOpen,
};

/** Each task tile gets one quiet module hue. */
const HUE: Record<OnboardingTaskKey, string> = {
  profile: "volunteers",
  hipaa: "info",
  training: "recruit",
  learning: "admin",
};

function hueStyle(key: OnboardingTaskKey): CSSProperties {
  return {
    ["--mh" as string]: `var(--mod-${HUE[key]})`,
    ["--mhbg" as string]: `var(--mod-${HUE[key]}-bg)`,
  } as CSSProperties;
}

function StatusPill({ state }: { state: OnboardingTaskState }) {
  if (state === "COMPLETE") return <Badge tone="success">Done</Badge>;
  if (state === "NOT_REQUIRED") return <Badge tone="default">Not required</Badge>;
  if (state === "IN_PROGRESS") return <Badge tone="brand">In progress</Badge>;
  return <Badge tone="warning">Action needed</Badge>;
}

function TaskRow({ task }: { task: OnboardingTask }) {
  const Icon = ICON[task.key];
  const done = task.state === "COMPLETE" || task.state === "NOT_REQUIRED";
  return (
    <li
      className={`flex items-center gap-4 rounded-2xl border p-4 shadow-sm ${
        done ? "border-green-200 bg-green-50/60" : "border-slate-200 bg-white"
      }`}
    >
      <span
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl"
        style={{ ...hueStyle(task.key), background: "var(--mhbg)", color: "var(--mh)" }}
      >
        <Icon aria-hidden className="h-[22px] w-[22px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-bold tracking-tight text-slate-800">{task.label}</span>
          <StatusPill state={task.state} />
        </div>
        <p className="mt-0.5 text-[13px] leading-snug text-slate-600">{task.description}</p>
      </div>
      {done ? (
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-success text-white">
          <Check aria-hidden className="h-4 w-4" strokeWidth={3} />
        </span>
      ) : (
        <Link href={task.href} className={buttonClasses(task.state === "INCOMPLETE" ? "primary" : "outline", "sm")}>
          {task.ctaLabel}
        </Link>
      )}
    </li>
  );
}

export function OnboardingChecklist({ tasks }: { tasks: OnboardingTask[] }) {
  return (
    <ul className="space-y-3">
      {tasks.map((t) => (
        <TaskRow key={t.key} task={t} />
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: no errors. (Confirms the Lucide icon names exist and Badge/buttonClasses signatures match.)

- [ ] **Step 3: Commit**

```bash
git add src/app/get-started/onboarding-checklist.tsx
git commit -m "feat(onboarding): get-started checklist rows"
```

---

## Task 6: The /get-started screen

**Files:**
- Create: `src/app/get-started/page.tsx`

Split-rail (Variant B): navy hero rail on the left with progress, checklist on the right. Renders outside `AppShell`. Redirects to `/` when the person is exempt, has no active term, or is already onboarded.

- [ ] **Step 1: Write the page**

Create `src/app/get-started/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { signOut } from "@/platform/auth/auth";
import { HavenLogo } from "@/platform/ui/haven-logo";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { OnboardingChecklist } from "./onboarding-checklist";

export default async function GetStartedPage() {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);

  // Never a dead end: anyone who does not belong here goes to the hub.
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");

  const firstName = person.name ? person.name.trim().split(/\s+/)[0] : "there";
  const pct = status.totalCount > 0 ? Math.round((status.completedCount / status.totalCount) * 100) : 0;

  return (
    <main className="grid min-h-screen grid-cols-1 bg-[#eef1f5] md:grid-cols-[340px_1fr]">
      {/* Left rail */}
      <aside className="relative flex flex-col overflow-hidden bg-gradient-to-br from-brand to-brand-deep p-8 text-white md:p-10">
        <span className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-white/[0.07]" aria-hidden />
        <div className="relative flex flex-1 flex-col">
          <HavenLogo className="h-9 text-white" />
          <p className="mt-8 text-[11px] font-bold uppercase tracking-[0.14em] text-white/60">
            Getting started
          </p>
          <h1 className="mt-2 text-[26px] font-extrabold leading-tight tracking-tight">
            Let&apos;s get you cleared, {firstName}
          </h1>
          <p className="mt-3 text-[13.5px] leading-relaxed text-white/80">
            Complete these steps to be ready for shifts. You cannot be scheduled until each one is
            done, but you can finish them in any order.
          </p>
          <div className="mt-7">
            <div className="mb-2 flex justify-between text-[12px] font-semibold text-white/80">
              <span>Your progress</span>
              <span>
                {status.completedCount} of {status.totalCount}
              </span>
            </div>
            <div className="h-[7px] overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-white transition-[width] duration-300" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <p className="mt-auto pt-7 text-[12.5px] text-white/60">
            Need help? Contact your recruitment director.
          </p>
        </div>
      </aside>

      {/* Right panel */}
      <section className="overflow-auto p-8 md:p-10">
        <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">What&apos;s left</p>
        <OnboardingChecklist tasks={status.tasks} />
        <form
          className="mt-6 text-[13px] text-slate-500"
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          Wrong account?{" "}
          <button type="submit" className="font-semibold text-brand underline-offset-2 hover:underline">
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no type errors; lint clean (fix any reported issues, e.g. unescaped entities).

- [ ] **Step 3: Commit**

```bash
git add src/app/get-started/page.tsx
git commit -m "feat(onboarding): split-rail Get started clearance screen"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all succeed. The production build compiles `middleware.ts`, the new route, and the modified session gate together — catching any wiring error.

- [ ] **Step 2: Run the unit tests**

Run: `npx vitest run src/modules/onboarding`
Expected: Task 1 engine tests PASS.

- [ ] **Step 3: (If Postgres is available) full suite**

Run: `npm run db:up && npm run test:prepare && npm test`
Expected: full suite green, no regressions. If no local Postgres, note this step was skipped and rely on steps 1-2 plus the pre-merge CI.

- [ ] **Step 4: Manual smoke (dev server)**

Run: `npm run dev`, then as a non-admin volunteer who is not cleared in the active term:
- Visit `/` → redirected to `/get-started`; the four tasks show with correct states and a progress meter.
- Click a task CTA → lands on `/my-info`, `/training`, or `/learning` (no redirect loop).
- Complete every task → next visit to `/` renders the hub (gate lifted).
- As a user with `admin.access` → `/` renders normally, `/get-started` redirects to `/`.
- With no active term → no redirect anywhere.

- [ ] **Step 5: Final commit (if any lint/build fixups were needed)**

```bash
git add -A
git commit -m "chore(onboarding): verification fixups"
```

---

## Self-review notes

- **Spec coverage:** audience/exemption (Task 2 `EXEMPT_PERMISSION` + Task 4 guard), four tasks (Task 1 + 2), dormancy with no active term (Task 2 early return + Task 4/6 checks), middleware path exposure (Task 3), guard at the single chokepoint (Task 4), split-rail screen with design-system fidelity + sign-out + progress (Task 5/6), pure unit tests (Task 1), out-of-scope items untouched.
- **Profile rule** resolved exactly: `contactEmail` + `phone` (both editable in `/my-info`), per the spec's "never gate on a field with no in-hub editor."
- **Type consistency:** `OnboardingTask`/`OnboardingTaskState`/`OnboardingTaskKey` defined in Tasks 1-2 and consumed unchanged in Tasks 5-6; `getOnboardingStatus` shape identical across guard, page, and component.
- **No DB in unit tests:** intentional — pure engine is fully tested; service/guard/page are verified via typecheck + build + manual smoke, consistent with the existing codebase.
