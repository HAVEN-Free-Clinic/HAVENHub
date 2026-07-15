# Recruitment Speed Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an SRR a fast way to bulk-route the strongest scored volunteer applicants to a department, auto-reject the weakest, and keyboard-route the grey-area middle, driven by per-cycle percentile thresholds.

**Architecture:** A per-cycle threshold config on `RecruitmentCycle`, a pure bucketing engine that partitions scored applicants by committee average into top/middle/bottom/unscored, immediate-write routing and rejection services (single-row plus thin batch wrappers that reuse the single-row guards), a board service, and a Speed Route screen with a keyboard queue modal. Every write is immediate and reversible; nothing sends email.

**Tech Stack:** Next.js App Router (RSC + server actions), Prisma, TypeScript, vitest (unit + service/DB), Playwright (e2e). UI primitives in `src/platform/ui/*`.

**Spec:** `docs/superpowers/specs/2026-07-15-recruitment-speed-routing-design.md`

## Global Constraints

Every task inherits these.

- No em-dashes anywhere (prose, comments, copy). Use colons, parentheses, or restructure.
- `cx` is the only class-composition helper; there is NO tailwind-merge, so later classes do not override earlier ones. Never rely on class order to override.
- ESLint `no-restricted-syntax` bans raw `className` on native `button`/`input`/`select`/`textarea`. Use `src/platform/ui` primitives (`Button`, `buttonClasses`, `Input`, `Select`, `Checkbox`, `Modal`, `Alert`, `Badge`, `Card`, `Table`/`THead`/`TR`/`TH`/`TD`, `SubmitButton`, `Field`, `Spinner`, `PageHeader`, `SectionHeader`).
- React Compiler lint rules are on (`react-hooks/refs`, `react-hooks/set-state-in-effect`, `react-hooks/preserve-manual-memoization`). Follow `speed-score-modal.tsx`: lazy `useState` snapshot rather than a render-time ref read; refs mutated only outside render; narrowly-scoped `eslint-disable-next-line` with a one-line reason only where genuinely required.
- Values/types crossing the RSC boundary must live in non-directive (non `"use client"`) modules, or they arrive as client-ref proxies and array methods throw.
- Speed Route is VOLUNTEER-track only and gated on `recruitment.review_all` throughout.
- Recording routes and rejections sends NO email. Notification stays the separate `releaseDecisions` step.
- `Modal` uses the shipped `size="large"` prop.

## Test database (per-worktree, isolated)

This worktree uses its own native-pg test DB `havenhub_test_speedroute` on `:5434` (already created and migrated to current main). See memory `local-db-neon-hazard` / `vitest-test-db-isolation`: never point tests at Neon.

- **Run vitest:** prefix every vitest command with the DB url, e.g.
  `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" npx vitest run <file>`
- **Apply a migration to it:**
  `DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" DATABASE_URL_UNPOOLED="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" npx prisma migrate deploy`
