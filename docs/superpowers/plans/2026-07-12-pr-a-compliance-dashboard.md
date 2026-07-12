# PR A: Compliance dashboard (full clearance + per-person view) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the volunteers compliance master view reflect *real* clearance (profile + HIPAA + training + learning + EHS) with an EHS column, and make clicking a person open a dedicated per-person compliance view instead of the generic admin record.

**Architecture:** Add a batched `loadClearanceMap(personIds, termId)` in the onboarding module that reuses the existing pure onboarding engine (`derive*`, `computeGating`) over bulk-loaded inputs, so the master/department services can attach a full `clearance` summary per person without an N+1. The master view gains EHS + Learning columns and a clearance-driven "Cleared" column; a new `/volunteers/compliance/[personId]` route renders the reusable `ClearanceCard` + HIPAA/EHS panels for any person.

**Tech Stack:** Next.js 16 App Router (server components), Prisma/Postgres, React, Tailwind, Vitest, Playwright.

## Global Constraints

- **NEVER run Vitest or Prisma migrate against the repo `.env` database URLs — they point at the shared production Neon DB and `resetDb` would wipe it.** Before running any test, set a per-worktree `TEST_DATABASE_URL` pointing at a throwaway LOCAL Postgres and run migrations against it. Confirm `echo $TEST_DATABASE_URL` is a localhost URL first.
- Do NOT run `prisma generate` (shared `node_modules` Prisma client across worktrees; regenerating can break sibling worktrees). Use the existing generated client.
- No em-dashes anywhere (copy or comments). Use commas, colons, parentheses.
- "HAVEN Hub" is two words in prose/UI; identifiers stay `havenhub`. Copy is sentence case, HAVEN voice.
- No `tailwind-merge`: passing `className` to override a primitive's classes is unreliable. Compose with wrapper elements, not class overrides.
- Modules import platform; cross-module imports are sanctioned exceptions only where precedent exists (onboarding already imports `@/modules/learning/*`).
- Tests are Vitest with `resetDb` from `@/platform/test/db` and direct-`prisma` fixtures (see `src/modules/volunteers/services/compliance.test.ts`). CI runs the full suite.
- Branch off `main`: `feat/compliance-full-clearance`. Frequent commits (one per task).

---

### Task 1: Bulk EHS items loader (`loadEhsItemsMap`)

Add a batched per-person EHS loader that returns each person's *required* EHS trainings with a completion flag, mirroring the existing `loadEhsMissingMap` but returning enough to derive an onboarding task state.

**Files:**
- Modify: `src/platform/ehs/services/status.ts` (add `loadEhsItemsMap`, append after `loadEhsMissingMap`)
- Test: `src/platform/ehs/services/status.test.ts` (add a `describe("loadEhsItemsMap")` block)

**Interfaces:**
- Produces: `loadEhsItemsMap(activeTermId: string): Promise<Map<string, { id: string; name: string; complete: boolean }[]>>`. Key = personId (only people with an active membership in the term appear). Value = the person's required EHS trainings, each flagged complete/incomplete. A person with an active membership but no required trainings maps to `[]`.

- [ ] **Step 1: Write the failing test**

Add to `src/platform/ehs/services/status.test.ts`. It reuses the file's existing imports (`prisma`, `resetDb`, `buildBaseFixtures`, `createTraining`, `setTrainingDepartments`, `markEhsComplete`) and adds `loadEhsItemsMap` to the import from `./status`:

```ts
describe("loadEhsItemsMap", () => {
  it("returns required trainings per person with completion flags", async () => {
    const { actor, term, person } = await buildBaseFixtures();
    const training = await createTraining({ name: "BBP Clinical", requiredForAll: true }, actor.id);

    const before = await loadEhsItemsMap(term.id);
    const beforeItems = before.get(person.id);
    expect(beforeItems).toBeDefined();
    expect(beforeItems!.find((i) => i.id === training.id)).toEqual({
      id: training.id,
      name: "BBP Clinical",
      complete: false,
    });

    await markEhsComplete(person.id, training.id, actor.id);

    const after = await loadEhsItemsMap(term.id);
    expect(after.get(person.id)!.find((i) => i.id === training.id)!.complete).toBe(true);
  });

  it("maps a member with no required trainings to an empty array", async () => {
    const { term, person } = await buildBaseFixtures();
    // No active trainings created, so nothing is required.
    const map = await loadEhsItemsMap(term.id);
    expect(map.get(person.id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=<local> npx vitest run src/platform/ehs/services/status.test.ts -t "loadEhsItemsMap"`
Expected: FAIL with "loadEhsItemsMap is not a function" / import error.

- [ ] **Step 3: Write the implementation**

Append to `src/platform/ehs/services/status.ts` (the file already imports `prisma`, `isStudentAffiliation`, `requiredTrainingsForMember`, `RequirableTraining`, and defines `loadCatalog`):

