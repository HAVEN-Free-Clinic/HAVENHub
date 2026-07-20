# Cross-Term Model (Foundation + Training/Onboarding) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let members see and complete their *next-term* training and onboarding while a different term is still live, by making member-facing flows resolve a person's own terms instead of the single global active term.

**Architecture:** Add three small term resolvers next to `getActiveTerm()` (`getNextTerm`, `getPersonTerms`, `getWorkingTerm`). Make `getMyTraining` iterate a person's terms and `submitQuiz` take an explicit `termId` (Approach A: term is an input, not an ambient global). Split onboarding into a live-term **gate** (`getOnboardingStatus`, unchanged role) and a multi-term **display** (`getMyOnboarding`). Update the member surfaces (`/training`, `/get-started/training`, dashboard) to group by term. No schema change.

**Tech Stack:** Next.js App Router (RSC + server actions), Prisma, React `cache()`, Vitest against a local Postgres test DB.

## Global Constraints

- No database migration, no data backfill. Live term = the single `ACTIVE` term; next term = the single `PLANNING` term.
- Forward-looking member flows receive a `termId` (or iterate `getPersonTerms`); they must NOT call `getActiveTerm()` internally. `getActiveTerm()` keeps its name and its role as the live-term resolver.
- The onboarding **gate** (`getOnboardingStatus` → `enforceOnboarding`) stays **live-term-only**. Next-term tasks are shown and actionable but never block hub access.
- Behavior must be **identical when only one term is in flight** (no `PLANNING` term): every multi-term path collapses to today's single-term result. This is the primary regression guard.
- New per-request resolvers use React `cache()`, matching `getActiveTerm`.
- Tests run against the local Postgres test DB (`havenhub_test` on `:5434`) with a per-worktree `TEST_DATABASE_URL`; each test file uses `resetDb()` in `beforeEach`/`afterEach` (see `src/modules/recruitment/services/training.test.ts`). Run the FULL `npm run lint` before any push (typecheck/tests miss the eslint boundary).

---

## File Structure

**Create:**
- `src/platform/terms/next-term.ts` — `getNextTerm()` resolver.
- `src/platform/terms/person-terms.ts` — `getPersonTerms(personId)` resolver.
- `src/platform/terms/working-term.ts` — `getWorkingTerm(selectedId?)` resolver.
- `src/platform/terms/next-term.test.ts`, `person-terms.test.ts`, `working-term.test.ts` — resolver unit tests.
- `src/modules/onboarding/services/onboarding.test.ts` — tests for the gate-vs-display split.

**Modify:**
- `src/modules/recruitment/services/training.ts` — extract `getMyTrainingForTerm`, make `getMyTraining` multi-term, add `termId` to `submitQuiz`.
- `src/modules/recruitment/services/training.test.ts` — update `submitQuiz` calls to pass `termId`; add a cross-term test.
- `src/app/(app)/training/actions.ts` — `gradeQuizAction` gains `termId`.
- `src/app/(app)/training/training-quiz.tsx` — `TrainingQuiz` gains a `termId` prop and passes it to the action.
- `src/app/(app)/training/page.tsx` — group trainings by term; pass `termId` to `TrainingQuiz`.
- `src/app/get-started/training/page.tsx` — resolve the live-term training explicitly (not a blind `.find` across terms).
- `src/modules/onboarding/services/onboarding.ts` — extract `computeOnboardingForTerm`; keep `getOnboardingStatus` live-term; add `getMyOnboarding`.
- `src/app/(app)/page.tsx` — action-card training signal from `getMyTraining` (all terms); "Your status" rail per-term from `getMyOnboarding`.

---

## Task 1: `getNextTerm()` resolver

**Files:**
- Create: `src/platform/terms/next-term.ts`
- Test: `src/platform/terms/next-term.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `getNextTerm(): Promise<Term | null>` — the single `PLANNING` term (newest by `startDate`), or `null`.

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/terms/next-term.test.ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getNextTerm } from "./next-term";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("returns null when there is no PLANNING term", async () => {
  await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" } });
  expect(await getNextTerm()).toBeNull();
});

it("returns the single PLANNING term (newest by startDate)", async () => {
  await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" } });
  const fa = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING" } });
  expect((await getNextTerm())?.id).toBe(fa.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/terms/next-term.test.ts`
Expected: FAIL (cannot find module `./next-term`).

- [ ] **Step 3: Write the resolver**

```ts
// src/platform/terms/next-term.ts
import { cache } from "react";
import type { Term } from "@prisma/client";
import { prisma } from "@/platform/db";

/**
 * The single term being prepared for next (status PLANNING), newest by start
 * date, or null when nothing is in preparation (the normal state most of the
 * year). Memoized per request via React cache(), like getActiveTerm.
 */
export const getNextTerm = cache(async (): Promise<Term | null> => {
  return prisma.term.findFirst({
    where: { status: "PLANNING" },
    orderBy: { startDate: "desc" },
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/terms/next-term.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/terms/next-term.ts src/platform/terms/next-term.test.ts
git commit -m "feat(terms): add getNextTerm resolver (the single PLANNING term)"
```