- **Regenerate the client after a schema edit:** `npx prisma generate` (this worktree's `node_modules` is a real directory, so generate is isolated and safe here).
- `tsc`: `npx tsc --noEmit`. `eslint`: `npx eslint <path>`.

---

### Task 1: Threshold config (schema + migration + `setRouteThresholds`)

**Files:**
- Modify: `prisma/schema.prisma` (RecruitmentCycle, after `quizMaxAttempts` near line 1194)
- Create: `prisma/migrations/20260715010000_recruitment_route_thresholds/migration.sql`
- Create: `src/modules/recruitment/services/route-thresholds.ts`
- Test: `src/modules/recruitment/services/route-thresholds.test.ts`

**Interfaces:**
- Consumes: `prisma`, `can`, `recordAudit`, `RecruitmentAuthError` (from `./review`).
- Produces: `RecruitmentCycle.routeTopPercent: number`, `RecruitmentCycle.routeBottomPercent: number`; `setRouteThresholds(cycleId: string, topPercent: number, bottomPercent: number, actorId: string): Promise<void>`; `class RouteThresholdError extends Error`.

- [ ] **Step 1: Add the schema fields.** In `prisma/schema.prisma`, in `model RecruitmentCycle`, directly below the line `quizMaxAttempts Int              @default(3)` add:

```prisma
  routeTopPercent    Int              @default(20)
  routeBottomPercent Int              @default(30)
```

- [ ] **Step 2: Write the migration SQL.** Create `prisma/migrations/20260715010000_recruitment_route_thresholds/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "RecruitmentCycle" ADD COLUMN "routeTopPercent" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "RecruitmentCycle" ADD COLUMN "routeBottomPercent" INTEGER NOT NULL DEFAULT 30;
```

- [ ] **Step 3: Apply the migration and regenerate the client.**

Run:
```bash
DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" DATABASE_URL_UNPOOLED="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" npx prisma migrate deploy
npx prisma generate
```
Expected: "All migrations have been successfully applied." and a clean generate.

- [ ] **Step 4: Write the failing test.** Create `src/modules/recruitment/services/route-thresholds.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { setRouteThresholds, RouteThresholdError } from "./route-thresholds";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const other = await prisma.person.create({ data: { name: "Other", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "SRR", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC"], createdById: lead.id, status: "OPEN" } });
  return { lead, other, cycle };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("route thresholds", () => {
  it("defaults new cycles to 20 top / 30 bottom", async () => {
    const { cycle } = await seed();
    expect(cycle.routeTopPercent).toBe(20);
    expect(cycle.routeBottomPercent).toBe(30);
  });

  it("a lead can set valid thresholds and it audits", async () => {
    const { lead, cycle } = await seed();
    await setRouteThresholds(cycle.id, 15, 40, lead.id);
    const fresh = await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycle.id } });
    expect(fresh.routeTopPercent).toBe(15);
    expect(fresh.routeBottomPercent).toBe(40);
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.route_thresholds" } });
    expect(audit).not.toBeNull();
  });

  it("rejects a non-lead", async () => {
    const { other, cycle } = await seed();
    await expect(setRouteThresholds(cycle.id, 20, 30, other.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("rejects a sum over 100", async () => {
    const { lead, cycle } = await seed();
    await expect(setRouteThresholds(cycle.id, 60, 50, lead.id)).rejects.toBeInstanceOf(RouteThresholdError);
  });

  it("rejects an out-of-range or non-integer percent", async () => {
    const { lead, cycle } = await seed();
    await expect(setRouteThresholds(cycle.id, -1, 30, lead.id)).rejects.toBeInstanceOf(RouteThresholdError);
    await expect(setRouteThresholds(cycle.id, 20, 30.5, lead.id)).rejects.toBeInstanceOf(RouteThresholdError);
  });
});
```

- [ ] **Step 5: Run it, expect failure.**
Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" npx vitest run src/modules/recruitment/services/route-thresholds.test.ts`
Expected: FAIL (module `./route-thresholds` not found).

- [ ] **Step 6: Implement.** Create `src/modules/recruitment/services/route-thresholds.ts`:

```ts
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";

export class RouteThresholdError extends Error {
  constructor(message: string) { super(message); this.name = "RouteThresholdError"; }
}

/** Save a cycle's speed-route percentile thresholds. review_all only. Validates
 *  each percent as a whole number in 0..100 and top + bottom <= 100 (the middle
 *  tier is the remainder). No email or applicant-visible change. */
export async function setRouteThresholds(
  cycleId: string,
  topPercent: number,
  bottomPercent: number,
  actorId: string,
): Promise<void> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't change routing thresholds.");
  }
  for (const [label, v] of [["Top", topPercent], ["Bottom", bottomPercent]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 100) {
      throw new RouteThresholdError(`${label} percent must be a whole number from 0 to 100.`);
    }
  }
  if (topPercent + bottomPercent > 100) {
    throw new RouteThresholdError("Top and bottom percentages can't add up to more than 100.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId }, select: { id: true } });
  if (!cycle) throw new RouteThresholdError("Cycle not found.");
  await prisma.recruitmentCycle.update({ where: { id: cycleId }, data: { routeTopPercent: topPercent, routeBottomPercent: bottomPercent } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.route_thresholds", entityType: "RecruitmentCycle", entityId: cycleId, after: { topPercent, bottomPercent } });
}
```

- [ ] **Step 7: Run tests, expect pass.**
Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" npx vitest run src/modules/recruitment/services/route-thresholds.test.ts`
Expected: PASS (5 tests). Then `npx tsc --noEmit` clean.

- [ ] **Step 8: Commit.**
```bash
git add prisma/schema.prisma prisma/migrations/20260715010000_recruitment_route_thresholds src/modules/recruitment/services/route-thresholds.ts src/modules/recruitment/services/route-thresholds.test.ts
git commit -m "feat(recruitment): per-cycle speed-route thresholds"
```

---

### Task 2: Bucketing engine `bucketByPercentile`

**Files:**
- Create: `src/modules/recruitment/engine/route-buckets.ts`
- Test: `src/modules/recruitment/engine/route-buckets.test.ts`

**Interfaces:**
- Produces: `type RouteBucketItem = { applicationId: string; average: number | null }`; `type RouteBuckets = { top: string[]; middle: string[]; bottom: string[]; unscored: string[] }`; `bucketByPercentile(input: { items: RouteBucketItem[]; topPercent: number; bottomPercent: number }): RouteBuckets`.

- [ ] **Step 1: Write the failing tests.** Create `src/modules/recruitment/engine/route-buckets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bucketByPercentile } from "./route-buckets";

// Helper: build items from a list of averages; ids are "a0","a1",... in input order.
function items(avgs: (number | null)[]) {
  return avgs.map((average, i) => ({ applicationId: `a${i}`, average }));
}

describe("bucketByPercentile", () => {
  it("returns everything as middle when both percentages are 0", () => {
    const r = bucketByPercentile({ items: items([5, 4, 3, 2, 1]), topPercent: 0, bottomPercent: 0 });
    expect(r.top).toEqual([]);
    expect(r.bottom).toEqual([]);
    expect(r.middle).toHaveLength(5);
    expect(r.unscored).toEqual([]);
  });

  it("puts null-average items in unscored and excludes them from ranking", () => {
    const r = bucketByPercentile({ items: items([5, null, 1]), topPercent: 50, bottomPercent: 50 });
    expect(r.unscored).toEqual(["a1"]);
    expect(r.top).toEqual(["a0"]);
    expect(r.bottom).toEqual(["a2"]);
    expect(r.middle).toEqual([]);
  });

  it("buckets a clean spread of 10 by 20/30", () => {
    // sorted desc: 4.5,4.5,4.0,3.5,3.0,3.0,2.5,2.0,2.0,2.0
    const r = bucketByPercentile({
      items: items([4.5, 4.5, 4.0, 3.5, 3.0, 3.0, 2.5, 2.0, 2.0, 2.0]),
      topPercent: 20,
      bottomPercent: 30,
    });
    expect(r.top).toHaveLength(2); // both 4.5s
    expect(r.bottom).toHaveLength(3); // the three 2.0s
    expect(r.middle).toHaveLength(5);
  });

  it("never splits a tie: a boundary tie grows the top tier", () => {
    // 3,3,3,3,3,1 with top 20 / bottom 30: nominal top 1, but all five 3s tie.
    const r = bucketByPercentile({ items: items([3, 3, 3, 3, 3, 1]), topPercent: 20, bottomPercent: 30 });
    expect(r.top).toHaveLength(5);
    expect(r.bottom).toEqual(["a5"]); // only the 1
    expect(r.middle).toEqual([]);
  });

  it("spares a straddling tie at the reject line (favor the applicant)", () => {
    // 5,3,3,3,3,1 with top 20 / bottom 50: nominal bottom 3 lands inside the 3-tie
    // that also sits above the line, so the 3s move to middle and only the 1 is bottom.
    const r = bucketByPercentile({ items: items([5, 3, 3, 3, 3, 1]), topPercent: 20, bottomPercent: 50 });
    expect(r.top).toEqual(["a0"]);
    expect(r.bottom).toEqual(["a5"]);
    expect(r.middle).toHaveLength(4);
  });

  it("spares a bottom tie when the cut lands inside it, even at the minimum (favor the applicant)", () => {
    // 5,4,3,2,2,2 with top 20 / bottom 30: nominal bottom 2 lands INSIDE the 2.0 tie,
    // so the whole tie moves up to middle and nobody is auto-rejected. Contrast with
    // the 10-element clean spread above, where bottom 30 lands exactly at the tie edge.
    const r = bucketByPercentile({ items: items([5, 4, 3, 2, 2, 2]), topPercent: 20, bottomPercent: 30 });
    expect(r.top).toEqual(["a0"]);
    expect(r.bottom).toEqual([]);
    expect(r.middle).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("rejects nobody when every average is equal", () => {
    const r = bucketByPercentile({ items: items([3, 3, 3, 3]), topPercent: 20, bottomPercent: 30 });
    expect(r.top).toHaveLength(4);
    expect(r.bottom).toEqual([]);
    expect(r.middle).toEqual([]);
  });

  it("clamps so top and bottom never overlap on tiny N", () => {
    const r = bucketByPercentile({ items: items([5, 1]), topPercent: 50, bottomPercent: 50 });
    expect(r.top).toEqual(["a0"]);
    expect(r.bottom).toEqual(["a1"]);
    expect(r.middle).toEqual([]);
  });

  it("returns empty buckets for no scored items", () => {
    const r = bucketByPercentile({ items: items([null, null]), topPercent: 20, bottomPercent: 30 });
    expect(r.top).toEqual([]);
    expect(r.middle).toEqual([]);
    expect(r.bottom).toEqual([]);
    expect(r.unscored).toHaveLength(2);
  });

  it("orders each bucket by average descending, ties by id ascending", () => {
    const r = bucketByPercentile({ items: items([2, 5, 5, 1]), topPercent: 50, bottomPercent: 50 });
    // sorted desc, id asc on ties: a1(5), a2(5), a0(2), a3(1)
    expect(r.top).toEqual(["a1", "a2"]);
    expect(r.bottom).toEqual(["a0", "a3"]);
  });
});
```

- [ ] **Step 2: Run tests, expect failure.**
Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" npx vitest run src/modules/recruitment/engine/route-buckets.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Create `src/modules/recruitment/engine/route-buckets.ts`:

```ts
export type RouteBucketItem = { applicationId: string; average: number | null };
export type RouteBuckets = {
  top: string[];
  middle: string[];
  bottom: string[];
  unscored: string[]; // average == null; excluded from ranking
};

/** Partition applicants into top / middle / bottom by committee average using
 *  per-cycle percentile targets. Ties are never split: when a cut lands inside a
 *  tie, the whole tie resolves in the applicant's favor (into the higher tier).
 *  A tier can therefore exceed its nominal percentage; callers surface real counts. */
export function bucketByPercentile(input: {
  items: RouteBucketItem[];
  topPercent: number;
  bottomPercent: number;
}): RouteBuckets {
  const { items, topPercent, bottomPercent } = input;
  const unscored = items.filter((i) => i.average == null).map((i) => i.applicationId);
  const scored = items.filter(
    (i): i is { applicationId: string; average: number } => i.average != null,
  );
  const N = scored.length;
  if (N === 0) return { top: [], middle: [], bottom: [], unscored };

  // Sort by average desc; break ties by id asc (deterministic display order only;
  // tier membership below is defined purely by average value, never by index).
  const sorted = [...scored].sort(
    (a, b) => b.average - a.average || (a.applicationId < b.applicationId ? -1 : 1),
  );

  const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
  const topCount = clamp(Math.round((topPercent / 100) * N), 0, N);
  const bottomCount = clamp(Math.round((bottomPercent / 100) * N), 0, N - topCount);

  const topSet = new Set<string>();
  if (topCount > 0) {
    const topThreshold = sorted[topCount - 1].average;
    for (const s of sorted) if (s.average >= topThreshold) topSet.add(s.applicationId);
  }

  const bottomSet = new Set<string>();
  if (bottomCount > 0) {
    const boundaryVal = sorted[N - bottomCount].average;
    const aboveIdx = N - bottomCount - 1;
    // The applicant just above the reject line, unless that slot is already in top.
    const aboveVal =
      aboveIdx >= 0 && !topSet.has(sorted[aboveIdx].applicationId) ? sorted[aboveIdx].average : null;
    // Straddle: the boundary value also appears above the line, so spare the whole
    // tie (exclusive cut). Otherwise the boundary tie is clean (inclusive cut).
    const straddle = aboveVal != null && aboveVal === boundaryVal;
    for (const s of sorted) {
      if (topSet.has(s.applicationId)) continue;
      if (straddle ? s.average < boundaryVal : s.average <= boundaryVal) {
        bottomSet.add(s.applicationId);
      }
    }
  }

  const top: string[] = [];
  const middle: string[] = [];
  const bottom: string[] = [];
  for (const s of sorted) {
    if (topSet.has(s.applicationId)) top.push(s.applicationId);
    else if (bottomSet.has(s.applicationId)) bottom.push(s.applicationId);
    else middle.push(s.applicationId);
  }
  return { top, middle, bottom, unscored };
}
```

- [ ] **Step 4: Run tests, expect pass.**
Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" npx vitest run src/modules/recruitment/engine/route-buckets.test.ts`
Expected: PASS (10 tests). Then `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/engine/route-buckets.ts src/modules/recruitment/engine/route-buckets.test.ts
git commit -m "feat(recruitment): percentile bucketing engine for speed route"
```

---

### Task 3: `rejectApplication` + `reopenDecision`

**Files:**
- Modify: `src/modules/recruitment/services/routing.ts` (append two functions)
- Test: `src/modules/recruitment/services/routing.test.ts` (append two describe blocks; reuse the file's existing `seed()`)

**Interfaces:**
- Consumes: `prisma`, `can`, `recordAudit`, `RecruitmentAuthError`/`AcceptanceError` (from `./review`), existing `RoutingError`.
- Produces: `rejectApplication(applicationId: string, actorId: string, notes: string | null): Promise<Application>`; `reopenDecision(applicationId: string, actorId: string): Promise<Application>`.

- [ ] **Step 1: Write the failing tests.** Append to `src/modules/recruitment/services/routing.test.ts`. First add `rejectApplication, reopenDecision` to the existing import from `./routing` at the top (line 5 currently `import { routeApplication, decideRoutedApplication, RoutingError } from "./routing";` becomes:

```ts
import { routeApplication, decideRoutedApplication, rejectApplication, reopenDecision, RoutingError } from "./routing";
```

Then append these describe blocks at the end of the file:

```ts
describe("rejectApplication", () => {
  it("rejects an unrouted application: sets decision REJECT, no acceptance, audits", async () => {
    const { lead, application } = await seed();
    const rejected = await rejectApplication(application.id, lead.id, "not a fit");
    expect(rejected.decision).toBe("REJECT");
    expect(rejected.routedDepartmentCode).toBeNull();
    expect(rejected.decisionNotes).toBe("not a fit");
    expect(await prisma.acceptance.count({ where: { applicationId: application.id } })).toBe(0);
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.application_reject" } });
    expect(audit).not.toBeNull();
  });

  it("rejects a non-lead", async () => {
    const { other, application } = await seed();
    await expect(rejectApplication(application.id, other.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("blocks self-reject (separation of duties)", async () => {
    const { lead, application } = await seed();
    await prisma.applicant.update({ where: { id: application.applicantId }, data: { applicantPersonId: lead.id } });
    await expect(rejectApplication(application.id, lead.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("clears a stale not-emailed acceptance so release can't still email it", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await decideRoutedApplication(application.id, "ACCEPT", lead.id, null);
    const rejected = await rejectApplication(application.id, lead.id, null);
    expect(rejected.decision).toBe("REJECT");
    expect(await prisma.acceptance.count({ where: { applicationId: application.id } })).toBe(0);
  });

  it("refuses to reject once an acceptance was emailed", async () => {
    const { lead, application } = await seed();
    await routeApplication(application.id, "EDUC", lead.id);
    await decideRoutedApplication(application.id, "ACCEPT", lead.id, null);
    await prisma.acceptance.updateMany({ where: { applicationId: application.id }, data: { emailedAt: new Date() } });
    await expect(rejectApplication(application.id, lead.id, null)).rejects.toBeInstanceOf(AcceptanceError);
  });

  it("rejects a director-track application (routing is volunteer-only)", async () => {
    const { lead } = await seed();
    const term = await prisma.term.findFirstOrThrow();
    const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "drej", departments: ["EDUC"], createdById: lead.id, status: "OPEN" } });
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "D", lastName: "R", email: "drej@y.edu", emailLower: "drej@y.edu" } });
    const app = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
    await expect(rejectApplication(app.id, lead.id, null)).rejects.toBeInstanceOf(RoutingError);
  });
});

describe("reopenDecision", () => {
  it("reopens a reject back to PENDING and audits", async () => {
    const { lead, application } = await seed();
    await rejectApplication(application.id, lead.id, "no");
    const reopened = await reopenDecision(application.id, lead.id);
    expect(reopened.decision).toBe("PENDING");
    expect(reopened.decidedAt).toBeNull();
    expect(reopened.decisionNotes).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.application_reopen" } });
    expect(audit).not.toBeNull();
  });

  it("rejects a non-lead", async () => {
    const { lead, other, application } = await seed();
    await rejectApplication(application.id, lead.id, null);
    await expect(reopenDecision(application.id, other.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("is blocked after the cycle's decisions were released", async () => {
    const { lead, application } = await seed();
    await rejectApplication(application.id, lead.id, null);
    await prisma.recruitmentCycle.update({ where: { id: application.cycleId }, data: { decisionsReleasedAt: new Date() } });
    await expect(reopenDecision(application.id, lead.id)).rejects.toBeInstanceOf(AcceptanceError);
  });
});
```

- [ ] **Step 2: Run the new tests, expect failure.**
Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" npx vitest run src/modules/recruitment/services/routing.test.ts`
Expected: FAIL (`rejectApplication`/`reopenDecision` not exported).

- [ ] **Step 3: Implement.** Append to `src/modules/recruitment/services/routing.ts` (after `decideRoutedApplication`). The file already imports `Application`, `prisma`, `can`, `recordAudit`, and `reviewScope, RecruitmentAuthError, AcceptanceError` from `./review`.

```ts
/** Reject a VOLUNTEER application without routing it (bottom-tier speed route, or
 *  a standalone SRR reject). Sets Application.decision = REJECT with no Acceptance
 *  and leaves routedDepartmentCode as-is. A prior not-emailed acceptance is torn
 *  down so releaseDecisions can't still email it. No email fires here; reversible
 *  via reopenDecision until an acceptance is emailed or decisions are released. */
export async function rejectApplication(
  applicationId: string,
  actorId: string,
  notes: string | null,
): Promise<Application> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't reject applications.");
  }
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: {
      cycle: { select: { track: true } },
      applicant: { select: { applicantPersonId: true } },
      acceptances: { select: { emailedAt: true, contract: { select: { id: true } } } },
    },
  });
  if (!app) throw new RoutingError("Application not found.");
  if (app.status !== "SUBMITTED") throw new RoutingError("This application hasn't been submitted yet.");
  if (app.cycle.track !== "VOLUNTEER") throw new RoutingError("Routing applies to volunteer cycles.");
  // Separation of duties: a signed-in applicant who reviews must not decide their own.
  if (app.applicant.applicantPersonId && app.applicant.applicantPersonId === actorId) {
    throw new RecruitmentAuthError("You can't decide your own application.");
  }
  // An emailed acceptance or an onboarding contract must be torn down first (mirrors
  // decideRoutedApplication / revokeAcceptance): rejecting under it would leave the
  // applicant emailed-accepted-yet-rejected, or destroy onboarding data on cascade.
  if (app.acceptances.some((a) => a.emailedAt != null || a.contract != null)) {
    throw new AcceptanceError("This applicant has an emailed acceptance or onboarding contract. Resolve that before rejecting.");
  }
  const updated = await prisma.$transaction(async (tx) => {
    // Remaining acceptances are not-emailed and contract-free (guarded above); drop
    // them so a stale ACCEPT can't survive a REJECT.
    await tx.acceptance.deleteMany({ where: { applicationId, emailedAt: null } });
    return tx.application.update({
      where: { id: applicationId },
      data: { decision: "REJECT", decidedById: actorId, decidedAt: new Date(), decisionNotes: notes },
    });
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.application_reject", entityType: "Application", entityId: applicationId, after: { decision: "REJECT" } });
  return updated;
}

/** Reverse a not-emailed decision (typically a speed-route reject) back to PENDING.
 *  Leaves any routing intact. Blocked once the applicant was emailed an acceptance
 *  or the cycle's decisions were released. */
export async function reopenDecision(applicationId: string, actorId: string): Promise<Application> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't reopen decisions.");
  }
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { cycle: { select: { decisionsReleasedAt: true } }, acceptances: { select: { emailedAt: true } } },
  });
  if (!app) throw new RoutingError("Application not found.");
  if (app.cycle.decisionsReleasedAt) throw new AcceptanceError("Decisions were already released; reopening is blocked.");
  if (app.acceptances.some((a) => a.emailedAt != null)) throw new AcceptanceError("This applicant was already emailed; reopening is blocked.");
  const updated = await prisma.application.update({
    where: { id: applicationId },
    data: { decision: "PENDING", decidedById: null, decidedAt: null, decisionNotes: null },
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.application_reopen", entityType: "Application", entityId: applicationId, after: { decision: "PENDING" } });
  return updated;
}
```

- [ ] **Step 4: Run tests, expect pass.**
Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" npx vitest run src/modules/recruitment/services/routing.test.ts`
Expected: PASS (existing routing tests plus the 9 new ones). Then `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/services/routing.ts src/modules/recruitment/services/routing.test.ts
git commit -m "feat(recruitment): reject-without-routing + reopen decision"
```

---

### Task 4: Batch `applyTierRoutes` + `applyTierRejects`

**Files:**
- Modify: `src/modules/recruitment/services/routing.ts` (append two functions + one type)
- Test: `src/modules/recruitment/services/routing.test.ts` (append one describe block)

**Interfaces:**
- Consumes: `routeApplication`, `rejectApplication` (Task 3), `can`, `RecruitmentAuthError`/`AcceptanceError`, `RoutingError`.
- Produces: `type BatchResult = { applied: number; skipped: { applicationId: string; reason: string }[] }`; `applyTierRoutes(entries: { applicationId: string; departmentCode: string }[], actorId: string): Promise<BatchResult>`; `applyTierRejects(applicationIds: string[], actorId: string, notes: string | null): Promise<BatchResult>`.

Note: these are thin wrappers that reuse the single-row functions per row so guards cannot drift. Permission is checked once up front (a fast fail), then each row re-checks inside its single-row call. One bad row is skipped with its reason, never aborting the batch. (The spec listed a `cycleId` parameter; it is dropped as redundant, since each single-row call already validates the application's own cycle track and departments and the actor holds review_all.)

- [ ] **Step 1: Write the failing tests.** Add `applyTierRoutes, applyTierRejects` to the `./routing` import, and append:

```ts
describe("applyTierRoutes / applyTierRejects", () => {
  async function twoApps(leadId: string, cycleId: string) {
    const mk = async (n: string) => {
      const applicant = await prisma.applicant.create({ data: { cycleId, firstName: n, lastName: "X", email: `${n}@y.edu`, emailLower: `${n}@y.edu` } });
      return prisma.application.create({ data: { cycleId, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
    };
    return { a: await mk("one"), b: await mk("two") };
  }

  it("routes every entry and reports the count", async () => {
    const { lead, application } = await seed();
    const { a, b } = await twoApps(lead.id, application.cycleId);
    const res = await applyTierRoutes(
      [{ applicationId: a.id, departmentCode: "EDUC" }, { applicationId: b.id, departmentCode: "MDIC" }],
      lead.id,
    );
    expect(res.applied).toBe(2);
    expect(res.skipped).toEqual([]);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: a.id } })).routedDepartmentCode).toBe("EDUC");
    expect((await prisma.application.findUniqueOrThrow({ where: { id: b.id } })).routedDepartmentCode).toBe("MDIC");
  });

  it("skips a bad entry with a reason and still routes the rest", async () => {
    const { lead, application } = await seed();
    const { a, b } = await twoApps(lead.id, application.cycleId);
    const res = await applyTierRoutes(
      [{ applicationId: a.id, departmentCode: "EDUC" }, { applicationId: b.id, departmentCode: "NOPE" }],
      lead.id,
    );
    expect(res.applied).toBe(1);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].applicationId).toBe(b.id);
  });

  it("rejects a whole batch of applicants and reports the count", async () => {
    const { lead, application } = await seed();
    const { a, b } = await twoApps(lead.id, application.cycleId);
    const res = await applyTierRejects([a.id, b.id], lead.id, null);
    expect(res.applied).toBe(2);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: a.id } })).decision).toBe("REJECT");
  });

  it("fails fast for a non-lead (permission checked once)", async () => {
    const { lead, other, application } = await seed();
    const { a } = await twoApps(lead.id, application.cycleId);
    await expect(applyTierRoutes([{ applicationId: a.id, departmentCode: "EDUC" }], other.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
    await expect(applyTierRejects([a.id], other.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });
});
```

- [ ] **Step 2: Run tests, expect failure.**
Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" npx vitest run src/modules/recruitment/services/routing.test.ts`
Expected: FAIL (`applyTierRoutes`/`applyTierRejects` not exported).

- [ ] **Step 3: Implement.** Append to `src/modules/recruitment/services/routing.ts`:

```ts
export type BatchResult = { applied: number; skipped: { applicationId: string; reason: string }[] };

/** Batch-route a set of applications (speed-route "apply top tier"). Reuses
 *  routeApplication per row so guards never drift; a row that fails a guard is
 *  skipped with its reason rather than aborting the batch. Permission is checked
 *  once up front so a non-lead fails fast. */
export async function applyTierRoutes(
  entries: { applicationId: string; departmentCode: string }[],
  actorId: string,
): Promise<BatchResult> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't route applications.");
  }
  const skipped: { applicationId: string; reason: string }[] = [];
  let applied = 0;
  for (const e of entries) {
    try {
      await routeApplication(e.applicationId, e.departmentCode, actorId);
      applied += 1;
    } catch (err) {
      if (err instanceof RoutingError || err instanceof AcceptanceError || err instanceof RecruitmentAuthError) {
        skipped.push({ applicationId: e.applicationId, reason: err.message });
      } else throw err;
    }
  }
  return { applied, skipped };
}

/** Batch-reject a set of applications (speed-route "apply bottom tier"). Reuses
 *  rejectApplication per row with the same skip-with-reason semantics. */
export async function applyTierRejects(
  applicationIds: string[],
  actorId: string,
  notes: string | null,
): Promise<BatchResult> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't reject applications.");
  }
  const skipped: { applicationId: string; reason: string }[] = [];
  let applied = 0;
  for (const id of applicationIds) {
    try {
      await rejectApplication(id, actorId, notes);
      applied += 1;
    } catch (err) {
      if (err instanceof RoutingError || err instanceof AcceptanceError || err instanceof RecruitmentAuthError) {
        skipped.push({ applicationId: id, reason: err.message });
      } else throw err;
    }
  }
  return { applied, skipped };
}
```

- [ ] **Step 4: Run tests, expect pass.**
Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" npx vitest run src/modules/recruitment/services/routing.test.ts`
Expected: PASS. Then `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/services/routing.ts src/modules/recruitment/services/routing.test.ts
git commit -m "feat(recruitment): batch tier route/reject for speed route"
```

---

### Task 5: `loadSpeedRouteBoard`

**Files:**
- Create: `src/modules/recruitment/services/speed-route.ts`
- Test: `src/modules/recruitment/services/speed-route.test.ts`

**Interfaces:**
- Consumes: `prisma`, `can`, `reviewScope`/`RecruitmentAuthError` (from `./review`), `RoutingError` (from `./routing`), `scoreAverage` (from `../engine/scoring`), `bucketByPercentile` (Task 2), `applicationStage`/`ApplicationStage` (from `../engine/application-stage`).
- Produces: `type SpeedRouteRow`, `type SpeedRouteBoard`, `loadSpeedRouteBoard(cycleId: string, viewerId: string): Promise<SpeedRouteBoard>` (types exactly as written in Step 3).

- [ ] **Step 1: Write the failing test.** Create `src/modules/recruitment/services/speed-route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { RoutingError } from "./routing";
import { loadSpeedRouteBoard } from "./speed-route";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  await prisma.department.create({ data: { code: "MDIC", name: "Medical" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const other = await prisma.person.create({ data: { name: "Other", status: "ACTIVE" } });
  const scorer = await prisma.person.create({ data: { name: "Scorer", status: "ACTIVE" } });
  const srr = await prisma.role.create({ data: { name: "SRR", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: srr.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC", "MDIC"], createdById: lead.id, status: "OPEN", routeTopPercent: 20, routeBottomPercent: 30 } });
  // Five submitted applicants; score four with distinct averages, leave one unscored.
  const scores = [5, 4, 3, 1, null] as const;
  const apps: string[] = [];
  for (let i = 0; i < scores.length; i++) {
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: `A${i}`, lastName: "B", email: `a${i}@y.edu`, emailLower: `a${i}@y.edu` } });
    const app = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
    if (scores[i] != null) await prisma.committeeScore.create({ data: { applicationId: app.id, scorerId: scorer.id, score: scores[i]! } });
    apps.push(app.id);
  }
  return { lead, other, cycle, apps };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("loadSpeedRouteBoard", () => {
  it("buckets scored applicants and lists the unscored separately", async () => {
    const { lead, cycle } = await seed();
    const board = await loadSpeedRouteBoard(cycle.id, lead.id);
    expect(board.topPercent).toBe(20);
    expect(board.bottomPercent).toBe(30);
    // N=4 scored -> top 1 (avg 5), bottom 1 (avg 1), middle 2 (avg 4 and 3).
    expect(board.top).toHaveLength(1);
    expect(board.top[0].average).toBe(5);
    expect(board.bottom).toHaveLength(1);
    expect(board.bottom[0].average).toBe(1);
    expect(board.middle).toHaveLength(2);
    expect(board.unscored).toHaveLength(1);
    expect(board.unscored[0].average).toBeNull();
  });

  it("proposes the applicant's first ranked choice when it is a cycle department", async () => {
    const { lead, cycle } = await seed();
    const board = await loadSpeedRouteBoard(cycle.id, lead.id);
    expect(board.top[0].proposedDepartmentCode).toBe("EDUC");
  });

  it("proposes null when the first ranked choice is not a cycle department", async () => {
    const { lead, cycle, apps } = await seed();
    await prisma.application.update({ where: { id: apps[0] }, data: { departmentChoices: ["GONE"] } });
    const board = await loadSpeedRouteBoard(cycle.id, lead.id);
    const row = [...board.top, ...board.middle, ...board.bottom].find((r) => r.applicationId === apps[0]);
    expect(row?.proposedDepartmentCode).toBeNull();
  });

  it("rejects a viewer without review_all", async () => {
    const { other, cycle } = await seed();
    await expect(loadSpeedRouteBoard(cycle.id, other.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("rejects a director-track cycle", async () => {
    const { lead } = await seed();
    const term = await prisma.term.findFirstOrThrow();
    const dir = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "dboard", departments: ["EDUC"], createdById: lead.id, status: "OPEN" } });
    await expect(loadSpeedRouteBoard(dir.id, lead.id)).rejects.toBeInstanceOf(RoutingError);
  });
});
```

- [ ] **Step 2: Run test, expect failure.**
Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" npx vitest run src/modules/recruitment/services/speed-route.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Create `src/modules/recruitment/services/speed-route.ts`:

```ts
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { RecruitmentAuthError } from "./review";
import { RoutingError } from "./routing";
import { scoreAverage } from "../engine/scoring";
import { bucketByPercentile } from "../engine/route-buckets";
import { applicationStage, type ApplicationStage } from "../engine/application-stage";

export type SpeedRouteRow = {
  applicationId: string;
  name: string;
  average: number | null;
  scoreCount: number;
  departmentChoices: string[];
  proposedDepartmentCode: string | null; // departmentChoices[0] if it is a cycle department, else null
  routedDepartmentCode: string | null;
  decision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST";
  stage: ApplicationStage;
  acceptanceEmailed: boolean;
};

export type SpeedRouteBoard = {
  cycleId: string;
  title: string;
  track: string;
  departments: string[];
  topPercent: number;
  bottomPercent: number;
  top: SpeedRouteRow[];
  middle: SpeedRouteRow[];
  bottom: SpeedRouteRow[];
  unscored: SpeedRouteRow[];
};

/** Assemble the speed-route board: every SUBMITTED application bucketed by
 *  committee average into top/middle/bottom (unscored listed apart), each row
 *  carrying its current routing/decision state and a proposed department. */
export async function loadSpeedRouteBoard(cycleId: string, viewerId: string): Promise<SpeedRouteBoard> {
  if (!(await can(viewerId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't route applications.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { id: cycleId },
    select: { id: true, title: true, track: true, departments: true, routeTopPercent: true, routeBottomPercent: true },
  });
  if (!cycle) throw new RoutingError("Cycle not found.");
  if (cycle.track !== "VOLUNTEER") throw new RoutingError("Speed route applies to volunteer cycles.");

  const apps = await prisma.application.findMany({
    where: { cycleId, status: "SUBMITTED" },
    include: {
      applicant: { select: { firstName: true, lastName: true } },
      committeeScores: { select: { score: true } },
      acceptances: { select: { emailedAt: true } },
      interviews: { select: { decision: true } },
    },
  });

  const deptSet = new Set(cycle.departments);
  const byId = new Map<string, SpeedRouteRow>();
  const bucketItems = apps.map((a) => {
    const { average, count } = scoreAverage(a.committeeScores.map((s) => s.score));
    const first = a.departmentChoices[0] ?? null;
    const row: SpeedRouteRow = {
      applicationId: a.id,
      name: `${a.applicant.firstName} ${a.applicant.lastName}`,
      average,
      scoreCount: count,
      departmentChoices: a.departmentChoices,
      proposedDepartmentCode: first && deptSet.has(first) ? first : null,
      routedDepartmentCode: a.routedDepartmentCode,
      decision: a.decision,
      stage: applicationStage({
        scoreCount: a.committeeScores.length,
        routedDepartmentCode: a.routedDepartmentCode,
        applicationDecision: a.decision,
        interviews: a.interviews,
      }),
      acceptanceEmailed: a.acceptances.some((x) => x.emailedAt != null),
    };
    byId.set(a.id, row);
    return { applicationId: a.id, average };
  });

  const buckets = bucketByPercentile({
    items: bucketItems,
    topPercent: cycle.routeTopPercent,
    bottomPercent: cycle.routeBottomPercent,
  });
  const rows = (ids: string[]) => ids.map((id) => byId.get(id)!);
  return {
    cycleId: cycle.id,
    title: cycle.title,
    track: cycle.track,
    departments: cycle.departments,
    topPercent: cycle.routeTopPercent,
    bottomPercent: cycle.routeBottomPercent,
    top: rows(buckets.top),
    middle: rows(buckets.middle),
    bottom: rows(buckets.bottom),
    unscored: rows(buckets.unscored),
  };
}
```

- [ ] **Step 4: Run test, expect pass.**
Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute" npx vitest run src/modules/recruitment/services/speed-route.test.ts`
Expected: PASS (5 tests). Then `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/services/speed-route.ts src/modules/recruitment/services/speed-route.test.ts
git commit -m "feat(recruitment): speed-route board service"
```

---

### Task 6: Speed-route server actions

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/speed-route/actions.ts`

**Interfaces:**
- Consumes: `requirePersonSession`; `routeApplication`, `rejectApplication`, `reopenDecision`, `applyTierRoutes`, `applyTierRejects`, `RoutingError`, `BatchResult` (routing.ts); `setRouteThresholds`, `RouteThresholdError` (route-thresholds.ts); `RecruitmentAuthError`, `AcceptanceError` (review.ts).
- Produces (all imported by later UI tasks):
  - `speedRouteRouteAction(applicationId: string, departmentCode: string): Promise<{ error?: string }>`
  - `speedRouteRejectAction(applicationId: string, notes?: string | null): Promise<{ error?: string }>` (notes optional so the action is assignable to the board/modal `onReject: (applicationId: string) => ...` prop)
  - `speedRouteReopenAction(applicationId: string): Promise<{ error?: string }>`
  - `applyTopTierAction(entries: { applicationId: string; departmentCode: string }[]): Promise<BatchResult | { error: string }>`
  - `applyBottomTierAction(applicationIds: string[]): Promise<BatchResult | { error: string }>`
  - `setRouteThresholdsAction(cycleId: string, formData: FormData): Promise<void>`

There is no unit test for this task (thin server-action adapters over already-tested services, following the speed-score `actions.ts` precedent). It is verified by `tsc` + `eslint` and exercised by the Task 11 e2e.

- [ ] **Step 1: Implement.** Create `src/app/(app)/recruitment/cycles/[id]/speed-route/actions.ts`:

```ts
"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";
import {
  routeApplication,
  rejectApplication,
  reopenDecision,
  applyTierRoutes,
  applyTierRejects,
  RoutingError,
  type BatchResult,
} from "@/modules/recruitment/services/routing";
import { setRouteThresholds, RouteThresholdError } from "@/modules/recruitment/services/route-thresholds";

function messageIfKnown(err: unknown): string | null {
  if (err instanceof RecruitmentAuthError || err instanceof RoutingError || err instanceof AcceptanceError) {
    return err.message;
  }
  return null;
}

export async function speedRouteRouteAction(applicationId: string, departmentCode: string): Promise<{ error?: string }> {
  const person = await requirePersonSession();
  try {
    await routeApplication(applicationId, departmentCode, person.personId);
    return {};
  } catch (err) {
    const m = messageIfKnown(err);
    if (m) return { error: m };
    throw err;
  }
}

export async function speedRouteRejectAction(applicationId: string, notes: string | null = null): Promise<{ error?: string }> {
  const person = await requirePersonSession();
  try {
    await rejectApplication(applicationId, person.personId, notes && notes.trim() ? notes.trim() : null);
    return {};
  } catch (err) {
    const m = messageIfKnown(err);
    if (m) return { error: m };
    throw err;
  }
}

export async function speedRouteReopenAction(applicationId: string): Promise<{ error?: string }> {
  const person = await requirePersonSession();
  try {
    await reopenDecision(applicationId, person.personId);
    return {};
  } catch (err) {
    const m = messageIfKnown(err);
    if (m) return { error: m };
    throw err;
  }
}

export async function applyTopTierAction(
  entries: { applicationId: string; departmentCode: string }[],
): Promise<BatchResult | { error: string }> {
  const person = await requirePersonSession();
  try {
    return await applyTierRoutes(entries, person.personId);
  } catch (err) {
    const m = messageIfKnown(err);
    if (m) return { error: m };
    throw err;
  }
}

export async function applyBottomTierAction(applicationIds: string[]): Promise<BatchResult | { error: string }> {
  const person = await requirePersonSession();
  try {
    return await applyTierRejects(applicationIds, person.personId, null);
  } catch (err) {
    const m = messageIfKnown(err);
    if (m) return { error: m };
    throw err;
  }
}

export async function setRouteThresholdsAction(cycleId: string, formData: FormData): Promise<void> {
  const person = await requirePersonSession();
  const top = Number(formData.get("topPercent"));
  const bottom = Number(formData.get("bottomPercent"));
  const base = `/recruitment/cycles/${cycleId}/speed-route`;
  try {
    await setRouteThresholds(cycleId, top, bottom, person.personId);
  } catch (err) {
    if (err instanceof RouteThresholdError || err instanceof RecruitmentAuthError) {
      redirect(`${base}?error=${encodeURIComponent((err as Error).message)}`);
    }
    throw err;
  }
  revalidatePath(base);
}
```

- [ ] **Step 2: Verify tsc + eslint.**
Run: `npx tsc --noEmit && npx eslint src/app/\(app\)/recruitment/cycles/\[id\]/speed-route/actions.ts`
Expected: no output (clean). If eslint reports an unused `AcceptanceError` import, keep it (it is referenced in `messageIfKnown`).

- [ ] **Step 3: Commit.**
```bash
git add "src/app/(app)/recruitment/cycles/[id]/speed-route/actions.ts"
git commit -m "feat(recruitment): speed-route server actions"
```

---

### Task 7: `SpeedRouteModal` keyboard queue

**Files:**
- Create: `src/modules/recruitment/components/speed-route-modal.tsx`

**Interfaces:**
- Consumes: `Modal`, `Button`, `Badge`, `Alert`, `Spinner`, `Checkbox`; `SpeedRouteRow` (from `@/modules/recruitment/services/speed-route`).
- Produces: `SpeedRouteModal` component with props:

```ts
type SpeedRouteModalProps = {
  open: boolean;
  onClose: () => void;
  rows: SpeedRouteRow[]; // the middle tier (or any tier) to route
  departments: string[]; // cycle departments (labels for the ranked picks)
  onRoute: (applicationId: string, departmentCode: string) => Promise<{ error?: string }>;
  onReject: (applicationId: string) => Promise<{ error?: string }>;
};
```

Model this on `speed-score-modal.tsx`: frozen `useState` snapshot of `rows`, a `keepIdRef` to preserve the current applicant across the show-decided toggle, immediate write then advance, and the same lint patterns. There is no lazy load or prefetch here (all row data is already present). "Undecided" = `decision === "PENDING" && routedDepartmentCode == null` and not yet acted on this session. Number keys `1..k` route to the k-th ranked department; `R` rejects; arrows navigate; `Esc` closes. This task is verified by `tsc` + `eslint`; behavior is covered by the Task 11 e2e.

- [ ] **Step 1: Implement.** Create `src/modules/recruitment/components/speed-route-modal.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Modal } from "@/platform/ui/modal";
import { Button } from "@/platform/ui/button";
import { Badge } from "@/platform/ui/badge";
import { Alert } from "@/platform/ui/alert";
import { Spinner } from "@/platform/ui/spinner";
import { Checkbox } from "@/platform/ui/checkbox";
import type { SpeedRouteRow } from "@/modules/recruitment/services/speed-route";

type SpeedRouteModalProps = {
  open: boolean;
  onClose: () => void;
  rows: SpeedRouteRow[];
  departments: string[];
  onRoute: (applicationId: string, departmentCode: string) => Promise<{ error?: string }>;
  onReject: (applicationId: string) => Promise<{ error?: string }>;
};

export function SpeedRouteModal({ open, onClose, rows, departments, onRoute, onReject }: SpeedRouteModalProps) {
  // Freeze the row set at open so live routing never reindexes the queue.
  const [snapshot] = useState(() => rows);
  const [includeDecided, setIncludeDecided] = useState(false);
  const [index, setIndex] = useState(0);
  // Ids acted on this session (routed or rejected); they stay in the queue and we
  // advance past them by index, mirroring speed-score's liveScores.
  const [acted, setActed] = useState<Record<string, true>>({});
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();
  // Applicant to keep in view across a show-decided toggle.
  const keepIdRef = useRef<string | null>(null);

  // Queue basis is the FROZEN snapshot, never `acted`: like speed-score, a row that
  // was undecided at open stays in the queue after you handle it (snapshot.decision
  // is frozen), so the queue identity is stable and you advance past it by index.
  // Depending on `acted` here would recompute the queue on every action and make the
  // reposition effect below reset the index to 0 instead of advancing.
  const queue = useMemo(
    () => (includeDecided ? snapshot : snapshot.filter((r) => r.decision === "PENDING" && r.routedDepartmentCode == null)),
    [snapshot, includeDecided],
  );

  // Reset position when the queue basis changes; preserve the toggled-from applicant.
  useEffect(() => {
    const keepId = keepIdRef.current;
    keepIdRef.current = null;
    const pos = keepId ? queue.findIndex((q) => q.applicationId === keepId) : -1;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reposition when the queue basis (open / show-decided) changes
    setIndex(pos >= 0 ? pos : 0);
  }, [queue]);

  const total = snapshot.length;
  const handledCount = Object.keys(acted).length;
  const current = index < queue.length ? queue[index] : null;
  const done = current == null;

  const goTo = useCallback((next: number) => setIndex(() => Math.min(Math.max(0, next), queue.length)), [queue.length]);

  const routeTo = useCallback(
    (departmentCode: string) => {
      if (!current || isSaving) return;
      const id = current.applicationId;
      setError(null);
      startSave(async () => {
        const res = await onRoute(id, departmentCode);
        if (res?.error) { setError(res.error); return; }
        setActed((p) => ({ ...p, [id]: true }));
        setIndex((i) => i + 1);
      });
    },
    [current, isSaving, onRoute],
  );

  const rejectCurrent = useCallback(() => {
    if (!current || isSaving) return;
    const id = current.applicationId;
    setError(null);
    startSave(async () => {
      const res = await onReject(id);
      if (res?.error) { setError(res.error); return; }
      setActed((p) => ({ ...p, [id]: true }));
      setIndex((i) => i + 1);
    });
  }, [current, isSaving, onReject]);

  // Ranked departments that are real cycle departments, in the applicant's order.
  const rankedDepts = useMemo(() => {
    if (!current) return [];
    const set = new Set(departments);
    return current.departmentChoices.filter((d) => set.has(d)).slice(0, 9);
  }, [current, departments]);

  // Keyboard: number keys route to the k-th ranked dept; R rejects; arrows navigate.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (done || isSaving) return;
      if (e.key >= "1" && e.key <= "9") {
        const i = Number(e.key) - 1;
        if (i < rankedDepts.length) { e.preventDefault(); routeTo(rankedDepts[i]); }
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        rejectCurrent();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goTo(index + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goTo(index - 1);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, done, isSaving, index, rankedDepts, routeTo, rejectCurrent, goTo]);

  function toggleShowDecided(next: boolean) {
    keepIdRef.current = current?.applicationId ?? null;
    setIncludeDecided(next);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="large"
      title={done ? "Route the middle" : `${current!.name}  (${index + 1} of ${queue.length})`}
      footer={
        done ? (
          <Button type="button" variant="primary" size="sm" onClick={onClose}>Close</Button>
        ) : (
          <div className="flex w-full flex-wrap items-center gap-1.5">
            {rankedDepts.map((d, i) => (
              <Button key={d} type="button" size="sm" variant="outline" disabled={isSaving} onClick={() => routeTo(d)}>
                {i + 1}. {d}
              </Button>
            ))}
            <Button type="button" size="sm" variant="danger" disabled={isSaving} onClick={rejectCurrent}>Reject (R)</Button>
            {isSaving && <Spinner size="sm" className="ml-1 text-muted-foreground" />}
          </div>
        )
      }
    >
      {done ? (
        <div className="space-y-3 py-6 text-center">
          <p className="text-lg font-semibold text-foreground">Middle tier cleared.</p>
          <p className="text-sm text-muted-foreground">You handled {handledCount} of {total} applicants.</p>
          {!includeDecided && handledCount < total && (
            <Button type="button" variant="outline" size="sm" onClick={() => toggleShowDecided(true)}>Review handled applicants</Button>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge>{current!.average != null ? `avg ${current!.average.toFixed(1)} · ${current!.scoreCount}` : "unscored"}</Badge>
            <span className="text-muted-foreground">Ranked: {current!.departmentChoices.join(", ") || "(none)"}</span>
            <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox checked={includeDecided} onChange={(e) => toggleShowDecided(e.target.checked)} />
              Show handled
            </label>
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          {rankedDepts.length === 0 && (
            <Alert tone="warning">This applicant ranked no cycle department. Reject, skip, or route from the board.</Alert>
          )}
          <p className="text-xs text-subtle-foreground">
            Press 1-{Math.max(rankedDepts.length, 1)} to route to a ranked department, R to reject, Left/Right to move, Esc to close.
          </p>
        </div>
      )}
    </Modal>
  );
}
```

- [ ] **Step 2: Verify tsc + eslint.**
Run: `npx tsc --noEmit && npx eslint src/modules/recruitment/components/speed-route-modal.tsx`
Expected: clean. Keep only the one `eslint-disable-next-line` shown (reposition effect); remove any that eslint reports as unused.

- [ ] **Step 3: Commit.**
```bash
git add src/modules/recruitment/components/speed-route-modal.tsx
git commit -m "feat(recruitment): keyboard queue for routing the middle tier"
```

---

### Task 8: `SpeedRouteBoard`

**Files:**
- Create: `src/modules/recruitment/components/speed-route-board.tsx`

**Interfaces:**
- Consumes: `SpeedRouteBoard`, `SpeedRouteRow` (speed-route service); `BatchResult` (routing.ts); `SpeedRouteModal` (Task 7); `Button`, `Select`, `Alert`, `Badge`, `Table`/`THead`/`TR`/`TH`/`TD`, `Card`, `SectionHeader`; the six actions from Task 6 (passed as props).
- Produces: `SpeedRouteBoard` component with props:

```ts
type Props = {
  board: SpeedRouteBoard;
  onRoute: (applicationId: string, departmentCode: string) => Promise<{ error?: string }>;
  onReject: (applicationId: string) => Promise<{ error?: string }>;
  onReopen: (applicationId: string) => Promise<{ error?: string }>;
  onApplyTop: (entries: { applicationId: string; departmentCode: string }[]) => Promise<BatchResult | { error: string }>;
  onApplyBottom: (applicationIds: string[]) => Promise<BatchResult | { error: string }>;
};
```

Verified by `tsc` + `eslint`; behavior covered by the Task 11 e2e.

- [ ] **Step 1: Implement.** Create `src/modules/recruitment/components/speed-route-board.tsx`:

```tsx
"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { applicationStageLabel } from "@/modules/recruitment/engine/application-stage";
import type { SpeedRouteBoard as Board, SpeedRouteRow } from "@/modules/recruitment/services/speed-route";
import type { BatchResult } from "@/modules/recruitment/services/routing";
import { SpeedRouteModal } from "./speed-route-modal";

type Props = {
  board: Board;
  onRoute: (applicationId: string, departmentCode: string) => Promise<{ error?: string }>;
  onReject: (applicationId: string) => Promise<{ error?: string }>;
  onReopen: (applicationId: string) => Promise<{ error?: string }>;
  onApplyTop: (entries: { applicationId: string; departmentCode: string }[]) => Promise<BatchResult | { error: string }>;
  onApplyBottom: (applicationIds: string[]) => Promise<BatchResult | { error: string }>;
};

// Per-row handlers, gathered once so the module-level row/tier components (below)
// stay lint-clean (no component definitions nested inside the board component,
// matching the module-level ApplicationBody pattern in speed-score-modal.tsx).
type RowHandlers = {
  departments: string[];
  deptFor: (r: SpeedRouteRow) => string;
  setDept: (applicationId: string, value: string) => void;
  busy: boolean;
  onRoute: (applicationId: string, departmentCode: string) => void;
  onReject: (applicationId: string) => void;
  onReopen: (applicationId: string) => void;
};

function avgLabel(r: SpeedRouteRow) {
  return r.average != null ? `${r.average.toFixed(1)} · ${r.scoreCount}` : "-";
}

function RouteRow({ r, kind, h }: { r: SpeedRouteRow; kind: "top" | "middle" | "bottom"; h: RowHandlers }) {
  const routable = r.decision === "PENDING" && r.routedDepartmentCode == null;
  const decided = r.decision !== "PENDING";
  return (
    <TR>
      <TD className="font-medium text-foreground">{r.name}</TD>
      <TD className="text-foreground-soft">{avgLabel(r)}</TD>
      <TD className="text-foreground-soft">{r.departmentChoices.join(", ") || "(none)"}</TD>
      <TD><Badge>{applicationStageLabel[r.stage]}</Badge></TD>
      <TD>
        {routable ? (
          <div className="flex flex-wrap items-center gap-2">
            {kind !== "bottom" && (
              <>
                <div className="w-32">
                  <Select
                    value={h.deptFor(r)}
                    onChange={(e) => h.setDept(r.applicationId, e.target.value)}
                    aria-label={`Route ${r.name} to`}
                  >
                    <option value="" disabled>Department…</option>
                    {h.departments.map((d) => (
                      <option key={d} value={d}>{d}{r.departmentChoices.includes(d) ? " (ranked)" : ""}</option>
                    ))}
                  </Select>
                </div>
                <Button type="button" size="sm" variant="outline" disabled={h.busy || h.deptFor(r) === ""} onClick={() => h.onRoute(r.applicationId, h.deptFor(r))}>Route</Button>
              </>
            )}
            <Button type="button" size="sm" variant="danger" disabled={h.busy} onClick={() => h.onReject(r.applicationId)}>Reject</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-subtle-foreground">
              {r.routedDepartmentCode ? `Routed to ${r.routedDepartmentCode}` : ""}
              {decided ? ` ${r.decision.toLowerCase()}` : ""}
            </span>
            {decided && !r.acceptanceEmailed && (
              <Button type="button" size="sm" variant="ghost" disabled={h.busy} onClick={() => h.onReopen(r.applicationId)}>Reopen</Button>
            )}
          </div>
        )}
      </TD>
    </TR>
  );
}

function TierCard({ title, rows, kind, action, h }: { title: string; rows: SpeedRouteRow[]; kind: "top" | "middle" | "bottom"; action?: ReactNode; h: RowHandlers }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeader>{title} ({rows.length})</SectionHeader>
        {action}
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-subtle-foreground">None.</p>
      ) : (
        <Table>
          <THead>
            <tr><TH>Name</TH><TH>Committee avg</TH><TH>Ranked</TH><TH>Stage</TH><TH>Action</TH></tr>
          </THead>
          <tbody>{rows.map((r) => <RouteRow key={r.applicationId} r={r} kind={kind} h={h} />)}</tbody>
        </Table>
      )}
    </Card>
  );
}

export function SpeedRouteBoard({ board, onRoute, onReject, onReopen, onApplyTop, onApplyBottom }: Props) {
  const router = useRouter();
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "top" | "bottom">(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, startBusy] = useTransition();

  const deptFor = (r: SpeedRouteRow) => overrides[r.applicationId] ?? r.proposedDepartmentCode ?? "";
  const refresh = () => router.refresh();

  function runSingle(fn: () => Promise<{ error?: string }>) {
    setError(null);
    setNote(null);
    startBusy(async () => {
      const res = await fn();
      if (res?.error) { setError(res.error); return; }
      refresh();
    });
  }

  const h: RowHandlers = {
    departments: board.departments,
    deptFor,
    setDept: (id, value) => setOverrides((p) => ({ ...p, [id]: value })),
    busy,
    onRoute: (id, dept) => runSingle(() => onRoute(id, dept)),
    onReject: (id) => runSingle(() => onReject(id)),
    onReopen: (id) => runSingle(() => onReopen(id)),
  };

  function applyTop() {
    setConfirm(null);
    setError(null);
    setNote(null);
    const entries = board.top
      .filter((r) => r.decision === "PENDING" && r.routedDepartmentCode == null)
      .map((r) => ({ applicationId: r.applicationId, departmentCode: deptFor(r) }))
      .filter((e) => e.departmentCode !== "");
    if (entries.length === 0) { setError("No top-tier rows have a department to route to."); return; }
    startBusy(async () => {
      const res = await onApplyTop(entries);
      if ("error" in res) { setError(res.error); return; }
      setNote(`Routed ${res.applied}${res.skipped.length ? `, skipped ${res.skipped.length}` : ""}.`);
      refresh();
    });
  }

  function applyBottom() {
    setConfirm(null);
    setError(null);
    setNote(null);
    const ids = board.bottom.filter((r) => r.decision === "PENDING").map((r) => r.applicationId);
    if (ids.length === 0) { setError("No bottom-tier rows to reject."); return; }
    startBusy(async () => {
      const res = await onApplyBottom(ids);
      if ("error" in res) { setError(res.error); return; }
      setNote(`Rejected ${res.applied}${res.skipped.length ? `, skipped ${res.skipped.length}` : ""}.`);
      refresh();
    });
  }

  const topPending = board.top.filter((r) => r.decision === "PENDING" && r.routedDepartmentCode == null).length;
  const bottomPending = board.bottom.filter((r) => r.decision === "PENDING").length;

  return (
    <div className="space-y-5">
      {error && <Alert tone="error">{error}</Alert>}
      {note && <Alert tone="success">{note}</Alert>}

      <TierCard
        title="Top"
        rows={board.top}
        kind="top"
        h={h}
        action={
          topPending > 0 ? (
            confirm === "top" ? (
              <div className="flex items-center gap-2 text-sm">
                <span>Route {topPending} to their selected department?</span>
                <Button type="button" size="sm" variant="primary" disabled={busy} onClick={applyTop}>Confirm</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
              </div>
            ) : (
              <Button type="button" size="sm" variant="primary" disabled={busy} onClick={() => setConfirm("top")}>Apply top tier ({topPending})</Button>
            )
          ) : null
        }
      />

      <TierCard
        title="Middle"
        rows={board.middle}
        kind="middle"
        h={h}
        action={
          board.middle.length > 0 ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setModalOpen(true)}>Route the middle</Button>
          ) : null
        }
      />

      <TierCard
        title="Bottom"
        rows={board.bottom}
        kind="bottom"
        h={h}
        action={
          bottomPending > 0 ? (
            confirm === "bottom" ? (
              <div className="flex items-center gap-2 text-sm">
                <span>Reject {bottomPending} applicants?</span>
                <Button type="button" size="sm" variant="danger" disabled={busy} onClick={applyBottom}>Confirm</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
              </div>
            ) : (
              <Button type="button" size="sm" variant="danger" disabled={busy} onClick={() => setConfirm("bottom")}>Apply bottom tier ({bottomPending})</Button>
            )
          ) : null
        }
      />

      {board.unscored.length > 0 && (
        <Card>
          <SectionHeader>Unscored ({board.unscored.length})</SectionHeader>
          <p className="mt-2 text-sm text-subtle-foreground">Score these before they can be routed: {board.unscored.map((r) => r.name).join(", ")}.</p>
        </Card>
      )}

      {modalOpen && (
        <SpeedRouteModal
          open={modalOpen}
          onClose={() => { setModalOpen(false); refresh(); }}
          rows={board.middle}
          departments={board.departments}
          onRoute={onRoute}
          onReject={onReject}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify tsc + eslint.**
Run: `npx tsc --noEmit && npx eslint src/modules/recruitment/components/speed-route-board.tsx`
Expected: clean.

- [ ] **Step 3: Commit.**
```bash
git add src/modules/recruitment/components/speed-route-board.tsx
git commit -m "feat(recruitment): speed-route board UI"
```

---

### Task 9: Speed Route page + applicants-list launcher

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/speed-route/page.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx` (add the launcher Link)

**Interfaces:**
- Consumes: `requirePersonSession`, `loadSpeedRouteBoard`, the six actions (Task 6), `SpeedRouteBoard` component (Task 8), `RecruitmentAuthError`/`RoutingError`, `buttonClasses`, breadcrumb/header primitives.

- [ ] **Step 1: Create the page.** Create `src/app/(app)/recruitment/cycles/[id]/speed-route/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { loadSpeedRouteBoard } from "@/modules/recruitment/services/speed-route";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import { RoutingError } from "@/modules/recruitment/services/routing";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Field, Input } from "@/platform/ui/input";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { SpeedRouteBoard } from "@/modules/recruitment/components/speed-route-board";
import {
  speedRouteRouteAction,
  speedRouteRejectAction,
  speedRouteReopenAction,
  applyTopTierAction,
  applyBottomTierAction,
  setRouteThresholdsAction,
} from "./actions";

export default async function SpeedRoutePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  const person = await requirePersonSession();
  let board;
  try {
    board = await loadSpeedRouteBoard(id, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof RoutingError) notFound();
    throw err;
  }
  const middlePercent = Math.max(0, 100 - board.topPercent - board.bottomPercent);
  return (
    <div className="space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({ cycleId: id, cycleTitle: board.title, section: { label: "Speed route", slug: "speed-route" } })}
      />
      <PageHeader title="Speed route" description={board.title} />

      {error && <Alert tone="error">{error}</Alert>}

      <Card>
        <SectionHeader>Thresholds</SectionHeader>
        <p className="mt-1 text-xs text-subtle-foreground">
          Top {board.topPercent}% route to a department, bottom {board.bottomPercent}% auto-reject, middle {middlePercent}% you decide. Ties never split, so tier counts can exceed the percentage.
        </p>
        <form action={setRouteThresholdsAction.bind(null, id)} className="mt-3 flex flex-wrap items-end gap-3">
          <div className="w-28">
            <Field label="Top %">
              <Input name="topPercent" type="number" min={0} max={100} defaultValue={board.topPercent} />
            </Field>
          </div>
          <div className="w-28">
            <Field label="Bottom %">
              <Input name="bottomPercent" type="number" min={0} max={100} defaultValue={board.bottomPercent} />
            </Field>
          </div>
          <SubmitButton size="sm" pendingLabel="Saving…">Save thresholds</SubmitButton>
        </form>
      </Card>

      <SpeedRouteBoard
        board={board}
        onRoute={speedRouteRouteAction}
        onReject={speedRouteRejectAction}
        onReopen={speedRouteReopenAction}
        onApplyTop={applyTopTierAction}
        onApplyBottom={applyBottomTierAction}
      />
    </div>
  );
}
```

- [ ] **Step 2: Add the launcher to the applicants list.** In `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx`:

Add these imports near the top (after the existing `buttonClasses`-free imports):
```tsx
import Link from "next/link"; // NOTE: Link is already imported at the top of this file; do not add a duplicate.
import { buttonClasses } from "@/platform/ui/button";
```
(Only add the `buttonClasses` import; `Link` is already imported on line 1.)

Then, immediately after the `canScore` computation (currently around line 40, `const canScore = scope.all || canScorePerm;`), add:
```tsx
  const canSpeedRoute = scope.all && cycle.track === "VOLUNTEER" && apps.some((a) => a.committeeScores.length > 0);
```

Then, in the header actions area, replace the existing block:
```tsx
        {canScore && speedItems.length > 0 && (
          <SpeedScoreLauncher
            items={speedItems}
            onScore={speedScoreAction}
            onLoad={loadReviewApplicationAction}
          />
        )}
```
with:
```tsx
        <div className="flex flex-wrap items-center gap-2">
          {canSpeedRoute && (
            <Link href={`/recruitment/cycles/${id}/speed-route`} className={buttonClasses("outline", "sm")}>
              Speed route
            </Link>
          )}
          {canScore && speedItems.length > 0 && (
            <SpeedScoreLauncher
              items={speedItems}
              onScore={speedScoreAction}
              onLoad={loadReviewApplicationAction}
            />
          )}
        </div>
```

- [ ] **Step 3: Verify tsc + eslint + build the routes.**
Run: `npx tsc --noEmit && npx eslint "src/app/(app)/recruitment/cycles/[id]/speed-route/page.tsx" "src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx"`
Expected: clean.

- [ ] **Step 4: Commit.**
```bash
git add "src/app/(app)/recruitment/cycles/[id]/speed-route/page.tsx" "src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx"
git commit -m "feat(recruitment): speed-route page + applicant-list launcher"
```

---

### Task 10: Detail-page reject reflection + reopen action

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts` (add `reopenDecisionAction`)
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` (Department decision card)

**Interfaces:**
- Consumes: `reopenDecision` (routing.ts), existing `bounce` helper, `RecruitmentAuthError`/`RoutingError`/`AcceptanceError`.
- Produces: `reopenDecisionAction(cycleId: string, applicationId: string): Promise<void>`.

- [ ] **Step 1: Add the reopen action.** In `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts`, add `reopenDecision` to the routing import (line 8 currently `import { routeApplication, decideRoutedApplication, RoutingError } from "@/modules/recruitment/services/routing";`):
```tsx
import { routeApplication, decideRoutedApplication, reopenDecision, RoutingError } from "@/modules/recruitment/services/routing";
```
Then append this action to the file:
```tsx
export async function reopenDecisionAction(cycleId: string, applicationId: string) {
  const person = await requirePersonSession();
  try {
    await reopenDecision(applicationId, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof RoutingError || err instanceof AcceptanceError) {
      redirect(bounce(cycleId, applicationId, { error: (err as Error).message }));
    }
    throw err;
  }
  redirect(bounce(cycleId, applicationId, { saved: "reopened" }));
}
```

- [ ] **Step 2: Reflect a not-routed reject on the detail page.** In `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`:

Add the import for the action (extend the existing import from `../actions` on line 8):
```tsx
import { scheduleInterviewAction, committeeScoreAction, routeAction, decideRoutedAction, reopenDecisionAction } from "../actions";
```

In the non-DIRECTOR "Department decision" `Card` (the `else` branch, currently starting near line 248), replace the first conditional branch:
```tsx
          {!app.routedDepartmentCode ? (
            <p className="mt-3 text-sm text-muted-foreground">Awaiting committee routing.</p>
          ) : canDecideRouted ? (
```
with:
```tsx
          {!app.routedDepartmentCode ? (
            app.decision !== "PENDING" ? (
              <div className="mt-3 space-y-2">
                <p className="text-sm text-foreground-soft">
                  This applicant was <strong className="text-foreground">{decisionLabel[app.decision as keyof typeof decisionLabel]}</strong> without routing.
                  {app.decisionNotes ? ` ${app.decisionNotes}` : ""}
                </p>
                {scope.all && (
                  <form action={reopenDecisionAction.bind(null, id, applicationId)}>
                    <SubmitButton size="sm" variant="outline" pendingLabel="Reopening…">Reopen</SubmitButton>
                  </form>
                )}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">Awaiting committee routing.</p>
            )
          ) : canDecideRouted ? (
```

Also extend the existing success alert so the reopen confirmation shows. Find:
```tsx
          {saved === "decision" && <Alert tone="success" className="mt-3">Decision recorded.</Alert>}
```
and add below it:
```tsx
          {saved === "reopened" && <Alert tone="success" className="mt-3">Decision reopened.</Alert>}
```

Note: `SubmitButton` forwards `Button` props, so `variant="outline"` is valid.

- [ ] **Step 3: Verify tsc + eslint.**
Run: `npx tsc --noEmit && npx eslint "src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts" "src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx"`
Expected: clean.

- [ ] **Step 4: Commit.**
```bash
git add "src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts" "src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx"
git commit -m "feat(recruitment): show + reopen a not-routed reject on the detail page"
```

---

### Task 11: End-to-end

**Files:**
- Create: `e2e/recruitment-speed-routing.spec.ts`

**Interfaces:**
- Consumes: `applicantSessionCookie` (from `./portal-cookie`), the speed-route page and actions.

Note: This test assumes the dev sign-in user `j.carney@yale.edu` holds `recruitment.review_all` and `recruitment.manage_cycles` (same assumptions the speed-score e2e relies on). The single-department cycle means every applicant's first ranked choice is `SRHD`.

- [ ] **Step 1: Write the e2e.** Create `e2e/recruitment-speed-routing.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { applicantSessionCookie } from "./portal-cookie";

test.setTimeout(150_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

async function submitApplication(
  browser: import("@playwright/test").Browser,
  slug: string,
  applicantEmail: string,
  firstName: string,
) {
  const ctx = await browser.newContext();
  await ctx.addCookies([applicantSessionCookie(applicantEmail)]);
  const apply = await ctx.newPage();
  await apply.goto(`/apply/${slug}`);
  const submit = apply.getByRole("button", { name: "Submit application" });
  const firstNameField = apply.locator('input[name="first_name"]');
  for (let i = 0; i < 8; i++) {
    if (await submit.isVisible().catch(() => false)) break;
    if (await firstNameField.isVisible().catch(() => false)) {
      await firstNameField.fill(firstName);
      await apply.fill('input[name="last_name"]', "X");
      await apply.fill('input[name="email"]', applicantEmail);
    }
    await apply.getByRole("button", { name: "Continue" }).click();
  }
  await expect(submit).toBeVisible();
  await submit.click();
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await ctx.close();
}

test("speed route: score a spread, apply top + bottom, keyboard-route the middle", async ({ page, context }) => {
  await devLogin(page, "j.carney@yale.edu");

  // Build + publish a single-department volunteer cycle with a minimal form.
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Speed Route E2E");
  const slug = `speed-route-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.fill('input[name="departments"]', "SRHD");
  await page.uncheck('input[name="seedDefaultForm"]');
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator("span").filter({ hasText: "OPEN" })).toBeVisible();

  // Four applicants.
  const browser = context.browser()!;
  const stamp = Date.now();
  const emails = [0, 1, 2, 3].map((n) => `e2e-route-${n}-${stamp}@yale.edu`);
  await submitApplication(browser, slug, emails[0], "Anna");
  await submitApplication(browser, slug, emails[1], "Ben");
  await submitApplication(browser, slug, emails[2], "Cara");
  await submitApplication(browser, slug, emails[3], "Dan");

  // Score them 5,4,2,1 via the speed-score modal so we get all three tiers
  // (top 20% -> 1, bottom 30% -> 1, middle -> 2 for N=4).
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("button", { name: /speed score/i }).click();
  const scoreDialog = page.getByRole("dialog");
  await expect(scoreDialog).toBeVisible();
  await page.keyboard.press("5");
  await page.keyboard.press("4");
  await page.keyboard.press("2");
  await page.keyboard.press("1");
  await expect(scoreDialog.getByText(/all caught up/i)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(scoreDialog).toBeHidden();

  // Open Speed route.
  await page.getByRole("link", { name: /speed route/i }).click();
  await page.waitForURL((url) => url.pathname.endsWith("/speed-route"));
  await expect(page.getByRole("heading", { name: "Speed route" })).toBeVisible();
  await expect(page.getByText(/^Top \(1\)$/)).toBeVisible();
  await expect(page.getByText(/^Middle \(2\)$/)).toBeVisible();
  await expect(page.getByText(/^Bottom \(1\)$/)).toBeVisible();

  // Apply the top tier (routes the top applicant to SRHD).
  await page.getByRole("button", { name: /apply top tier/i }).click();
  await page.getByRole("button", { name: /^Confirm$/ }).click();
  await expect(page.getByText(/Routed 1/)).toBeVisible();

  // Apply the bottom tier (rejects the bottom applicant).
  await page.getByRole("button", { name: /apply bottom tier/i }).click();
  await page.getByRole("button", { name: /^Confirm$/ }).click();
  await expect(page.getByText(/Rejected 1/)).toBeVisible();

  // Route the middle by keyboard: two applicants, press 1 (first ranked = SRHD) each.
  await page.getByRole("button", { name: /route the middle/i }).click();
  const routeDialog = page.getByRole("dialog");
  await expect(routeDialog).toBeVisible();
  await expect(routeDialog.getByText(/1 of 2/)).toBeVisible();
  await page.keyboard.press("1");
  await expect(routeDialog.getByText(/2 of 2/)).toBeVisible();
  await page.keyboard.press("1");
  await expect(routeDialog.getByText(/middle tier cleared/i)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(routeDialog).toBeHidden();

  // Back on the roster: three routed (top + two middle), one decided (rejected).
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await expect(page.getByText("Routed")).toHaveCount(3);
  await expect(page.getByText("Decided")).toHaveCount(1);
});
```

- [ ] **Step 2: Run the e2e.**
Run (a dev server must be up against the e2e database; the SDD controller sets this up, mirroring the speed-score e2e run): `npx playwright test e2e/recruitment-speed-routing.spec.ts`
Expected: PASS (1 test).

- [ ] **Step 3: Commit.**
```bash
git add e2e/recruitment-speed-routing.spec.ts
git commit -m "test(e2e): speed-route apply-tiers + keyboard middle flow"
```

---

## Execution notes for the controller

- The e2e (Task 11) needs a running dev server pointed at a seeded e2e database, exactly like the speed-score e2e (`havenhub_e2e_speedscore` on `:3100` with an inline `DATABASE_URL` override, never Neon). Reuse that setup: create `havenhub_e2e_speedroute`, migrate + seed it, start the dev server with the inline override and `AUTH_SECRET` set, run the spec, then stop the server.
- All vitest tasks use `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_speedroute"`.
- After the final task, run the whole recruitment + engine suite once against the test DB and confirm `tsc` + `eslint` are clean before the whole-branch review.