```ts
/**
 * Batched sibling of loadEhsMissingMap: per active-term member, the EHS trainings
 * required of them, each flagged complete. Returns [] for members with no required
 * trainings. Used by the clearance engine to derive the EHS onboarding task in bulk.
 */
export async function loadEhsItemsMap(
  activeTermId: string
): Promise<Map<string, { id: string; name: string; complete: boolean }[]>> {
  const catalog = await loadCatalog();

  const memberships = (await prisma.termMembership.findMany({
    where: { termId: activeTermId, status: "ACTIVE" },
    select: {
      personId: true,
      departmentId: true,
      person: {
        select: {
          yaleAffiliation: true,
          ehsCompletions: { select: { trainingId: true } },
        },
      },
    },
  })) as Array<{
    personId: string;
    departmentId: string;
    person: { yaleAffiliation: string | null; ehsCompletions: { trainingId: string }[] };
  }>;

  const deptsByPerson = new Map<string, Set<string>>();
  const completedByPerson = new Map<string, Set<string>>();
  const affiliationByPerson = new Map<string, string | null>();
  for (const m of memberships) {
    if (!deptsByPerson.has(m.personId)) deptsByPerson.set(m.personId, new Set());
    deptsByPerson.get(m.personId)!.add(m.departmentId);
    if (!completedByPerson.has(m.personId)) {
      completedByPerson.set(m.personId, new Set(m.person.ehsCompletions.map((c) => c.trainingId)));
      affiliationByPerson.set(m.personId, m.person.yaleAffiliation);
    }
  }

  const out = new Map<string, { id: string; name: string; complete: boolean }[]>();
  for (const [personId, deptSet] of deptsByPerson) {
    const isStudent = isStudentAffiliation(affiliationByPerson.get(personId));
    const required = requiredTrainingsForMember({
      trainings: catalog,
      memberDepartmentIds: [...deptSet],
      isStudent,
    });
    const completed = completedByPerson.get(personId) ?? new Set<string>();
    out.set(
      personId,
      required.map((t) => ({ id: t.id, name: t.name, complete: completed.has(t.id) }))
    );
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=<local> npx vitest run src/platform/ehs/services/status.test.ts -t "loadEhsItemsMap"`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/platform/ehs/services/status.ts src/platform/ehs/services/status.test.ts
git commit -m "feat(ehs): add loadEhsItemsMap batched required-items loader"
```

---

### Task 2: Batched clearance map (`loadClearanceMap`)

The keystone. A batched per-person clearance computation that reuses the pure onboarding engine and agrees with `getOnboardingStatus` on the `onboarded`/`cleared` gates.

**Files:**
- Create: `src/modules/onboarding/services/clearance.ts`
- Test: `src/modules/onboarding/services/clearance.test.ts`

**Interfaces:**
- Consumes: `loadEhsItemsMap` (Task 1); the pure engine from `../engine/status`; `coursesForMember`/`deriveStatus` from the learning module; `complianceStatus` from platform.
- Produces:
  - `type ClearanceTask = { key: OnboardingTaskKey; state: OnboardingTaskState; blocking: boolean }`
  - `type ClearanceSummary = { onboarded: boolean; cleared: boolean; tasks: ClearanceTask[]; missing: OnboardingTaskKey[] }`
  - `loadClearanceMap(personIds: string[], termId: string): Promise<Map<string, ClearanceSummary>>` — every input personId appears in the map. `missing` = task keys not satisfied (not COMPLETE and not NOT_REQUIRED).

- [ ] **Step 1: Write the failing test**

Create `src/modules/onboarding/services/clearance.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { loadClearanceMap } from "./clearance";
import { getOnboardingStatus } from "./onboarding";

beforeEach(resetDb);

async function activeTerm() {
  return prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-09-26"),
      status: "ACTIVE",
    },
  });
}

async function memberWithProfile(name: string, deptId: string, termId: string) {
  const person = await prisma.person.create({
    data: { name, status: "ACTIVE", contactEmail: `${name}@x.edu`, phone: "555-0100" },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId, departmentId: deptId, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  return person;
}

async function validCert(personId: string) {
  await prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "c.pdf",
      storedName: `c-${personId}.pdf`,
      size: 100,
      mimeType: "application/pdf",
      completionDate: new Date(), // valid ~365d, well past term end + 30d
      verifiedAt: new Date(),
      uploadedAt: new Date(),
    },
  });
}