---

## Task 2: `getPersonTerms(personId)` resolver

**Files:**
- Create: `src/platform/terms/person-terms.ts`
- Test: `src/platform/terms/person-terms.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `getPersonTerms(personId: string): Promise<Term[]>` — terms where the person holds an `ACTIVE` membership and the term is `ACTIVE` or `PLANNING`, ordered live-term (ACTIVE) first, then by `startDate` desc.

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/terms/person-terms.test.ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getPersonTerms } from "./person-terms";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function seed() {
  const live = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" } });
  const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING" } });
  const old = await prisma.term.create({ data: { code: "SP26", name: "Spring", startDate: new Date("2026-01-01"), endDate: new Date("2026-05-01"), status: "ARCHIVED" } });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const person = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
  return { live, next, old, dept, person };
}

it("returns live + next where the person is an active member, live first", async () => {
  const { live, next, dept, person } = await seed();
  await prisma.termMembership.create({ data: { personId: person.id, termId: live.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  const terms = await getPersonTerms(person.id);
  expect(terms.map((t) => t.code)).toEqual(["SU26", "FA26"]);
});

it("excludes ARCHIVED terms and terms the person is not an active member of", async () => {
  const { live, old, dept, person } = await seed();
  await prisma.termMembership.create({ data: { personId: person.id, termId: old.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  // REMOVED membership in the live term must not count.
  await prisma.termMembership.create({ data: { personId: person.id, termId: live.id, departmentId: dept.id, kind: "VOLUNTEER", status: "REMOVED" } });
  expect(await getPersonTerms(person.id)).toEqual([]);
});

it("returns only the next term for a next-term-only recruit", async () => {
  const { next, dept, person } = await seed();
  await prisma.termMembership.create({ data: { personId: person.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  const terms = await getPersonTerms(person.id);
  expect(terms.map((t) => t.code)).toEqual(["FA26"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/terms/person-terms.test.ts`
Expected: FAIL (cannot find module `./person-terms`).

- [ ] **Step 3: Write the resolver**

```ts
// src/platform/terms/person-terms.ts
import { cache } from "react";
import type { Term } from "@prisma/client";
import { prisma } from "@/platform/db";

/**
 * The terms a person currently belongs to that are live or in preparation:
 * terms with status ACTIVE or PLANNING in which the person holds an ACTIVE
 * TermMembership. Ordered live-term (ACTIVE) first, then by startDate desc.
 * This is the set the merged member views iterate over; ARCHIVED terms and
 * terms the person is not an active member of are excluded. Memoized per
 * request via React cache().
 */
export const getPersonTerms = cache(async (personId: string): Promise<Term[]> => {
  const memberships = await prisma.termMembership.findMany({
    where: { personId, status: "ACTIVE", term: { status: { in: ["ACTIVE", "PLANNING"] } } },
    include: { term: true },
  });
  const byId = new Map<string, Term>();
  for (const m of memberships) byId.set(m.term.id, m.term);
  return [...byId.values()].sort((a, b) => {
    if (a.status !== b.status) return a.status === "ACTIVE" ? -1 : 1;
    return b.startDate.getTime() - a.startDate.getTime();
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/terms/person-terms.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/terms/person-terms.ts src/platform/terms/person-terms.test.ts
git commit -m "feat(terms): add getPersonTerms resolver (a person's live + next terms)"
```

---

## Task 3: `getWorkingTerm(selectedId?)` resolver

**Files:**
- Create: `src/platform/terms/working-term.ts`
- Test: `src/platform/terms/working-term.test.ts`

**Interfaces:**
- Consumes: `getActiveTerm()` from `@/platform/terms/active-term`, `getNextTerm()` from `@/platform/terms/next-term` (Task 1).
- Produces: `getWorkingTerm(selectedId?: string): Promise<Term | null>` — the live or next term matching `selectedId`, else the live term. This is the pure resolver behind the staff `?term=` switcher (whose UI ships with the scheduling spec).

- [ ] **Step 1: Write the failing test**

```ts
// src/platform/terms/working-term.test.ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getWorkingTerm } from "./working-term";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function seed() {
  const live = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" } });
  const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING" } });
  return { live, next };
}

it("returns the live term when no selection is given", async () => {
  const { live } = await seed();
  expect((await getWorkingTerm())?.id).toBe(live.id);
});

it("returns the next term when selected", async () => {
  const { next } = await seed();
  expect((await getWorkingTerm(next.id))?.id).toBe(next.id);
});

it("falls back to the live term for an invalid or archived selection", async () => {
  const { live } = await seed();
  expect((await getWorkingTerm("does-not-exist"))?.id).toBe(live.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/terms/working-term.test.ts`
Expected: FAIL (cannot find module `./working-term`).

- [ ] **Step 3: Write the resolver**

```ts
// src/platform/terms/working-term.ts
import { cache } from "react";
import type { Term } from "@prisma/client";
import { getActiveTerm } from "./active-term";
import { getNextTerm } from "./next-term";

/**
 * The term a staff member is working on for forward-looking tools. If selectedId
 * matches the live or next term, return it; otherwise fall back to the live term.
 * This makes an invalid or stale ?term=<id> degrade safely rather than error.
 * The UI that supplies selectedId (the <TermSwitcher>) ships with the scheduling
 * spec; this resolver is built now so the model is complete. Memoized per request.
 */
export const getWorkingTerm = cache(async (selectedId?: string): Promise<Term | null> => {
  const [live, next] = await Promise.all([getActiveTerm(), getNextTerm()]);
  if (selectedId) {
    if (live?.id === selectedId) return live;
    if (next?.id === selectedId) return next;
  }
  return live;
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/terms/working-term.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/terms/working-term.ts src/platform/terms/working-term.test.ts
git commit -m "feat(terms): add getWorkingTerm resolver (live/next selection with safe fallback)"
```

---

## Task 4: `getMyTraining` becomes multi-term

**Files:**
- Modify: `src/modules/recruitment/services/training.ts` (the `getMyTraining` function, ~lines 202-238)
- Test: `src/modules/recruitment/services/training.test.ts`

**Interfaces:**
- Consumes: `getPersonTerms` from `@/platform/terms/person-terms` (Task 2).
- Produces: `getMyTrainingForTerm(personId: string, term: Term): Promise<MyTraining[]>` (the old single-term body); `getMyTraining(personId: string): Promise<MyTraining[]>` now concatenates across `getPersonTerms`. `MyTraining` is unchanged (already carries `term: { id, name }`).

- [ ] **Step 1: Write the failing test**

Add to `src/modules/recruitment/services/training.test.ts` (it already imports `getMyTraining`, `setTrainingCycle`, and uses the `seedMember()` helper):

```ts
it("getMyTraining spans the person's live and next terms, live first", async () => {
  const { srr, vol, dept } = await seedMember(); // live term SU26 with designated volunteer cycle c1; vol is an active volunteer
  // Build a next (PLANNING) term with its own designated volunteer training cycle + membership for vol.
  const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING" } });
  const nextCycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: next.id, title: "FA vol", publicSlug: "fa-vol", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(nextCycle.id, true, srr.id);
  await prisma.termMembership.create({ data: { personId: vol.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });

  const trainings = await getMyTraining(vol.id);
  expect(trainings.map((m) => m.term.name)).toEqual(["Summer", "Fall"]);
  expect(trainings.every((m) => m.track === "VOLUNTEER")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/training.test.ts -t "spans the person"`
Expected: FAIL (only the Summer entry returned; `["Summer"]` !== `["Summer","Fall"]`).

- [ ] **Step 3: Refactor `getMyTraining` in `training.ts`**

Add the import near the other platform imports at the top of `src/modules/recruitment/services/training.ts`:

```ts
import { getPersonTerms } from "@/platform/terms/person-terms";
```

Replace the whole current `getMyTraining` function (the one that starts `export async function getMyTraining(personId: string): Promise<MyTraining[]> {` and calls `activeTermOrThrow()`) with a per-term helper plus a multi-term wrapper:

```ts
/** The required training(s) for one specific term, one entry per required track. */
export async function getMyTrainingForTerm(personId: string, term: { id: string; name: string }): Promise<MyTraining[]> {
  const tracks = await requiredTrainingTracks(personId, term.id);
  const out: MyTraining[] = [];
  for (const track of tracks) {
    const cycle = await getTrainingCycleForTerm(term.id, track);
    const row = await prisma.training.findUnique({ where: { personId_termId_track: { personId, termId: term.id, track } } });
    const state: TrainingState = row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";

    let questions: MyTraining["questions"] = [];
    if (cycle) {
      const fields = await prisma.formField.findMany({
        where: { cycleId: cycle.id, type: "SINGLE_SELECT", section: { purpose: "QUIZ" } },
        orderBy: [{ section: { order: "asc" } }, { order: "asc" }],
        select: { key: true, label: true, options: true },
      });
      questions = fields.map((f) => ({ key: f.key, label: f.label, options: (f.options as { value: string; label: string }[] | null) ?? [] }));
    }

    const attemptsUsed = row ? await prisma.quizAttempt.count({ where: { trainingId: row.id, ...(row.lockResetAt ? { takenAt: { gte: row.lockResetAt } } : {}) } }) : 0;

    out.push({
      track, trackLabel: TRACK_LABEL[track],
      term: { id: term.id, name: term.name },
      cycle: cycle ? { id: cycle.id, title: cycle.title } : null,
      state, locked: row?.locked ?? false, completedVia: row?.completedVia ?? null, completedAt: row?.completedAt ?? null,
      attemptsUsed, maxAttempts: cycle?.quizMaxAttempts ?? 0, passPercent: cycle?.quizPassPercent ?? 0,
      questions,
      intake: {
        additionalShiftAvailability: row?.additionalShiftAvailability ?? null,
        minShiftsWanted: row?.minShiftsWanted ?? null,
        feedback: row?.feedback ?? null,
      },
    });
  }
  return out;
}

/** The training(s) the signed-in member must complete across every term they belong to. */
export async function getMyTraining(personId: string): Promise<MyTraining[]> {
  const terms = await getPersonTerms(personId);
  const out: MyTraining[] = [];
  for (const term of terms) {
    out.push(...(await getMyTrainingForTerm(personId, term)));
  }
  return out;
}
```