describe("loadClearanceMap", () => {
  it("marks a person with profile + valid HIPAA and no other requirements as cleared", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const person = await memberWithProfile("Ada", dept.id, term.id);
    await validCert(person.id);

    const map = await loadClearanceMap([person.id], term.id);
    const summary = map.get(person.id)!;
    expect(summary.cleared).toBe(true);
    expect(summary.onboarded).toBe(true);
    expect(summary.missing).toEqual([]);
  });

  it("flags a missing profile (no phone) as not cleared, with profile in missing", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const person = await prisma.person.create({
      data: { name: "Noe", status: "ACTIVE", contactEmail: "noe@x.edu" }, // no phone
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    await validCert(person.id);

    const map = await loadClearanceMap([person.id], term.id);
    const summary = map.get(person.id)!;
    expect(summary.cleared).toBe(false);
    expect(summary.missing).toContain("profile");
  });

  it("flags a required-but-incomplete EHS training in missing (and not cleared)", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const person = await memberWithProfile("Ivy", dept.id, term.id);
    await validCert(person.id);
    // A required-for-all active EHS training the person has not completed.
    await prisma.ehsTraining.create({ data: { name: "BBP", requiredForAll: true, isActive: true } });

    const map = await loadClearanceMap([person.id], term.id);
    const summary = map.get(person.id)!;
    expect(summary.missing).toContain("ehs");
    expect(summary.cleared).toBe(false);
    // EHS is non-blocking, so the app-gate flag stays true even though not fully cleared.
    expect(summary.onboarded).toBe(true);
  });

  it("agrees with getOnboardingStatus on cleared/onboarded", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
    const person = await memberWithProfile("Rio", dept.id, term.id);
    await validCert(person.id);

    const [batch, single] = await Promise.all([
      loadClearanceMap([person.id], term.id),
      getOnboardingStatus(person.id),
    ]);
    const summary = batch.get(person.id)!;
    expect(summary.cleared).toBe(single.cleared);
    expect(summary.onboarded).toBe(single.onboarded);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=<local> npx vitest run src/modules/onboarding/services/clearance.test.ts`
Expected: FAIL with module-not-found for `./clearance`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/onboarding/services/clearance.ts`:

```ts
import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { complianceStatus } from "@/platform/compliance/rules";
import { loadEhsItemsMap } from "@/platform/ehs/services/status";
import {
  coursesForMember,
  type AssignableCourse,
  type MemberMembership,
} from "@/modules/learning/engine/assignment";
import { deriveStatus } from "@/modules/learning/engine/status";
import {
  deriveProfileTaskState,
  deriveHipaaTaskState,
  deriveLearningTaskState,
  deriveEhsTaskState,
  computeGating,
  isSatisfied,
  type OnboardingTaskKey,
  type OnboardingTaskState,
} from "../engine/status";

export type ClearanceTask = { key: OnboardingTaskKey; state: OnboardingTaskState; blocking: boolean };
export type ClearanceSummary = {
  onboarded: boolean;
  cleared: boolean;
  tasks: ClearanceTask[];
  /** Task keys not satisfied (i.e. neither COMPLETE nor NOT_REQUIRED). */
  missing: OnboardingTaskKey[];
};

/**
 * Batched clearance for many people in one term. Reuses the exact pure engine that
 * getOnboardingStatus uses, over bulk-loaded inputs, so it agrees with the single-person
 * path on the onboarded/cleared gates. Training here is COMPLETE-or-INCOMPLETE only (the
 * IN_PROGRESS nuance the checklist shows is irrelevant to gating), which is why it does not
 * count quiz attempts. Every input personId is present in the result.
 */
export async function loadClearanceMap(
  personIds: string[],
  termId: string
): Promise<Map<string, ClearanceSummary>> {
  const out = new Map<string, ClearanceSummary>();
  if (personIds.length === 0) return out;

  const term = await prisma.term.findUnique({ where: { id: termId }, select: { endDate: true } });
  const termEnd = term?.endDate ?? null;

  const [persons, memberships, certRows, trainingRows, designatedCycles, activeCourses, ehsItemsMap] =
    await Promise.all([
      prisma.person.findMany({
        where: { id: { in: personIds } },
        select: { id: true, contactEmail: true, phone: true },
      }),
      prisma.termMembership.findMany({
        where: { personId: { in: personIds }, termId, status: "ACTIVE" },
        select: { personId: true, kind: true, departmentId: true },
      }),
      prisma.hipaaCertificate.findMany({
        where: { personId: { in: personIds } },
        orderBy: { uploadedAt: "desc" },
        select: { personId: true, completionDate: true, verifiedAt: true },
      }),
      prisma.training.findMany({
        where: { personId: { in: personIds }, termId, status: "COMPLETE" },
        select: { personId: true, track: true },
      }),
      prisma.recruitmentCycle.findMany({
        where: { termId, isTermTraining: true },
        select: { track: true },
      }),
      prisma.course.findMany({
        where: { isActive: true },
        select: {
          id: true,
          isActive: true,
          assignToAll: true,
          audience: true,
          scormEntryHref: true,
          departments: { select: { departmentId: true } },
        },
      }),
      loadEhsItemsMap(termId),
    ]);

  // Newest cert per person (rows are uploadedAt desc; first seen wins).
  const certByPerson = new Map<string, { completionDate: Date | null; verifiedAt: Date | null }>();
  for (const c of certRows) {
    if (!certByPerson.has(c.personId)) {
      certByPerson.set(c.personId, { completionDate: c.completionDate, verifiedAt: c.verifiedAt });
    }
  }

  const membershipsByPerson = new Map<string, MemberMembership[]>();
  const kindsByPerson = new Map<string, Set<Track>>();
  for (const m of memberships) {
    if (!membershipsByPerson.has(m.personId)) {
      membershipsByPerson.set(m.personId, []);
      kindsByPerson.set(m.personId, new Set());
    }
    membershipsByPerson.get(m.personId)!.push({ departmentId: m.departmentId, kind: m.kind });
    kindsByPerson.get(m.personId)!.add(m.kind);
  }

  const completeTrack = new Set(trainingRows.map((t) => `${t.personId}:${t.track}`));
  const designatedTracks = new Set(designatedCycles.map((c) => c.track));

  const assignable: AssignableCourse[] = activeCourses.map((c) => ({
    id: c.id,
    isActive: c.isActive,
    assignToAll: c.assignToAll,
    departmentIds: c.departments.map((d) => d.departmentId),
    hasPackage: c.scormEntryHref != null,
    audience: c.audience,
  }));
  const activeCourseIds = assignable.map((c) => c.id);
  const progressRows = activeCourseIds.length
    ? await prisma.courseProgress.findMany({
        where: { personId: { in: personIds }, courseId: { in: activeCourseIds } },
        select: { personId: true, courseId: true, lessonStatus: true },
      })
    : [];
  const progressByPerson = new Map<string, Map<string, string | null>>();
  for (const p of progressRows) {
    if (!progressByPerson.has(p.personId)) progressByPerson.set(p.personId, new Map());
    progressByPerson.get(p.personId)!.set(p.courseId, p.lessonStatus);
  }

  const profileByPerson = new Map(persons.map((p) => [p.id, p]));

  for (const personId of personIds) {
    const profile = profileByPerson.get(personId) ?? { contactEmail: null, phone: null };
    const cert = certByPerson.get(personId) ?? null;
    const personMemberships = membershipsByPerson.get(personId) ?? [];
    const kinds = kindsByPerson.get(personId) ?? new Set<Track>();

    const trainingTasks: ClearanceTask[] = [];
    for (const track of ["VOLUNTEER", "DIRECTOR"] as Track[]) {
      const required = kinds.has(track) && designatedTracks.has(track);
      if (!required) continue;
      const state: OnboardingTaskState = completeTrack.has(`${personId}:${track}`)
        ? "COMPLETE"
        : "INCOMPLETE";
      trainingTasks.push({
        key: track === "DIRECTOR" ? "directorTraining" : "training",
        state,
        blocking: true,
      });
    }

    const assignedIds = coursesForMember({ courses: assignable, memberships: personMemberships });
    const personProgress = progressByPerson.get(personId);
    const learningCourses = assignedIds.map((id) => {
      const ls = personProgress?.get(id);
      const status = ls == null ? ("NOT_STARTED" as const) : deriveStatus(ls).status;
      return { status };
    });

    const ehsItems = ehsItemsMap.get(personId) ?? [];

    const tasks: ClearanceTask[] = [
      { key: "profile", state: deriveProfileTaskState(profile), blocking: true },
      { key: "hipaa", state: deriveHipaaTaskState(complianceStatus(cert, termEnd)), blocking: true },
      ...trainingTasks,
      { key: "learning", state: deriveLearningTaskState(learningCourses), blocking: true },
      { key: "ehs", state: deriveEhsTaskState(ehsItems), blocking: false },
    ];

    const { onboarded, cleared } = computeGating(tasks);
    const missing = tasks.filter((t) => !isSatisfied(t.state)).map((t) => t.key);
    out.set(personId, { onboarded, cleared, tasks, missing });
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=<local> npx vitest run src/modules/onboarding/services/clearance.test.ts`
Expected: PASS (all four cases, including agreement with `getOnboardingStatus`).

- [ ] **Step 5: Commit**

```bash
git add src/modules/onboarding/services/clearance.ts src/modules/onboarding/services/clearance.test.ts
git commit -m "feat(onboarding): add batched loadClearanceMap reusing the onboarding engine"
```

---

### Task 3: Attach `clearance` to compliance rows (service, additive)

Add the `clearance` summary to master and department rows using `loadClearanceMap`, plus clearance-driven summary counts on the master result. **Additive:** leave the existing `overallClearance` field untouched so no existing test changes here (its retirement is Task 7).

**Files:**
- Modify: `src/modules/volunteers/services/compliance.ts`
- Test: `src/modules/volunteers/services/compliance.test.ts` (add assertions; do not change existing ones)

**Interfaces:**
- Consumes: `loadClearanceMap`, `ClearanceSummary` (Task 2).
- Produces: `MemberCompliance` and `MasterComplianceRow` gain `clearance: ClearanceSummary`. `MasterComplianceResult` gains `clearedCount: number` and `ehsMissingCount: number`.

- [ ] **Step 1: Write the failing test**

Add to `src/modules/volunteers/services/compliance.test.ts` a new `describe` (reusing the file's `createPerson`, `createTerm`, `createDepartment`, `createMembership`, `createCert`, `daysFromNow` helpers). Note `createPerson` does not set contactEmail/phone, so extend inline for the cleared case:

```ts
describe("masterCompliance clearance field", () => {
  it("reports cleared=true only when profile + HIPAA + (no other reqs) are satisfied", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await prisma.person.update({
      where: { id: (await createPerson("Cleared Cathy", "cc1")).id },
      data: { contactEmail: "cc@x.edu", phone: "555-1000" },
    });
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await createCert(person.id, daysFromNow(0), new Date(), daysFromNow(0)); // valid + verified

    const res = await masterCompliance({});
    const row = res.rows.find((r) => r.person.id === person.id)!;
    expect(row.clearance.cleared).toBe(true);
    expect(res.clearedCount).toBeGreaterThanOrEqual(1);
  });

  it("reports cleared=false and ehsMissingCount when a required EHS training is incomplete", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await prisma.person.update({
      where: { id: (await createPerson("Ehs Eddie", "ee1")).id },
      data: { contactEmail: "ee@x.edu", phone: "555-2000" },
    });
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await createCert(person.id, daysFromNow(0), new Date(), daysFromNow(0));
    await prisma.ehsTraining.create({ data: { name: "BBP", requiredForAll: true, isActive: true } });

    const res = await masterCompliance({});
    const row = res.rows.find((r) => r.person.id === person.id)!;
    expect(row.clearance.cleared).toBe(false);
    expect(row.clearance.missing).toContain("ehs");
    expect(res.ehsMissingCount).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=<local> npx vitest run src/modules/volunteers/services/compliance.test.ts -t "clearance field"`
Expected: FAIL (`clearance`/`clearedCount` undefined).

- [ ] **Step 3: Write the implementation**

In `src/modules/volunteers/services/compliance.ts`:

1. Add import near the top (after the existing imports):

```ts
import { loadClearanceMap, type ClearanceSummary } from "@/modules/onboarding/services/clearance";
```

2. Add `clearance` to the `MemberCompliance` type:

```ts
export type MemberCompliance = {
  person: Person;
  kind: "DIRECTOR" | "VOLUNTEER";
  cert: HipaaCertificate | null;
  status: ComplianceStatus;
  verifiedByName: string | null;
  trainingState: TrainingState;
  overallClearance: OverallClearance;
  clearance: ClearanceSummary;
};
```

3. Add the two counts to `MasterComplianceResult`:

```ts
export type MasterComplianceResult = {
  rows: MasterComplianceRow[];
  total: number;
  page: number;
  pageCount: number;
  summary: Record<ComplianceStatus, number>;
  clearedCount: number;
  ehsMissingCount: number;
};
```

4. In `departmentCompliance`, after all `entry.members` are built (right before the "6. Sort members" section at line ~194), load clearance for every member and attach it:

```ts
  // Attach full clearance (profile + HIPAA + training + learning + EHS) per member.
  const allMemberIds = [...deptMap.values()].flatMap((e) => e.members.map((m) => m.person.id));
  const clearanceMap = await loadClearanceMap(allMemberIds, activeTerm.id);
  const emptyClearance: ClearanceSummary = { onboarded: true, cleared: true, tasks: [], missing: [] };
  for (const entry of deptMap.values()) {
    for (const m of entry.members) {
      (m as MemberCompliance).clearance = clearanceMap.get(m.person.id) ?? emptyClearance;
    }
  }
```

   Since `entry.members.push({...})` currently builds objects without `clearance`, change that push (line ~183) to include a placeholder so the type is satisfied, then the loop above fills it. Simplest: add `clearance: { onboarded: true, cleared: true, tasks: [], missing: [] }` to the pushed object literal, then overwrite in the loop. (Both are cheap; keep the overwrite loop as the source of truth.)

5. In `masterCompliance`, after `scopeRows` is built (line ~409) and BEFORE the summary loop, load clearance for the full scope and attach + count:

```ts
  // Full clearance for the whole scope (matches how summary is computed pre-pagination).
  const scopeIds = scopeRows.map((r) => r.person.id);
  const clearanceMap = await loadClearanceMap(scopeIds, activeTerm.id);
  const emptyClearance: ClearanceSummary = { onboarded: true, cleared: true, tasks: [], missing: [] };
  for (const row of scopeRows) {
    row.clearance = clearanceMap.get(row.person.id) ?? emptyClearance;
  }
  const clearedCount = scopeRows.filter((r) => r.clearance.cleared).length;
  const ehsMissingCount = scopeRows.filter((r) => r.clearance.missing.includes("ehs")).length;
```

   Add `clearance` to the `scopeRows` object literal (line ~398) as a placeholder (`clearance: { onboarded: true, cleared: true, tasks: [], missing: [] }`) so the map callback type-checks, then the loop overwrites it.

6. Update the final `return` of `masterCompliance` to include the counts:

```ts
  return { rows, total, page, pageCount, summary, clearedCount, ehsMissingCount };
```

7. Update the no-active-term early return of `masterCompliance` (line ~285) to include the new fields:

```ts
    return { rows: [], total: 0, page: 1, pageCount: 0, summary: { ...EMPTY_SUMMARY }, clearedCount: 0, ehsMissingCount: 0 };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL=<local> npx vitest run src/modules/volunteers/services/compliance.test.ts`
Expected: PASS (new clearance cases AND all pre-existing cases, since `overallClearance` is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/modules/volunteers/services/compliance.ts src/modules/volunteers/services/compliance.test.ts
git commit -m "feat(volunteers): attach full clearance summary to compliance rows"
```

---

### Task 4: Master view UI — EHS + Learning columns, clearance-driven Cleared, per-person link

**Files:**
- Modify: `src/app/(app)/volunteers/master/page.tsx`

**Interfaces:**
- Consumes: `row.clearance` (Task 3), the new `/volunteers/compliance/[personId]` route (Task 5).

- [ ] **Step 1: Add EHS + Learning column helpers and headers**

Near the top of the file (after `STATUS_TONE`), add a small helper mapping an `OnboardingTaskState` to a badge tone/label, and a helper to read a task's state from `row.clearance.tasks`:

```tsx
import type { OnboardingTaskKey, OnboardingTaskState } from "@/modules/onboarding/engine/status";

function taskState(clearance: { tasks: { key: OnboardingTaskKey; state: OnboardingTaskState }[] }, key: OnboardingTaskKey): OnboardingTaskState | null {
  return clearance.tasks.find((t) => t.key === key)?.state ?? null;
}

const TASK_STATE_LABEL: Record<OnboardingTaskState, string> = {
  COMPLETE: "Complete",
  IN_PROGRESS: "In progress",
  INCOMPLETE: "Incomplete",
  NOT_REQUIRED: "Not required",
};
const TASK_STATE_TONE: Record<OnboardingTaskState, Tone> = {
  COMPLETE: "success",
  IN_PROGRESS: "warning",
  INCOMPLETE: "critical",
  NOT_REQUIRED: "default",
};
```

- [ ] **Step 2: Add two clearance StatCards**

After the closing `</div>` of the existing 6-card summary grid (line ~224), add a second small grid:

```tsx
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-2">
        <StatCard label="Fully cleared" value={result.clearedCount} tone="success" />
        <StatCard label="Missing EHS" value={result.ehsMissingCount} tone="warning" />
      </div>
```

- [ ] **Step 3: Add table headers for EHS and Learning**

In the `<THead>` `<TR>` (lines ~294-304), insert two headers after `<TH>Training</TH>`:

```tsx
                  <TH>Training</TH>
                  <TH>Learning</TH>
                  <TH>EHS</TH>
                  <TH>Overall</TH>
```

- [ ] **Step 4: Render the Learning + EHS cells and switch Overall to clearance**

Replace the Overall `<TD>` block (lines ~345-357) and insert Learning + EHS cells before it. The Overall cell now shows for ALL rows (not just volunteers), driven by `row.clearance.cleared`:

```tsx
                      <TD>
                        {(() => {
                          const s = taskState(row.clearance, "learning");
                          return s ? <Badge tone={TASK_STATE_TONE[s]}>{TASK_STATE_LABEL[s]}</Badge> : <span className="text-subtle-foreground">-</span>;
                        })()}
                      </TD>
                      <TD>
                        {(() => {
                          const s = taskState(row.clearance, "ehs");
                          return s ? <Badge tone={TASK_STATE_TONE[s]}>{TASK_STATE_LABEL[s]}</Badge> : <span className="text-subtle-foreground">-</span>;
                        })()}
                      </TD>
                      <TD>
                        <Badge tone={row.clearance.cleared ? "success" : "critical"}>
                          {row.clearance.cleared ? "Cleared" : "Not cleared"}
                        </Badge>
                      </TD>
```

- [ ] **Step 5: Point the person link at the new per-person compliance view (all compliance managers)**

Replace the name-cell link block (lines ~314-325). Drop the `isAdmin`-only gate so every `volunteers.manage_compliance` viewer gets the link, and target the new route. (The `isAdmin` const at line 134 is now used only for `canEditExistingDate` on the CertificateViewer, so keep it.)

```tsx
                      <TD className="font-medium">
                        <Link
                          href={`/volunteers/compliance/${row.person.id}`}
                          className="text-brand-fg underline underline-offset-2 hover:opacity-75"
                        >
                          {row.person.name}
                        </Link>
                      </TD>
```

- [ ] **Step 6: Update the page subtitle**

Change the `PageHeader` description (line ~183) from `"HIPAA compliance status across all active clinic members."` to `"Full clearance status across all active clinic members: HIPAA, training, learning, and EHS."`

- [ ] **Step 7: Typecheck + lint**

Run: `npx tsc --noEmit` and `npx next lint --file src/app/(app)/volunteers/master/page.tsx` (or the repo's lint script).
Expected: no errors. (No unit test for the page; e2e covers it in Task 8.)

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/volunteers/master/page.tsx"
git commit -m "feat(volunteers): show EHS, learning, and full clearance in master view"
```

---

### Task 5: Dedicated per-person compliance view

A new route rendering the reusable `ClearanceCard` + HIPAA panel (with manager set-date/verify) + EHS panel + learning list for any person, gated by `volunteers.manage_compliance`.

**Files:**
- Create: `src/app/(app)/volunteers/compliance/[personId]/page.tsx`

**Interfaces:**
- Consumes: `getOnboardingStatus(personId)`, `listMyCertificates(personId)`, `getMyEhsStatus(personId)`, `getMyCourses(personId)`, `complianceStatus`, `ClearanceCard`/`certRequirement`/`taskRequirement`, `HipaaPanel`-less cert display via `CertificateViewer`, `setCompletionDateAsManager`/`verifyCertificate`, `EhsPanel`.

- [ ] **Step 1: Create the route**

Create `src/app/(app)/volunteers/compliance/[personId]/page.tsx`. This mirrors the read-model of `/my-info` but for an arbitrary person and swaps self-service cert upload for the manager cert actions used in the master list. Single person, so it calls `getOnboardingStatus` directly (cheap):

```tsx
import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { revalidatePath } from "next/cache";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { can } from "@/platform/rbac/engine";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { listMyCertificates } from "@/modules/my-info/services/my-info";
import { getMyEhsStatus } from "@/platform/ehs/services/my-ehs";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import { complianceStatus, certExpiresAt } from "@/platform/compliance/rules";
import { ClearanceCard, certRequirement, taskRequirement } from "@/modules/my-info/components/clearance-card";
import { EhsPanel } from "@/modules/my-info/components/ehs-panel";
import { CertificateViewer } from "@/modules/my-info/components/certificate-viewer";
import {
  setCompletionDateAsManager,
  verifyCertificate,
  ComplianceForbiddenError,
  CertificateNotFoundError,
} from "@/modules/volunteers/services/compliance";
import { CompletionDateError } from "@/platform/compliance/completion-date";
import { fmtDate } from "@/platform/dates";

type PageProps = { params: Promise<{ personId: string }> };

export default async function PersonCompliancePage({ params }: PageProps) {
  const viewer = await requirePermission("volunteers.manage_compliance");
  const { personId } = await params;

  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: { id: true, name: true, netId: true },
  });
  if (!person) notFound();

  const activeTerm = await getActiveTerm();
  const [onboarding, certificates, ehsItems, courses] = await Promise.all([
    getOnboardingStatus(personId),
    listMyCertificates(personId),
    getMyEhsStatus(personId),
    getMyCourses(personId),
  ]);

  const newestCert = certificates[0] ?? null;
  const status = complianceStatus(newestCert, activeTerm?.endDate ?? null);

  const requirements = onboarding.tasks
    .filter((t) => t.state !== "NOT_REQUIRED")
    .map((t) => (t.key === "hipaa" ? certRequirement(status) : taskRequirement(t.label, t.state)));

  const isAdmin = await can(viewer.personId, "admin.access");

  async function setDateAction(certId: string, dateIso: string): Promise<{ error?: string }> {
    "use server";
    const actor = await requirePermission("volunteers.manage_compliance");
    try {
      await setCompletionDateAsManager(actor.personId, certId, dateIso);
    } catch (err) {
      if (err instanceof CompletionDateError) return { error: err.reason };
      if (err instanceof ComplianceForbiddenError) return { error: err.message };
      if (err instanceof CertificateNotFoundError) return { error: "Certificate not found." };
      throw err;
    }
    revalidatePath(`/volunteers/compliance/${personId}`);
    return {};
  }

  async function verifyAction(certId: string): Promise<{ error?: string }> {
    "use server";
    const actor = await requirePermission("volunteers.manage_compliance");
    try {
      await verifyCertificate(actor.personId, certId);
    } catch (err) {
      if (err instanceof ComplianceForbiddenError) return { error: err.message };
      if (err instanceof CertificateNotFoundError) return { error: "Certificate not found." };
      throw err;
    }
    revalidatePath(`/volunteers/compliance/${personId}`);
    return {};
  }

  const expiresAt = newestCert?.completionDate ? certExpiresAt(newestCert.completionDate) : null;

  return (
    <div>
      <div className="mb-2">
        <Link href="/volunteers/master" className="text-sm text-brand-fg hover:opacity-75">
          Back to master compliance
        </Link>
      </div>
      <PageHeader
        title={person.name}
        description={person.netId ? `NetID ${person.netId}` : "Compliance and clearance detail"}
      />

      <div className="mt-8 space-y-10">
        <section>
          <SectionHeader className="mb-4">Clearance</SectionHeader>
          <ClearanceCard
            requirements={requirements}
            cleared={onboarding.cleared}
            termName={activeTerm?.name ?? null}
          />
        </section>

        <section>
          <SectionHeader className="mb-4">HIPAA certificate</SectionHeader>
          {newestCert ? (
            <div className="flex flex-wrap items-center gap-4">
              <Badge tone={status === "COMPLIANT" || status === "EXPIRING_SOON" ? "success" : "critical"}>
                {status}
              </Badge>
              <span className="text-sm text-foreground-soft tabular-nums">
                Completed {fmtDate(newestCert.completionDate)} · Expires {fmtDate(expiresAt)}
              </span>
              <CertificateViewer
                certId={newestCert.id}
                fileName={newestCert.fileName}
                ownerName={person.name}
                completionDate={newestCert.completionDate}
                canEditDate
                canEditExistingDate={isAdmin}
                onSetDate={setDateAction.bind(null, newestCert.id)}
                canVerify
                verified={Boolean(newestCert.verifiedAt)}
                onVerify={verifyAction.bind(null, newestCert.id)}
              />
            </div>
          ) : (
            <p className="text-sm text-foreground-soft">No certificate on file.</p>
          )}
        </section>

        <section>
          <SectionHeader className="mb-4">EHS training</SectionHeader>
          <EhsPanel items={ehsItems} />
        </section>

        <section>
          <SectionHeader className="mb-4">Learning</SectionHeader>
          {courses.length === 0 ? (
            <p className="text-sm text-foreground-soft">No courses assigned.</p>
          ) : (
            <ul className="divide-y divide-border-subtle rounded-lg border border-border">
              {courses.map((c) => (
                <li key={c.id} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm font-medium text-foreground">{c.title}</span>
                  <Badge tone={c.status === "COMPLETE" ? "success" : c.status === "IN_PROGRESS" ? "warning" : "default"}>
                    {c.status === "COMPLETE" ? "Complete" : c.status === "IN_PROGRESS" ? "In progress" : "Not started"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
```

Note: confirm `listMyCertificates` returns objects with `id`, `fileName`, `completionDate`, `verifiedAt` (the my-info page passes these same fields to `CertificateViewer`), and that `certExpiresAt` is exported from `@/platform/compliance/rules` (it is). If `CertificateViewer`'s prop names differ, mirror exactly how `master/page.tsx` calls it (that is the source of truth).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/volunteers/compliance/[personId]/page.tsx"
git commit -m "feat(volunteers): add dedicated per-person compliance view"
```

---

### Task 6: Department compliance view reflects full clearance (UI)

Make the director-facing `/volunteers` view show the same full-clearance signal. Small UI change: switch the Overall badge to `member.clearance.cleared`.

**Files:**
- Modify: `src/app/(app)/volunteers/page.tsx` (read it first to find the Overall/`overallClearance` render site)

**Interfaces:**
- Consumes: `member.clearance` (Task 3).

- [ ] **Step 1: Read the page and locate the clearance render**

Run: open `src/app/(app)/volunteers/page.tsx`; find where each member renders `overallClearance` (a Cleared/Not Cleared badge) and where the per-member cells are.

- [ ] **Step 2: Switch the Overall badge to full clearance and add an EHS indicator**

Replace the `member.overallClearance === "CLEARED"` badge with `member.clearance.cleared`, and (if the layout is a table) add an EHS cell mirroring Task 4's `taskState(member.clearance, "ehs")`. Keep copy sentence case ("Cleared" / "Not cleared").

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
```bash
git add "src/app/(app)/volunteers/page.tsx"
git commit -m "feat(volunteers): department compliance view uses full clearance"
```

---

### Task 7 (severable): Retire the legacy 2-factor `overallClearance`

Now that `clearance.cleared` drives every surface, remove the superseded `overallClearance` field so there is one clearance definition. **If the existing-test churn is large, stop and ship Tasks 1-6 as PR A, and do this as a fast follow.**

**Files:**
- Modify: `src/modules/volunteers/services/compliance.ts` (remove `overallClearance` field + the `overallClearance` value import; keep `OverallClearance` type only if still referenced elsewhere, else remove)
- Modify: `src/modules/volunteers/services/compliance.test.ts` (replace `overallClearance` assertions with `clearance.cleared`; add `contactEmail`/`phone` to fixtures expected to be cleared; account for training being required only when a designated training cycle exists)
- Grep first: `rg "overallClearance" src` to find every consumer (the `training.ts` `listTrainingRoster` also returns `overallClearance` from the pure `rules.ts` helper — that is a DIFFERENT, legitimate use of the rules function and should be LEFT ALONE; only the volunteers-compliance row field is being retired).

- [ ] **Step 1: Grep every reference; confirm scope**

Run: `rg -n "overallClearance" src`
Expected: references in `compliance.ts`, `compliance.test.ts`, the two volunteers pages, `rules.ts` (definition), and `training.ts` (`listTrainingRoster` — leave as-is).

- [ ] **Step 2: Remove the field + update tests**

Delete `overallClearance` from `MemberCompliance` and stop setting it in both services. Update each `compliance.test.ts` assertion that read `overallClearance` to read `clearance.cleared`, adjusting fixtures (add contactEmail/phone) so previously-"CLEARED" people stay cleared under the fuller definition.

- [ ] **Step 3: Run the full volunteers suite**

Run: `TEST_DATABASE_URL=<local> npx vitest run src/modules/volunteers`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/volunteers "src/app/(app)/volunteers"
git commit -m "refactor(volunteers): retire legacy 2-factor overallClearance in favor of full clearance"
```

---

### Task 8: e2e — master click-through and clearance reflect

**Files:**
- Create or extend: `e2e/volunteers-compliance.spec.ts` (follow the existing Playwright fixtures/auth pattern in the `e2e/` dir)

- [ ] **Step 1: Write the spec**

Assert: signed in as a compliance manager, visiting `/volunteers/master` shows EHS + Learning + a Cleared column; clicking a person navigates to `/volunteers/compliance/<id>` (not `/admin/people/<id>`) and renders the Clearance checklist. Use the repo's existing auth/seed fixtures (see a sibling spec for the login + seed helper names; do not invent new fixture APIs).

- [ ] **Step 2: Run it**

Run: the repo's e2e command scoped to the new spec (e.g. `npx playwright test e2e/volunteers-compliance.spec.ts`).
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/volunteers-compliance.spec.ts
git commit -m "test(e2e): master compliance click-through opens per-person view"
```

---

## Self-Review

**Spec coverage:** Item ① (EHS in master) = Tasks 1-4. "All-encompassing clearance" = Tasks 2-4 (+6). Item ② (per-person view, opened to compliance managers) = Task 5 + link change in Task 4. Department parity = Task 6. Clean single clearance definition = Task 7. Verification = Task 8. Covered.

**Placeholder scan:** Novel logic (Tasks 1-2) has full code and tests. Tasks 4-6 give exact edit sites and code; Task 6/8 require reading one page/spec first (their exact line numbers are not knowable without the read, which is called out as the first step, not a placeholder in the code).

**Type consistency:** `ClearanceSummary`/`ClearanceTask` defined in Task 2, consumed by the same names in Tasks 3-6. `OnboardingTaskKey`/`OnboardingTaskState` imported from `../engine/status` consistently. `loadEhsItemsMap` return type matches `deriveEhsTaskState`'s `{ complete: boolean }[]` input.