- [ ] **Step 4: Run the full training suite to verify pass + no regression**

Run: `npx vitest run src/modules/recruitment/services/training.test.ts`
Expected: PASS (all existing tests plus the new one; the single-term tests are unchanged because a lone ACTIVE term yields `getPersonTerms` of length 1).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/training.ts src/modules/recruitment/services/training.test.ts
git commit -m "feat(training): getMyTraining spans a member's live and next terms"
```

---

## Task 5: `submitQuiz` takes an explicit `termId`

**Files:**
- Modify: `src/modules/recruitment/services/training.ts` (the `submitQuiz` function, ~lines 243-293)
- Test: `src/modules/recruitment/services/training.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `submitQuiz(personId: string, input: { termId: string; track: Track; answers: Record<string, unknown>; intake: TrainingIntake }): Promise<QuizSubmission>`. The `termId` is validated by the existing membership check (an `ACTIVE` membership in `termId` + `track` is required), so an arbitrary term is rejected.

- [ ] **Step 1: Update existing `submitQuiz` calls + add the cross-term test**

In `src/modules/recruitment/services/training.test.ts`, add `termId: term.id` (or `dirCycle`'s term) to every `submitQuiz(...)` call. The affected calls and their correct term:
- In "quiz path: failing accrues attempts then locks…" (uses `term` from `seedMember`): all four `submitQuiz(vol.id, { track: "VOLUNTEER", ... })` → add `termId: term.id`.
- In "submitQuiz rejects when already complete": `submitQuiz(vol.id, { track: "VOLUNTEER", ... })` → add `termId: term.id`.
- In "a director completes director training via the quiz": `submitQuiz(dir.id, { track: "DIRECTOR", ... })` → add `termId: term.id`.
- In "submitQuiz rejects a track the person has no active membership for": `submitQuiz(vol.id, { track: "DIRECTOR", ... })` → add `termId: term.id`.

Then add a new cross-term test:

```ts
it("submitQuiz completes NEXT-term training while a different term is live", async () => {
  const { srr, vol, dept } = await seedMember(); // live term SU26 is ACTIVE
  const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING" } });
  const nextCycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: next.id, title: "FA vol", publicSlug: "fa-vol", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(nextCycle.id, true, srr.id);
  await updateQuizSettings(nextCycle.id, { quizPassPercent: 100, quizMaxAttempts: 2 }, srr.id);
  await addQuiz(nextCycle.id);
  await prisma.termMembership.create({ data: { personId: vol.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });

  const r = await submitQuiz(vol.id, { termId: next.id, track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: {} });
  expect(r.passed).toBe(true);
  expect(await resolveTrainingState(vol.id, next.id, "VOLUNTEER")).toBe("COMPLETE");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/training.test.ts -t "NEXT-term"`
Expected: FAIL (a type error / the current `submitQuiz` ignores `termId` and resolves the ACTIVE term, so it grades against SU26 and throws "Not an active member" or completes the wrong term).

- [ ] **Step 3: Rewrite `submitQuiz` to use `input.termId`**

In `src/modules/recruitment/services/training.ts`, replace the `submitQuiz` signature and its term resolution. Change the signature to:

```ts
export async function submitQuiz(
  personId: string,
  input: { termId: string; track: Track; answers: Record<string, unknown>; intake: TrainingIntake }
): Promise<QuizSubmission> {
  const cycle = await getTrainingCycleForTerm(input.termId, input.track);
  if (!cycle) throw new TrainingStateError("This term has no designated training cycle.");

  const isMember = await prisma.termMembership.count({ where: { personId, termId: input.termId, kind: input.track, status: "ACTIVE" } });
  if (isMember === 0) throw new TrainingStateError("Not an active member of this track this term.");

  const questions = await quizQuestions(cycle.id);
  if (questions.length === 0) throw new TrainingStateError("This training has no quiz questions yet.");

  return prisma.$transaction(async (tx) => {
    const row = await tx.training.upsert({
      where: { personId_termId_track: { personId, termId: input.termId, track: input.track } },
      create: { personId, termId: input.termId, cycleId: cycle.id, track: input.track },
      update: {},
    });
    // ... (unchanged body below) ...
```

Delete the removed lines: `const term = await activeTermOrThrow();` and the old `const cycle = await getTrainingCycleForTerm(term.id, input.track);`. In the transaction body, replace the two remaining `term.id` references (the `completeTraining` call and any others) with `input.termId`:

```ts
    if (result.passed) {
      await completeTraining(tx, { personId, termId: input.termId, cycleId: cycle.id, track: input.track, via: "QUIZ" });
    } else if (attemptsUsed >= cycle.quizMaxAttempts) {
```

Replace **every** remaining `term.id` in `submitQuiz` with `input.termId`: the `getTrainingCycleForTerm` call, the membership `count`, the `tx.training.upsert` `where` and `create`, and the `completeTraining` call. Leave the grading, attempt-count, lock, and `correctByKey` logic exactly as-is.

Then delete the now-dead code that only the old active-term path used: remove the `activeTermOrThrow` helper (the `async function activeTermOrThrow()` near line 164) and remove its now-unused import `import { getActiveTerm } from "@/platform/terms/active-term";` at the top of `training.ts`. (After Task 4 removed `getMyTraining`'s use and this task removes `submitQuiz`'s use, nothing else references them.)

- [ ] **Step 4: Run the full training suite to verify pass**

Run: `npx vitest run src/modules/recruitment/services/training.test.ts`
Expected: PASS (all tests, including the updated single-term calls and the new cross-term test).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/training.ts src/modules/recruitment/services/training.test.ts
git commit -m "feat(training): submitQuiz takes an explicit termId (next-term self-serve)"
```

---

## Task 6: Thread `termId` through the training UI

**Files:**
- Modify: `src/app/(app)/training/actions.ts`
- Modify: `src/app/(app)/training/training-quiz.tsx`
- Modify: `src/app/(app)/training/page.tsx`
- Modify: `src/app/get-started/training/page.tsx`

**Interfaces:**
- Consumes: `submitQuiz` (Task 5) with `termId`; `getMyTrainingForTerm` (Task 4); `getActiveTerm`.
- Produces: no new exports. `gradeQuizAction` input gains `termId: string`; `TrainingQuiz` props gain `termId: string`.

This task is UI wiring with no unit test; the deliverable is a clean `npx tsc --noEmit` plus correct term routing. (End-to-end coverage lives in the Playwright suite, which cannot run locally against Neon; note it for CI.)

- [ ] **Step 1: `gradeQuizAction` accepts and forwards `termId`**

In `src/app/(app)/training/actions.ts`, add `termId` to the input type and the `submitQuiz` call:

```ts
export async function gradeQuizAction(input: {
  termId: string;
  track: Track;
  answers: Record<string, string>;
  intake: TrainingIntake;
}): Promise<QuizActionResult> {
  const person = await requirePersonSession();
  try {
    const result = await submitQuiz(person.personId, {
      termId: input.termId,
      track: input.track,
      answers: input.answers,
      intake: input.intake,
    });
```

- [ ] **Step 2: `TrainingQuiz` accepts a `termId` prop and forwards it**

In `src/app/(app)/training/training-quiz.tsx`, add `termId` to the component props (destructure and type), and pass it in the `gradeQuizAction` call inside `handleSubmit`:

```tsx
export function TrainingQuiz({
  termId,
  track,
  questions,
  passPercent,
  maxAttempts,
  attemptsUsed: initialAttemptsUsed,
  intake,
}: {
  termId: string;
  track: Track;
  questions: Question[];
  passPercent: number;
  maxAttempts: number;
  attemptsUsed: number;
  intake: MyTraining["intake"];
}) {
```

and:

```tsx
      const res = await gradeQuizAction({ termId, track, answers, intake: intakePayload });
```

- [ ] **Step 3: `/training` page groups by term and passes `termId`**

In `src/app/(app)/training/page.tsx`, the page already maps `trainings`. Two changes: make the `section` key and heading term-aware, and pass `termId` to `TrainingQuiz`. Replace the `trainings.map(...)` block's `<section>` open, heading, and `<TrainingQuiz .../>` with:

```tsx
        trainings.map((my) => {
          const pending = my.cycle && my.state !== "COMPLETE" && !my.locked;
          return (
            <section key={`${my.term.id}-${my.track}`} className="mb-9">
              <SectionHeader level="title" className="mb-3">{my.term.name} · {my.trackLabel}</SectionHeader>
              <ClearanceHero my={my} zone={zone} />
              {pending && (
                <>
                  <PathCards my={my} />
                  <SectionHeader level="title" className="mb-3.5 mt-7">Makeup quiz</SectionHeader>
                  <TrainingQuiz
                    termId={my.term.id}
                    track={my.track}
                    questions={my.questions}
                    passPercent={my.passPercent}
                    maxAttempts={my.maxAttempts}
                    attemptsUsed={my.attemptsUsed}
                    intake={my.intake}
                  />
                </>
              )}
              {my.state === "COMPLETE" && <CompleteDetail accessibleSchedule={canSchedule} />}
              {my.locked && my.state !== "COMPLETE" && <LockedDetail />}
            </section>
          );
        })
```

Also generalize the page description (it currently references `trainings[0].term.name`, which is misleading with multiple terms). Replace the `PageHeader` description prop with a term-agnostic line:

```tsx
        <PageHeader
          title="Training"
          description="Complete your training to be cleared for each term you're part of."
        />
```

- [ ] **Step 4: `/get-started/training` resolves the LIVE-term training explicitly**

In `src/app/get-started/training/page.tsx`, the get-started flow is the live-term gate. Replace the blind multi-term `.find` with an explicit live-term lookup so a returning member's next-term training never hijacks this live-term step. Change the imports and the training lookup:

```tsx
import { getMyTrainingForTerm } from "@/modules/recruitment/services/training";
import { getActiveTerm } from "@/platform/terms/active-term";
```

```tsx
  const sp = await searchParams;
  const track = sp.track === "director" ? "DIRECTOR" : "VOLUNTEER";
  const liveTerm = await getActiveTerm();
  if (!liveTerm) redirect("/get-started");
  const trainings = await getMyTrainingForTerm(person.personId, liveTerm);
  const my = trainings.find((m) => m.track === track);
```

(Remove the old `import { getMyTraining } ...` and the old `const trainings = await getMyTraining(person.personId);` line.)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If `tsc` is slow, scope with the project's typecheck script, e.g. `npm run typecheck`.)

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/training/actions.ts" "src/app/(app)/training/training-quiz.tsx" "src/app/(app)/training/page.tsx" "src/app/get-started/training/page.tsx"
git commit -m "feat(training): term-aware training UI (group by term, thread termId, live-term get-started)"
```

---

## Task 7: Split onboarding into a live-term gate and a multi-term display

**Files:**
- Modify: `src/modules/onboarding/services/onboarding.ts`
- Create: `src/modules/onboarding/services/onboarding.test.ts`

**Interfaces:**
- Consumes: `getPersonTerms` (Task 2), existing `getActiveTerm`.
- Produces: `computeOnboardingForTerm(personId: string, term: Term, exempt: boolean): Promise<OnboardingStatus>` (the old single-term body); `getOnboardingStatus(personId)` unchanged in behavior (live-term gate); new `getMyOnboarding(personId: string): Promise<TermOnboarding[]>` where `TermOnboarding = { term: { id: string; name: string }; status: OnboardingStatus }`, live-term first.

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/onboarding/services/onboarding.test.ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { setTrainingCycle } from "@/modules/recruitment/services/training";
import { getOnboardingStatus, getMyOnboarding } from "./onboarding";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function seedTermWithTraining(code: string, name: string, status: "ACTIVE" | "PLANNING", srrId: string) {
  const term = await prisma.term.create({ data: { code, name, startDate: new Date(code === "FA26" ? "2026-09-01" : "2026-05-30"), endDate: new Date(code === "FA26" ? "2027-01-01" : "2026-09-26"), status } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: `${code} vol`, publicSlug: `${code}-vol`, departments: ["SRHD"], createdById: srrId, status: "OPEN" } });
  await setTrainingCycle(cycle.id, true, srrId);
  return term;
}

async function seed() {
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec", grants: { create: [{ permission: "recruitment.manage_cycles" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const live = await seedTermWithTraining("SU26", "Summer", "ACTIVE", srr.id);
  const next = await seedTermWithTraining("FA26", "Fall", "PLANNING", srr.id);
  const vol = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: vol.id, termId: live.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: vol.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  return { vol, live, next };
}

it("getOnboardingStatus (the gate) reflects only the live term", async () => {
  const { vol } = await seed();
  const status = await getOnboardingStatus(vol.id);
  expect(status.hasActiveTerm).toBe(true);
  // The gate's training task exists for the live term only; it does not fold in the next term.
  expect(status.tasks.some((t) => t.key === "training")).toBe(true);
});

it("getMyOnboarding returns one entry per term the member belongs to, live first", async () => {
  const { vol } = await seed();
  const mine = await getMyOnboarding(vol.id);
  expect(mine.map((m) => m.term.name)).toEqual(["Summer", "Fall"]);
  // Each term carries its own training requirement (both have a designated cycle).
  expect(mine.every((m) => m.status.tasks.some((t) => t.key === "training"))).toBe(true);
});

it("a next-term-only recruit is not gated (live gate empty) but sees next-term onboarding", async () => {
  const dept = await prisma.department.findUniqueOrThrow({ where: { code: "SRHD" } });
  const { next } = await seed();
  const recruit = await prisma.person.create({ data: { name: "Recruit", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: recruit.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });

  const gate = await getOnboardingStatus(recruit.id);
  expect(gate.onboarded).toBe(true); // no live-term membership -> no live tasks -> not blocked

  const mine = await getMyOnboarding(recruit.id);
  expect(mine.map((m) => m.term.name)).toEqual(["Fall"]);
  expect(mine[0].status.onboarded).toBe(false); // their Fall training is still outstanding
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/onboarding/services/onboarding.test.ts`
Expected: FAIL (`getMyOnboarding` is not exported).

- [ ] **Step 3: Refactor `onboarding.ts`**

Add imports near the top of `src/modules/onboarding/services/onboarding.ts`:

```ts
import type { Term } from "@prisma/client";
import { getPersonTerms } from "@/platform/terms/person-terms";
```

Extract the body of the current `getOnboardingStatus` (everything from `const [person, certs, ...]` through the final `return { hasActiveTerm: true, ... }`) into a new exported helper that takes the term and the already-computed `exempt`, and rewrite `getOnboardingStatus` to delegate:

```ts
/** Compute a person's onboarding clearance for one specific term. */
export async function computeOnboardingForTerm(personId: string, term: Term, exempt: boolean): Promise<OnboardingStatus> {
  const [person, certs, courses, tracks, ehsItems, steps] = await Promise.all([
    prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { contactEmail: true, phone: true } }),
    listMyCertificates(personId),
    getMyCourses(personId),
    requiredTrainingTracks(personId, term.id),
    getMyEhsStatus(personId),
    loadEffectiveSteps(term.id),
  ]);

  // ... the existing buildTask closure, trainingEntries loop, entries array,
  //     sort, summarize, and computeGating logic, unchanged ...

  return { hasActiveTerm: true, exempt, tasks, completedCount, totalCount, onboarded, cleared };
}

/**
 * The live-term onboarding gate. Returns a dormant (onboarded:true) status when
 * there is no live term, so the gate never blocks. Drives enforceOnboarding and
 * any hard clearance decision. Next-term work is intentionally excluded here;
 * see getMyOnboarding for the merged display.
 */
export const getOnboardingStatus = cache(async function getOnboardingStatus(personId: string): Promise<OnboardingStatus> {
  const exempt = await can(personId, EXEMPT_PERMISSION);
  const term = await getActiveTerm();
  if (!term) {
    return { hasActiveTerm: false, exempt, tasks: [], completedCount: 0, totalCount: 0, onboarded: true, cleared: true };
  }
  return computeOnboardingForTerm(personId, term, exempt);
});

export type TermOnboarding = { term: { id: string; name: string }; status: OnboardingStatus };

/** The merged onboarding checklist across every term the member belongs to (live first). */
export const getMyOnboarding = cache(async function getMyOnboarding(personId: string): Promise<TermOnboarding[]> {
  const exempt = await can(personId, EXEMPT_PERMISSION);
  const terms = await getPersonTerms(personId);
  const out: TermOnboarding[] = [];
  for (const term of terms) {
    out.push({ term: { id: term.id, name: term.name }, status: await computeOnboardingForTerm(personId, term, exempt) });
  }
  return out;
});
```

Keep the `buildTask` closure, `trainingEntries` loop, `entries` array construction, `entries.sort`, `summarize`, and `computeGating` exactly as they are today, now living inside `computeOnboardingForTerm`.

- [ ] **Step 4: Run the onboarding + gate suites to verify pass + no regression**

Run: `npx vitest run src/modules/onboarding/services/onboarding.test.ts src/modules/onboarding/services/clearance.test.ts src/modules/onboarding/services/step-config.test.ts`
Expected: PASS (new onboarding tests pass; existing clearance/step-config tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/modules/onboarding/services/onboarding.ts src/modules/onboarding/services/onboarding.test.ts
git commit -m "feat(onboarding): split live-term gate from multi-term getMyOnboarding display"
```

---

## Task 8: Dashboard surfaces next-term training + per-term status

**Files:**
- Modify: `src/app/(app)/page.tsx`

**Interfaces:**
- Consumes: `getMyTraining` (Task 4), `getMyOnboarding` (Task 7), existing `getOnboardingStatus`, `buildActionCards` (unchanged).
- Produces: no new exports.

UI wiring; deliverable is `npx tsc --noEmit` clean and correct term-labeled rendering. The pure `buildActionCards` is unchanged, so its existing `action-cards.test.ts` still passes.

- [ ] **Step 1: Fetch the multi-term data**

In `src/app/(app)/page.tsx`, add the two new sources. Add imports:

```ts
import { getMyOnboarding } from "@/modules/onboarding/services/onboarding";
import { getMyTraining } from "@/modules/recruitment/services/training";
```

Add both to the existing `Promise.all` destructure (the block that currently resolves `onboarding` via `getOnboardingStatus`), e.g.:

```ts
  const [schedule, certificates, isPanelist, orgName, onboarding, myOnboarding, myTraining, pendingApprovals, recruitmentScope, displayZone] = await Promise.all([
    // ... existing entries ...
    getOnboardingStatus(person.personId),
    getMyOnboarding(person.personId),
    getMyTraining(person.personId),
    // ... existing entries ...
  ]);
```

- [ ] **Step 2: Training action-card signal spans all terms**

Replace the current `trainingTasks` derivation (the `onboarding.tasks.filter(...)` for training/directorTraining/learning) and the `trainingIncomplete` / `trainingHref` fields passed to `buildActionCards`. Compute the training count from `myTraining` (all terms) plus the live-term learning task:

```ts
  // Open trainings across every term the member belongs to (each needs a designated cycle).
  const openTrainings = myTraining.filter((m) => m.cycle && m.state !== "COMPLETE");
  const learningTask = onboarding.tasks.find(
    (t) => t.key === "learning" && t.state !== "COMPLETE" && t.state !== "NOT_REQUIRED",
  );
  const trainingIncomplete = openTrainings.length + (learningTask ? 1 : 0);
  const trainingHref = openTrainings.length > 0 ? "/training" : learningTask ? "/learning" : "/training";
```

Then in the `buildActionCards({ ... })` call, use these:

```ts
    trainingIncomplete,
    trainingHref,
```

(Leave `profileIncomplete: profileTask?.state === "INCOMPLETE"` and everything else as-is.)

- [ ] **Step 3: "Your status" rail renders one group per term**

Replace the single-term `clearanceTasks` / `statusLines` derivation and the rail body so it iterates `myOnboarding`. First, build per-term groups (keeping the existing `clearanceRow` mapping and the no-term HIPAA fallback):

```ts
  // One clearance group per term the member belongs to. Falls back to a single
  // term-independent HIPAA line when there is no term at all.
  const statusGroups = myOnboarding.length > 0
    ? myOnboarding.map((entry) => ({
        termId: entry.term.id,
        termName: entry.term.name,
        cleared: entry.status.cleared,
        lines: entry.status.tasks.filter((t) => t.state !== "NOT_REQUIRED").map((t) => clearanceRow(t, hipaaSub)),
      }))
    : [{
        termId: "none",
        termName: "",
        cleared: status === "COMPLIANT" || status === "EXPIRING_SOON",
        lines: [{ ok: status === "COMPLIANT" || status === "EXPIRING_SOON", title: "HIPAA certificate", sub: hipaaSub, href: "/my-info" }],
      }];
```

Then replace the rail `<Card>` body (the header pill + `statusLines.map`) so it renders each group, showing a term sub-heading only when there is more than one group (so the single-term dashboard looks unchanged):

```tsx
          <Card>
            <h3 className="text-xs font-bold uppercase tracking-wider text-subtle-foreground">Your status</h3>
            <div className="mt-2 flex flex-col gap-4">
              {statusGroups.map((group) => (
                <div key={group.termId}>
                  {statusGroups.length > 1 && group.termName && (
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-foreground-soft">{group.termName}</span>
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
                          group.cleared ? "text-success-foreground" : "text-warning-foreground"
                        }`}
                      >
                        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${group.cleared ? "bg-success" : "bg-warning"}`} />
                        {group.cleared ? "Cleared" : "Not yet cleared"}
                      </span>
                    </div>
                  )}
                  {group.lines.map((line) => (
                    <Link
                      key={`${group.termId}-${line.title}`}
                      href={line.href}
                      className="flex items-center gap-3 border-t border-border-subtle py-2.5 first:border-t-0 first:pt-1"
                    >
                      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${line.ok ? "bg-success text-white" : "bg-warning text-white"}`}>
                        {line.ok ? <Check aria-hidden className="h-4 w-4" /> : <Clock aria-hidden className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-foreground">{line.title}</span>
                        <span className="block text-xs text-muted-foreground">{line.sub}</span>
                      </span>
                      <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-subtle-foreground" />
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          </Card>
```

For the single-term case (`statusGroups.length === 1`), this renders exactly today's rail minus the top-right "Cleared" pill; if you want to preserve that pill for the single-term case, render it in the header row when `statusGroups.length === 1` using `statusGroups[0].cleared`. Keep `onboarding` (live-term) available for any other consumer on the page.

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors. (Remove any now-unused variables the edits orphaned, e.g. the old `clearanceTasks` / `statusLines` / `trainingTasks` if fully replaced.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/page.tsx"
git commit -m "feat(dashboard): surface next-term training + per-term clearance status"
```

---

## Final verification

- [ ] **Run the full affected test set**

Run: `npx vitest run src/platform/terms src/modules/recruitment/services/training.test.ts src/modules/onboarding`
Expected: PASS.

- [ ] **Full lint + typecheck (pre-push gate)**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors.

- [ ] **Manual smoke (optional, if a dev DB with two terms is available):** as a member with a live + next membership, `/training` shows two term-labeled sections; the next-term quiz submits and completes; the dashboard shows a next-term "Training" action card and a per-term "Your status" rail; the onboarding gate does not redirect for next-term-only incompleteness.
