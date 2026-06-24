# Director Training Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let directors complete their own term training (parallel to volunteer training) when an admin designates a DIRECTOR-track training cycle, with both trainings tracked and gated separately.

**Architecture:** Generalize the volunteer-only training model into a track-scoped `Training` model (`VOLUNTEER | DIRECTOR`). One training cycle may be designated per term *per track*. A single rule — `requiredTrainingTracks(personId, termId)` — drives which trainings a person must complete (intersection of their active membership kinds and the term's designated training cycles). The existing quiz/attendance/clearance code path is reused track-by-track.

**Tech Stack:** Next.js 16 (App Router, RSC), Prisma + PostgreSQL (Neon), TypeScript, Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-24-director-training-design.md` — the authority for behavior.
- **Builds on PR #53:** this branch (`feat/director-training`) is cut from `fix/remove-card-accent-bars`. It **generalizes** PR #53's `isActiveVolunteer` helper and `overallClearance(..., trainingRequired)` — it does not revert them.
- **No em-dashes** in UI copy or comments (use commas, parentheses, or periods).
- **Product name** is "HAVEN Hub" in prose/UI; identifiers stay `havenhub`.
- **Migrations** run over the Neon pooler using the unpooled `directUrl`; rename the table in-place (never drop/recreate — that loses data).
- **Tests:** `npm run test:prepare` once to migrate the test DB, then `npx vitest run <path>` for targeted runs. The four cert `/tmp` ENOENT tests are pre-existing flakes; ignore them.
- **TDD:** write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- After any schema change: `npx prisma generate` before running `tsc`/tests.

---

## File Structure

**Schema & migration**
- `prisma/schema.prisma` — rename `VolunteerTraining` → `Training`, add `TrainingTrack` enum + `track` column, swap unique key, rename relations.
- `prisma/migrations/<ts>_generalize_training_to_track/migration.sql` — hand-edited rename migration.

**Service (recruitment training)**
- `src/modules/recruitment/services/training.ts` — track-aware cycle lookup/designation, `requiredTrainingTracks`, list-returning `getMyTraining`, track-aware `resolveTrainingState`/`submitQuiz`/`recordAttendance`/`resetTraining`/`completeTraining`.
- `src/modules/recruitment/services/training.test.ts` / `training-schema.test.ts` — updated + new tests.

**Onboarding engine + service**
- `src/modules/onboarding/engine/status.ts` — add `directorTraining` task key; `deriveTrainingTaskState` drops the `isVolunteer` flag.
- `src/modules/onboarding/engine/status.test.ts` — updated.
- `src/modules/onboarding/services/onboarding.ts` — emit one training task per required track.

**Clearance rules**
- `src/platform/compliance/rules.ts` — `overallClearance(certStatus, allRequiredTrainingsComplete)`.
- `src/platform/compliance/rules.test.ts` — updated.
- `src/modules/volunteers/services/compliance.ts` — pass the volunteer-track boolean.

**UI**
- `src/app/(app)/page.tsx` — dashboard rail: one status line per required track.
- `src/app/(app)/my-info/page.tsx` + `src/modules/my-info/components/clearance-card.tsx` — per-track clearance rows.
- `src/app/(app)/training/page.tsx` + `src/app/get-started/training/page.tsx` + `src/app/get-started/onboarding-checklist.tsx` — render per-track training; checklist icon/hue for `directorTraining`.
- `src/app/(app)/recruitment/cycles/[id]/page.tsx` — show the designate-training toggle for DIRECTOR cycles too.

---

## Task 1: Generalize the schema to a track-scoped `Training` model

Rename the model and make every existing reference track-scoped, hardcoding `VOLUNTEER` so behavior is unchanged and all current tests stay green. This is the atomic "rename" landing.

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_generalize_training_to_track/migration.sql`
- Modify: `src/modules/recruitment/services/training.ts`
- Modify: `src/modules/volunteers/services/compliance.ts`
- Modify: `src/modules/recruitment/services/training.test.ts`, `src/modules/recruitment/services/training-schema.test.ts`
- Modify: `src/app/(app)/training/page.tsx` (only the `prisma.quizAttempt ... training:` filter, if present — none expected)

**Interfaces:**
- Produces: prisma model `Training` with fields identical to `VolunteerTraining` plus `track TrainingTrack`, unique `(personId, termId, track)`. Accessor `prisma.training`. Composite where key `personId_termId_track`.
- Produces: enum `TrainingTrack { VOLUNTEER, DIRECTOR }`.

- [ ] **Step 1: Edit the schema — add the enum**

In `prisma/schema.prisma`, next to the other training enums (after `enum TrainingMethod { ... }`), add:

```prisma
enum TrainingTrack {
  VOLUNTEER
  DIRECTOR
}
```

- [ ] **Step 2: Rename the model and add `track` + new unique key**

Replace the `model VolunteerTraining { ... }` block with:

```prisma
model Training {
  id                          String          @id @default(cuid())
  personId                    String
  termId                      String
  cycleId                     String
  track                       TrainingTrack   @default(VOLUNTEER)
  status                      TrainingStatus  @default(PENDING)
  completedVia                TrainingMethod?
  completedAt                 DateTime?
  attendanceRecordedById      String?
  attendanceRecordedAt        DateTime?
  locked                      Boolean         @default(false)
  lockResetAt                 DateTime?
  subcommitteeInterest        String?
  additionalShiftAvailability String?
  minShiftsWanted             String?
  feedback                    String?
  createdAt                   DateTime        @default(now())
  updatedAt                   DateTime        @updatedAt

  person               Person           @relation("trainingPerson", fields: [personId], references: [id], onDelete: Cascade)
  term                 Term             @relation(fields: [termId], references: [id], onDelete: Cascade)
  cycle                RecruitmentCycle @relation(fields: [cycleId], references: [id], onDelete: Restrict)
  attendanceRecordedBy Person?          @relation("trainingAttendanceRecorder", fields: [attendanceRecordedById], references: [id], onDelete: SetNull)
  attempts             QuizAttempt[]

  @@unique([personId, termId, track])
  @@index([termId])
}
```

- [ ] **Step 3: Update the back-relations on `QuizAttempt`, `Person`, `Term`, `RecruitmentCycle`**

In `model QuizAttempt`, change the relation line:

```prisma
  training Training @relation(fields: [trainingId], references: [id], onDelete: Cascade)
```

In `model Person` (currently lines ~114-115), change:

```prisma
  trainings                Training[]  @relation("trainingPerson")
  trainingAttendanceMarked Training[]  @relation("trainingAttendanceRecorder")
```

In `model Term` (currently line ~172), change:

```prisma
  trainings Training[]
```

In `model RecruitmentCycle` (currently line ~778), change:

```prisma
  trainings    Training[]
```

- [ ] **Step 4: Create the rename migration (do not drop/recreate)**

Run create-only so you can hand-edit the SQL:

```bash
npx prisma migrate dev --create-only --name generalize_training_to_track
```

Replace the generated `migration.sql` with this in-place rename:

```sql
-- Generalize VolunteerTraining -> Training (track-scoped)
CREATE TYPE "TrainingTrack" AS ENUM ('VOLUNTEER', 'DIRECTOR');

ALTER TABLE "VolunteerTraining" RENAME TO "Training";

ALTER TABLE "Training" ADD COLUMN "track" "TrainingTrack" NOT NULL DEFAULT 'VOLUNTEER';

DROP INDEX "VolunteerTraining_personId_termId_key";
CREATE UNIQUE INDEX "Training_personId_termId_track_key" ON "Training"("personId", "termId", "track");

ALTER INDEX "VolunteerTraining_termId_idx" RENAME TO "Training_termId_idx";
```

- [ ] **Step 5: Apply the migration and regenerate the client**

Run:

```bash
npx prisma migrate dev
npx prisma generate
```

Expected: migration applies cleanly; `prisma generate` succeeds.

- [ ] **Step 6: Mechanically migrate service references to `prisma.training` + track-scoped keys**

In `src/modules/recruitment/services/training.ts`, replace every `prisma.volunteerTraining` / `tx.volunteerTraining` / `db.volunteerTraining` with `prisma.training` / `tx.training` / `db.training`. Then fix the composite-key lookups/upserts to include `track: "VOLUNTEER"`:

`resolveTrainingState` (lines ~77-80):

```typescript
export async function resolveTrainingState(personId: string, termId: string): Promise<TrainingState> {
  const row = await prisma.training.findUnique({
    where: { personId_termId_track: { personId, termId, track: "VOLUNTEER" } },
  });
  return row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";
}
```

`completeTraining` upsert (lines ~90-102) — change the `where` and `create`:

```typescript
  await db.training.upsert({
    where: { personId_termId_track: { personId: args.personId, termId: args.termId, track: "VOLUNTEER" } },
    create: {
      personId: args.personId, termId: args.termId, cycleId: args.cycleId, track: "VOLUNTEER",
      status: "COMPLETE", completedVia: args.via, completedAt: now,
      attendanceRecordedById: attendance ? (args.actorId ?? null) : null,
      attendanceRecordedAt: attendance ? now : null,
    },
    update: {
      status: "COMPLETE", completedVia: args.via, completedAt: now, locked: false,
      ...(attendance ? { attendanceRecordedById: args.actorId ?? null, attendanceRecordedAt: now } : {}),
    },
  });
```

`getMyTraining` lookup (line ~168):

```typescript
  const row = await prisma.training.findUnique({ where: { personId_termId_track: { personId, termId: term.id, track: "VOLUNTEER" } } });
```

`submitQuiz` upsert (lines ~226-229):

```typescript
    const row = await tx.training.upsert({
      where: { personId_termId_track: { personId, termId: term.id, track: "VOLUNTEER" } },
      create: { personId, termId: term.id, cycleId: cycle.id, track: "VOLUNTEER" },
      update: {},
    });
```

`resetTraining` (line ~277) — `updateMany` does not use the unique key, so just rename the accessor and scope to the volunteer track:

```typescript
  await prisma.training.updateMany({ where: { personId, termId, track: "VOLUNTEER", status: { not: "COMPLETE" } }, data: { locked: false, lockResetAt: new Date() } });
```

`listTrainingRoster` (line ~316) — rename accessor:

```typescript
  const training = new Map(
    (await prisma.training.findMany({ where: { termId: cycle.termId, track: "VOLUNTEER", personId: { in: personIds } } })).map((t) => [t.personId, t])
  );
```

Also update the two `entityType: "VolunteerTraining"` strings in `resetTraining` and `recordAttendance` audit calls to `entityType: "Training"`.

- [ ] **Step 7: Mechanically migrate `compliance.ts` references**

In `src/modules/volunteers/services/compliance.ts`, replace any `prisma.volunteerTraining` with `prisma.training`. The two `completedTraining` set-builders that query training rows must scope `track: "VOLUNTEER"`. Find each `prisma.volunteerTraining.findMany(...)` (or wherever `completedTraining` is built) and add `track: "VOLUNTEER"` to its `where`.

- [ ] **Step 8: Migrate test references**

In `training.test.ts` and `training-schema.test.ts`, replace `prisma.volunteerTraining` with `prisma.training`, and any `findUnique({ where: { personId_termId: {...} } })` with `findUnique({ where: { personId_termId_track: { personId: <p>, termId: <t>, track: "VOLUNTEER" } } })`. The `quizAttempt` filter `training: { personId, termId }` stays valid (it filters by relation fields) but add `track: "VOLUNTEER"` for precision:

```typescript
  expect(await prisma.quizAttempt.count({ where: { training: { personId: vol.id, termId: term.id, track: "VOLUNTEER" } } })).toBe(3);
```

- [ ] **Step 9: Verify the rename compiles and all existing tests pass**

Run:

```bash
npx tsc --noEmit 2>&1 | grep -v ".next/types/validator" | grep "error TS" || echo "clean"
npx vitest run src/modules/recruitment/services/training.test.ts src/modules/recruitment/services/training-schema.test.ts src/modules/volunteers/services/compliance.test.ts
```

Expected: `clean`; all listed test files pass (behavior unchanged — everything is still `VOLUNTEER`).

- [ ] **Step 10: Commit**

```bash
git add prisma/ src/modules/recruitment/services/training.ts src/modules/volunteers/services/compliance.ts src/modules/recruitment/services/training.test.ts src/modules/recruitment/services/training-schema.test.ts
git commit -m "refactor(training): generalize VolunteerTraining to track-scoped Training model"
```

---

## Task 2: Track-aware cycle lookup and designation

A term may have one designated training cycle per track. `setTrainingCycle` accepts DIRECTOR cycles and clears only within the same track.

**Files:**
- Modify: `src/modules/recruitment/services/training.ts:30-52` (`getTrainingCycleForTerm`, `setTrainingCycle`)
- Modify call sites of `getTrainingCycleForTerm` in `training.ts` (in `getMyTraining`, `recordAttendance`, `submitQuiz`)
- Test: `src/modules/recruitment/services/training.test.ts`

**Interfaces:**
- Produces: `getTrainingCycleForTerm(termId: string, track: TrainingTrack): Promise<RecruitmentCycle | null>`
- Produces: `setTrainingCycle(cycleId, value, actorId)` — now allows any track, clears within-track.

- [ ] **Step 1: Write the failing tests**

Add to `training.test.ts`:

```typescript
it("a term can have one volunteer and one director training cycle at once", async () => {
  const { srr, term, c1 } = await seed();
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(c1.id, true, srr.id);        // volunteer
  await setTrainingCycle(dirCycle.id, true, srr.id);  // director
  expect((await getTrainingCycleForTerm(term.id, "VOLUNTEER"))?.id).toBe(c1.id);
  expect((await getTrainingCycleForTerm(term.id, "DIRECTOR"))?.id).toBe(dirCycle.id);
});

it("designating a second cycle of a track clears the first of that track only", async () => {
  const { srr, term, c1, c2 } = await seed();
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(c1.id, true, srr.id);
  await setTrainingCycle(dirCycle.id, true, srr.id);
  await setTrainingCycle(c2.id, true, srr.id); // second VOLUNTEER cycle
  expect((await getTrainingCycleForTerm(term.id, "VOLUNTEER"))?.id).toBe(c2.id);
  expect((await getTrainingCycleForTerm(term.id, "DIRECTOR"))?.id).toBe(dirCycle.id); // untouched
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/modules/recruitment/services/training.test.ts -t "training cycle"`
Expected: FAIL (the new tests can't pass a track arg / director designation throws).

- [ ] **Step 3: Make `getTrainingCycleForTerm` track-aware**

Replace lines ~30-33:

```typescript
/** The term's designated training cycle for a track, or null. */
export async function getTrainingCycleForTerm(termId: string, track: TrainingTrack): Promise<RecruitmentCycle | null> {
  return prisma.recruitmentCycle.findFirst({ where: { termId, track, isTermTraining: true } });
}
```

Add `TrainingTrack` to the `@prisma/client` type import at the top of the file:

```typescript
import type { RecruitmentCycle, Prisma, TrainingMethod, TrainingTrack } from "@prisma/client";
```

- [ ] **Step 4: Allow any track in `setTrainingCycle`, clear within-track**

Replace lines ~38-51:

```typescript
export async function setTrainingCycle(cycleId: string, value: boolean, actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new RecruitmentAuthError("Only recruitment leads can set the training cycle.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new TrainingStateError("Cycle not found.");
  await prisma.$transaction(async (tx) => {
    if (value) {
      await tx.recruitmentCycle.updateMany({ where: { termId: cycle.termId, track: cycle.track, isTermTraining: true, NOT: { id: cycleId } }, data: { isTermTraining: false } });
    }
    await tx.recruitmentCycle.update({ where: { id: cycleId }, data: { isTermTraining: value } });
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_designate", entityType: "RecruitmentCycle", entityId: cycleId, after: { isTermTraining: value } });
}
```

- [ ] **Step 5: Pass the track at the existing call sites (still VOLUNTEER)**

In `getMyTraining` (line ~167) and `recordAttendance` (line ~109) and `submitQuiz` (line ~216), change `getTrainingCycleForTerm(term.id)` / `getTrainingCycleForTerm(termId)` to pass `"VOLUNTEER"` for now:

```typescript
  const cycle = await getTrainingCycleForTerm(term.id, "VOLUNTEER");
```
(and `getTrainingCycleForTerm(termId, "VOLUNTEER")` in `recordAttendance`).

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/modules/recruitment/services/training.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 7: Commit**

```bash
git add src/modules/recruitment/services/training.ts src/modules/recruitment/services/training.test.ts
git commit -m "feat(training): one designated training cycle per term per track"
```

---

## Task 3: `requiredTrainingTracks` helper

The single rule that decides which trainings a person must complete.

**Files:**
- Modify: `src/modules/recruitment/services/training.ts` (add helper; remove `isActiveVolunteer`)
- Test: `src/modules/recruitment/services/training.test.ts`

**Interfaces:**
- Produces: `requiredTrainingTracks(personId: string, termId: string): Promise<TrainingTrack[]>` — returns the tracks the person must train for (membership kind ∩ designated cycles).
- Removes: `isActiveVolunteer` (callers move to this helper in later tasks).

- [ ] **Step 1: Write the failing test**

Add to `training.test.ts` (uses `seedMember` which already creates a volunteer cycle `c1` designated, a volunteer `vol`, and a director `dir`):

```typescript
it("requiredTrainingTracks reflects membership kind ∩ designated cycles", async () => {
  const { term, srr, vol, dir } = await seedMember(); // volunteer cycle c1 is designated
  // volunteer-only, volunteer cycle running -> [VOLUNTEER]
  expect(await requiredTrainingTracks(vol.id, term.id)).toEqual(["VOLUNTEER"]);
  // director-only, no director cycle -> []
  expect(await requiredTrainingTracks(dir.id, term.id)).toEqual([]);

  // designate a director cycle
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(dirCycle.id, true, srr.id);
  // director-only now -> [DIRECTOR]
  expect(await requiredTrainingTracks(dir.id, term.id)).toEqual(["DIRECTOR"]);
});

it("requiredTrainingTracks returns both tracks for a director+volunteer when both cycles run", async () => {
  const { term, srr, vol, dept } = await seedMember();
  await prisma.termMembership.create({ data: { personId: vol.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(dirCycle.id, true, srr.id);
  expect((await requiredTrainingTracks(vol.id, term.id)).sort()).toEqual(["DIRECTOR", "VOLUNTEER"]);
});
```

Add `requiredTrainingTracks` to the imports in the test's import block.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/modules/recruitment/services/training.test.ts -t "requiredTrainingTracks"`
Expected: FAIL ("requiredTrainingTracks is not a function").

- [ ] **Step 3: Implement the helper; remove `isActiveVolunteer`**

In `training.ts`, replace the `isActiveVolunteer` function (added in PR #53) with:

```typescript
/** The training tracks a person must complete this term: a track is required when
 *  the person holds an active membership of that kind AND the term has a designated
 *  training cycle for that track. Generalizes the volunteer-only check. */
export async function requiredTrainingTracks(personId: string, termId: string): Promise<TrainingTrack[]> {
  const pairs: [TrainingTrack, "VOLUNTEER" | "DIRECTOR"][] = [["VOLUNTEER", "VOLUNTEER"], ["DIRECTOR", "DIRECTOR"]];
  const result: TrainingTrack[] = [];
  for (const [track, kind] of pairs) {
    const hasMembership = await prisma.termMembership.count({ where: { personId, termId, kind, status: "ACTIVE" } });
    if (hasMembership === 0) continue;
    if (await getTrainingCycleForTerm(termId, track)) result.push(track);
  }
  return result;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/modules/recruitment/services/training.test.ts -t "requiredTrainingTracks"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/training.ts src/modules/recruitment/services/training.test.ts
git commit -m "feat(training): add requiredTrainingTracks rule"
```

---

## Task 4: Track-aware `getMyTraining` returning a per-track list

`getMyTraining` returns one `MyTraining` per required track. Update the two pages that consume it.

**Files:**
- Modify: `src/modules/recruitment/services/training.ts` (`MyTraining` type + `getMyTraining`)
- Modify: `src/app/(app)/training/page.tsx`, `src/app/get-started/training/page.tsx`
- Test: `src/modules/recruitment/services/training.test.ts`

**Interfaces:**
- Produces: `MyTraining` gains `track: TrainingTrack` and `trackLabel: string` ("Volunteer training" / "Director training").
- Produces: `getMyTraining(personId: string): Promise<MyTraining[]>` — one entry per `requiredTrainingTracks`, ordered VOLUNTEER then DIRECTOR. Empty array when none required.

- [ ] **Step 1: Write the failing test**

Add to `training.test.ts`:

```typescript
it("getMyTraining returns one entry per required track", async () => {
  const { term, srr, vol, dept } = await seedMember(); // volunteer cycle designated; vol is volunteer
  // volunteer-only
  const volOnly = await getMyTraining(vol.id);
  expect(volOnly.map((m) => m.track)).toEqual(["VOLUNTEER"]);
  expect(volOnly[0].trackLabel).toBe("Volunteer training");

  // make vol also a director and run a director cycle
  await prisma.termMembership.create({ data: { personId: vol.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(dirCycle.id, true, srr.id);
  const both = await getMyTraining(vol.id);
  expect(both.map((m) => m.track)).toEqual(["VOLUNTEER", "DIRECTOR"]);
  expect(both.map((m) => m.trackLabel)).toEqual(["Volunteer training", "Director training"]);
});

it("getMyTraining is empty for a director-only person with no director cycle", async () => {
  const { dir } = await seedMember();
  expect(await getMyTraining(dir.id)).toEqual([]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/modules/recruitment/services/training.test.ts -t "getMyTraining"`
Expected: FAIL (returns an object, not an array; no `track` field).

- [ ] **Step 3: Refactor `getMyTraining` to per-track list**

Add `track` + `trackLabel` to the `MyTraining` type:

```typescript
export type MyTraining = {
  track: TrainingTrack;
  trackLabel: string;
  term: { id: string; name: string };
  cycle: { id: string; title: string } | null;
  state: TrainingState;
  locked: boolean;
  completedVia: TrainingMethod | null;
  completedAt: Date | null;
  attemptsUsed: number;
  maxAttempts: number;
  passPercent: number;
  questions: { key: string; label: string; options: { value: string; label: string }[] }[];
  intake: TrainingIntake;
};

const TRACK_LABEL: Record<TrainingTrack, string> = {
  VOLUNTEER: "Volunteer training",
  DIRECTOR: "Director training",
};
```

Replace `getMyTraining` (lines ~164-196) with a list builder that runs the existing per-cycle logic once per required track:

```typescript
/** The training(s) the signed-in member must complete this term, one per required track. */
export async function getMyTraining(personId: string): Promise<MyTraining[]> {
  const term = await activeTermOrThrow();
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
        subcommitteeInterest: row?.subcommitteeInterest ?? null,
        additionalShiftAvailability: row?.additionalShiftAvailability ?? null,
        minShiftsWanted: row?.minShiftsWanted ?? null,
        feedback: row?.feedback ?? null,
      },
    });
  }
  return out;
}
```

Note: because `requiredTrainingTracks` only returns a track when a designated cycle exists, `cycle` here is always non-null in practice; the `?? null` paths are kept defensively.

- [ ] **Step 4: Update `src/app/(app)/training/page.tsx` to render per track**

Change the page body to map over the list. Replace the `TrainingPage` component (bottom of file) with:

```typescript
export default async function TrainingPage() {
  const person = await requirePersonSession();
  const trainings = await getMyTraining(person.personId);
  const canSchedule =
    trainings.length > 0 &&
    trainings.every((m) => m.state === "COMPLETE") &&
    (await getAccessibleModules(person.personId)).some((m) => m.id === "schedule");

  return (
    <div className="max-w-[760px]">
      <header className="mb-[22px]">
        <h1 className="text-[26px] font-bold tracking-tight text-foreground">Training</h1>
        <p className="mt-1.5 text-[14.5px] text-foreground-soft">
          Complete your training to be cleared{trainings[0] ? ` for ${trainings[0].term.name}` : ""}.
        </p>
      </header>

      {trainings.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface px-[22px] py-5 text-[14px] text-foreground-soft shadow-sm">
          You have no training requirements this term.
        </div>
      ) : (
        trainings.map((my) => {
          const pending = my.cycle && my.state !== "COMPLETE" && !my.locked;
          return (
            <section key={my.track} className="mb-9">
              <h2 className="mb-3 text-base font-bold tracking-tight text-foreground">{my.trackLabel}</h2>
              <ClearanceHero my={my} />
              {pending && (
                <>
                  <PathCards my={my} />
                  <SectionHead>Makeup quiz</SectionHead>
                  <TrainingQuiz
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
      )}
      <div className="mt-[18px] flex justify-end">
        <BackToHub />
      </div>
    </div>
  );
}
```

(The `track` prop on `TrainingQuiz` is added in Task 5; until then TypeScript will flag it. Apply Task 5 in the same working session, or temporarily omit the prop. The plan orders Task 5 next.)

- [ ] **Step 5: Update `src/app/get-started/training/page.tsx`**

Replace its body to find the requested track's training:

```typescript
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { Alert } from "@/platform/ui/alert";
import { getMyTraining } from "@/modules/recruitment/services/training";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { TrainingQuiz } from "@/app/(app)/training/training-quiz";
import { OnboardingStepShell } from "../onboarding-step-shell";

export default async function OnboardingTrainingPage({ searchParams }: { searchParams: Promise<{ track?: string }> }) {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");

  const sp = await searchParams;
  const track = sp.track === "director" ? "DIRECTOR" : "VOLUNTEER";
  const trainings = await getMyTraining(person.personId);
  const my = trainings.find((m) => m.track === track);
  if (!my || my.state === "COMPLETE") redirect("/get-started");

  return (
    <OnboardingStepShell
      title={my.trackLabel}
      description="Most people attend the live session. Missed it? Take the makeup quiz here to clear training."
      completedCount={status.completedCount}
      totalCount={status.totalCount}
    >
      {!my.cycle ? (
        <Alert tone="info">Training for {my.term.name} is not open yet. You will get an email when it is ready.</Alert>
      ) : my.locked ? (
        <Alert tone="error">
          Your makeup quiz is locked after {my.maxAttempts} attempts. Contact your recruitment director to reset it, or attend a live session.
        </Alert>
      ) : (
        <TrainingQuiz
          track={my.track}
          questions={my.questions}
          passPercent={my.passPercent}
          maxAttempts={my.maxAttempts}
          attemptsUsed={my.attemptsUsed}
          intake={my.intake}
        />
      )}
    </OnboardingStepShell>
  );
}
```

- [ ] **Step 6: Run tests + typecheck**

Run:

```bash
npx vitest run src/modules/recruitment/services/training.test.ts -t "getMyTraining"
```
Expected: PASS. (TypeScript will still flag the `track` prop on `TrainingQuiz` until Task 5 — that is expected and resolved next.)

- [ ] **Step 7: Commit**

```bash
git add src/modules/recruitment/services/training.ts "src/app/(app)/training/page.tsx" src/app/get-started/training/page.tsx
git commit -m "feat(training): getMyTraining returns one training per required track"
```

---

## Task 5: Track-aware quiz submission, attendance, and reset

The completion paths take a track and verify the matching membership kind.

**Files:**
- Modify: `src/modules/recruitment/services/training.ts` (`submitQuiz`, `recordAttendance`, `resetTraining`, `completeTraining`)
- Modify: `src/app/(app)/training/training-quiz.tsx` (accept + forward `track`) and its server action
- Test: `src/modules/recruitment/services/training.test.ts`

**Interfaces:**
- Produces: `submitQuiz(personId, input: { track: TrainingTrack; answers: Record<string, unknown>; intake: TrainingIntake }): Promise<QuizSubmission>`
- Produces: `recordAttendance(personId, termId, track: TrainingTrack, actorId): Promise<void>`
- Produces: `resetTraining(personId, termId, track: TrainingTrack, actorId): Promise<void>`
- Produces: `completeTraining(db, { personId, termId, cycleId, track, via, actorId? })`

- [ ] **Step 1: Write the failing test**

Add to `training.test.ts` (reuse `addQuiz` helper used by existing quiz tests; create a director cycle, designate it, and have a director complete it):

```typescript
it("a director completes director training via the quiz", async () => {
  const { term, srr, dir } = await seedMember();
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(dirCycle.id, true, srr.id);
  await updateQuizSettings(dirCycle.id, { quizPassPercent: 100, quizMaxAttempts: 2 }, srr.id);
  await addQuiz(dirCycle.id);

  const r = await submitQuiz(dir.id, { track: "DIRECTOR", answers: { q1: "a", q2: "y" }, intake: {} });
  expect(r.passed).toBe(true);
  expect(await resolveTrainingState(dir.id, term.id, "DIRECTOR")).toBe("COMPLETE");
  // their (nonexistent) volunteer training is untouched
  expect(await resolveTrainingState(dir.id, term.id, "VOLUNTEER")).toBe("PENDING");
});

it("submitQuiz rejects a track the person has no active membership for", async () => {
  const { term, srr, vol } = await seedMember();
  const dirCycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  await setTrainingCycle(dirCycle.id, true, srr.id);
  await addQuiz(dirCycle.id);
  await expect(submitQuiz(vol.id, { track: "DIRECTOR", answers: { q1: "a", q2: "y" }, intake: {} }))
    .rejects.toBeInstanceOf(TrainingStateError); // vol is not an active director
});
```

Then update `resolveTrainingState` to take a track (see Step 3) and fix existing call sites in the test file: `resolveTrainingState(vol.id, term.id)` → `resolveTrainingState(vol.id, term.id, "VOLUNTEER")`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/modules/recruitment/services/training.test.ts -t "director"`
Expected: FAIL (submitQuiz signature lacks `track`).

- [ ] **Step 3: Make `resolveTrainingState` track-aware**

```typescript
export async function resolveTrainingState(personId: string, termId: string, track: TrainingTrack): Promise<TrainingState> {
  const row = await prisma.training.findUnique({ where: { personId_termId_track: { personId, termId, track } } });
  return row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";
}
```

Update the volunteer-roster call sites in `compliance.ts` and `listTrainingRoster` that use `resolveTrainingState` to pass `"VOLUNTEER"` (the roster query already filters volunteers).

- [ ] **Step 4: Thread `track` through `completeTraining`**

Add `track` to the args and the upsert key/create:

```typescript
export async function completeTraining(
  db: Tx | typeof prisma,
  args: { personId: string; termId: string; cycleId: string; track: TrainingTrack; via: TrainingMethod; actorId?: string }
): Promise<void> {
  const now = new Date();
  const attendance = args.via === "ATTENDANCE";
  await db.training.upsert({
    where: { personId_termId_track: { personId: args.personId, termId: args.termId, track: args.track } },
    create: {
      personId: args.personId, termId: args.termId, cycleId: args.cycleId, track: args.track,
      status: "COMPLETE", completedVia: args.via, completedAt: now,
      attendanceRecordedById: attendance ? (args.actorId ?? null) : null,
      attendanceRecordedAt: attendance ? now : null,
    },
    update: {
      status: "COMPLETE", completedVia: args.via, completedAt: now, locked: false,
      ...(attendance ? { attendanceRecordedById: args.actorId ?? null, attendanceRecordedAt: now } : {}),
    },
  });
}
```

- [ ] **Step 5: Make `recordAttendance` and `resetTraining` track-aware**

`recordAttendance` (the `kind` for the membership check is `VOLUNTEER` for the VOLUNTEER track, `DIRECTOR` for the DIRECTOR track):

```typescript
export async function recordAttendance(personId: string, termId: string, track: TrainingTrack, actorId: string): Promise<void> {
  const cycle = await getTrainingCycleForTerm(termId, track);
  if (!cycle) throw new TrainingStateError("This term has no designated training cycle.");

  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId, kind: track, status: "ACTIVE" },
    include: { department: { select: { code: true } } },
  });
  if (memberships.length === 0) throw new TrainingStateError("Not an active member of this track this term.");

  const scope = await reviewScope(actorId);
  const inScope = scope.all || memberships.some((m) => scope.departmentCodes.includes(m.department.code));
  if (!inScope) throw new RecruitmentAuthError("You can't record training for that member.");

  await completeTraining(prisma, { personId, termId, cycleId: cycle.id, track, via: "ATTENDANCE", actorId });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_attendance", entityType: "Training", entityId: `${personId}:${termId}:${track}`, after: { personId, termId, track } });
}
```

`resetTraining`:

```typescript
export async function resetTraining(personId: string, termId: string, track: TrainingTrack, actorId: string): Promise<void> {
  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId, kind: track, status: "ACTIVE" },
    include: { department: { select: { code: true } } },
  });
  if (memberships.length === 0) throw new TrainingStateError("Not an active member of this track this term.");
  const scope = await reviewScope(actorId);
  const inScope = scope.all || memberships.some((m) => scope.departmentCodes.includes(m.department.code));
  if (!inScope) throw new RecruitmentAuthError("You can't reset training for that member.");

  await prisma.training.updateMany({ where: { personId, termId, track, status: { not: "COMPLETE" } }, data: { locked: false, lockResetAt: new Date() } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_reset", entityType: "Training", entityId: `${personId}:${termId}:${track}` });
}
```

Note: `TrainingTrack` (`VOLUNTEER | DIRECTOR`) and `MembershipKind` (`VOLUNTEER | DIRECTOR`) share values, so `kind: track` typechecks; if Prisma's generated types disagree, map explicitly with `track === "DIRECTOR" ? "DIRECTOR" : "VOLUNTEER"`.

- [ ] **Step 6: Make `submitQuiz` track-aware**

Change the signature and the membership guard, cycle lookup, upsert, and `completeTraining` call:

```typescript
export async function submitQuiz(
  personId: string,
  input: { track: TrainingTrack; answers: Record<string, unknown>; intake: TrainingIntake }
): Promise<QuizSubmission> {
  const term = await activeTermOrThrow();
  const cycle = await getTrainingCycleForTerm(term.id, input.track);
  if (!cycle) throw new TrainingStateError("This term has no designated training cycle.");

  const isMember = await prisma.termMembership.count({ where: { personId, termId: term.id, kind: input.track, status: "ACTIVE" } });
  if (isMember === 0) throw new TrainingStateError("Not an active member of this track this term.");

  const questions = await quizQuestions(cycle.id);
  if (questions.length === 0) throw new TrainingStateError("This training has no quiz questions yet.");

  return prisma.$transaction(async (tx) => {
    const row = await tx.training.upsert({
      where: { personId_termId_track: { personId, termId: term.id, track: input.track } },
      create: { personId, termId: term.id, cycleId: cycle.id, track: input.track },
      update: {},
    });
    if (row.status === "COMPLETE") throw new TrainingStateError("Training is already complete.");
    if (row.locked) throw new QuizLockedError("Your quiz is locked. Ask your director to reset it.");

    await tx.training.update({
      where: { id: row.id },
      data: {
        subcommitteeInterest: input.intake.subcommitteeInterest ?? undefined,
        additionalShiftAvailability: input.intake.additionalShiftAvailability ?? undefined,
        minShiftsWanted: input.intake.minShiftsWanted ?? undefined,
        feedback: input.intake.feedback ?? undefined,
      },
    });

    const result = gradeQuiz(questions, input.answers, cycle.quizPassPercent);
    await tx.quizAttempt.create({ data: { trainingId: row.id, answers: input.answers as object, score: result.score, total: result.total, passed: result.passed } });

    const attemptsUsed = await tx.quizAttempt.count({ where: { trainingId: row.id, ...(row.lockResetAt ? { takenAt: { gte: row.lockResetAt } } : {}) } });
    let locked = false;
    if (result.passed) {
      await completeTraining(tx, { personId, termId: term.id, cycleId: cycle.id, track: input.track, via: "QUIZ" });
    } else if (attemptsUsed >= cycle.quizMaxAttempts) {
      await tx.training.update({ where: { id: row.id }, data: { locked: true } });
      locked = true;
    }

    const correctByKey = Object.fromEntries(
      questions.filter((q) => q.correctValue !== null).map((q) => [q.key, q.correctValue as string])
    );
    return { score: result.score, total: result.total, percent: result.percent, passed: result.passed, attemptsUsed, locked, correctByKey };
  });
}
```

- [ ] **Step 7: Forward `track` from the quiz UI**

In `src/app/(app)/training/training-quiz.tsx`, add a `track: TrainingTrack` prop to the component and include it in the call to the submit server action (it calls `submitQuiz`). Update that server action's signature to accept `track` and pass `{ track, answers, intake }` to `submitQuiz`. (Open the file; the action is colocated or imported — add `track` to its input and thread it through. Import `TrainingTrack` from `@prisma/client`.)

- [ ] **Step 8: Fix existing test call sites**

In `training.test.ts`, update existing `submitQuiz(vol.id, { answers, intake })` calls to `submitQuiz(vol.id, { track: "VOLUNTEER", answers, intake })`, and `resetTraining(vol.id, term.id, srr.id)` to `resetTraining(vol.id, term.id, "VOLUNTEER", srr.id)`, and any `recordAttendance(p, t, actor)` to `recordAttendance(p, t, "VOLUNTEER", actor)`.

- [ ] **Step 9: Run tests + typecheck**

Run:

```bash
npx vitest run src/modules/recruitment/services/training.test.ts
npx tsc --noEmit 2>&1 | grep -v ".next/types/validator" | grep "error TS" || echo "clean"
```
Expected: all pass; `clean`.

- [ ] **Step 10: Commit**

```bash
git add src/modules/recruitment/services/training.ts "src/app/(app)/training/training-quiz.tsx" src/modules/recruitment/services/training.test.ts src/modules/volunteers/services/compliance.ts
git commit -m "feat(training): track-aware quiz, attendance, and reset"
```

---

## Task 6: Onboarding gate — one training task per required track

**Files:**
- Modify: `src/modules/onboarding/engine/status.ts` (add `directorTraining` key; drop `isVolunteer` from `deriveTrainingTaskState`)
- Modify: `src/modules/onboarding/engine/status.test.ts`
- Modify: `src/modules/onboarding/services/onboarding.ts`
- Modify: `src/app/get-started/onboarding-checklist.tsx`
- Test: `src/modules/onboarding/engine/status.test.ts`

**Interfaces:**
- Produces: `OnboardingTaskKey = "profile" | "hipaa" | "training" | "directorTraining" | "learning"`
- Produces: `deriveTrainingTaskState(t: { state: TrainingState; attemptsUsed: number }): OnboardingTaskState` (no `isVolunteer` arg)
- Consumes: `requiredTrainingTracks`, `resolveTrainingState` from Task 3/5.

- [ ] **Step 1: Update the engine test**

In `status.test.ts`, replace the `deriveTrainingTaskState` describe block to drop the flag and the NOT_REQUIRED case (non-required tracks are simply not emitted now):

```typescript
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/modules/onboarding/engine/status.test.ts -t "deriveTrainingTaskState"`
Expected: FAIL (current signature requires the second arg).

- [ ] **Step 3: Update the engine**

In `status.ts`, add the key and simplify the deriver:

```typescript
export type OnboardingTaskKey = "profile" | "hipaa" | "training" | "directorTraining" | "learning";
```

```typescript
/** Training is complete when passed; a started-but-unpassed attempt reads as in progress.
 *  Only called for tracks the person is actually required to complete. */
export function deriveTrainingTaskState(t: { state: TrainingState; attemptsUsed: number }): OnboardingTaskState {
  if (t.state === "COMPLETE") return "COMPLETE";
  return t.attemptsUsed > 0 ? "IN_PROGRESS" : "INCOMPLETE";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/modules/onboarding/engine/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Emit per-track training tasks in the service**

In `src/modules/onboarding/services/onboarding.ts`:

Replace the `isActiveVolunteer` import with `requiredTrainingTracks` and `resolveTrainingState`, and add the `directorTraining` copy. Update the `COPY` map to add:

```typescript
  directorTraining: {
    label: "Director training",
    description: "Finish this term's director training to be cleared for shifts.",
    href: "/get-started/training?track=director",
    ctaLabel: "Go to training",
  },
```

Change the `training` copy `href` to `"/get-started/training?track=volunteer"` for symmetry.

Replace the data fetch + task assembly (the `Promise.all` and `tasks` array) with:

```typescript
  const [person, certs, courses, tracks] = await Promise.all([
    prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { contactEmail: true, phone: true } }),
    listMyCertificates(personId),
    getMyCourses(personId),
    requiredTrainingTracks(personId, term.id),
  ]);

  const trainingTasks: OnboardingTask[] = [];
  for (const track of tracks) {
    const state = await resolveTrainingState(personId, term.id, track);
    const attemptsUsed = 0; // gate only needs COMPLETE vs not; attempts refine IN_PROGRESS, optional here
    const key = track === "DIRECTOR" ? "directorTraining" : "training";
    trainingTasks.push(task(key, deriveTrainingTaskState({ state, attemptsUsed })));
  }

  const tasks: OnboardingTask[] = [
    task("profile", deriveProfileTaskState(person)),
    task("hipaa", deriveHipaaTaskState(complianceStatus(certs[0] ?? null, term.endDate))),
    ...trainingTasks,
    task("learning", deriveLearningTaskState(courses)),
  ];
```

Remove the now-unused `getMyTraining` import and `deriveTrainingTaskState`'s old call.

Note: `attemptsUsed` is set to 0 here, so a started-but-unpassed training shows as "Action needed" rather than "In progress" on the gate. If "In progress" fidelity is wanted, call `getMyTraining` and match the entry by track; the spec does not require it, so keep it simple (YAGNI).

- [ ] **Step 6: Add the checklist icon + hue for `directorTraining`**

In `src/app/get-started/onboarding-checklist.tsx`, add entries so the new key renders. Import `Shield` or reuse `GraduationCap`:

```typescript
const ICON: Record<OnboardingTaskKey, LucideIcon> = {
  profile: UserRoundPen,
  hipaa: ShieldCheck,
  training: GraduationCap,
  directorTraining: GraduationCap,
  learning: BookOpen,
};
```

```typescript
const HUE: Record<OnboardingTaskKey, string> = {
  profile: "volunteers",
  hipaa: "info",
  training: "recruit",
  directorTraining: "schedule",
  learning: "admin",
};
```

- [ ] **Step 7: Typecheck + run the onboarding allowlist test**

The gate allowlist must already permit `/get-started/training`; the `?track=` query does not change the path. Run:

```bash
npx tsc --noEmit 2>&1 | grep -v ".next/types/validator" | grep "error TS" || echo "clean"
npx vitest run src/platform/auth/onboarding-allowlist.test.ts src/modules/onboarding/engine/status.test.ts
```
Expected: `clean`; tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/modules/onboarding/ src/app/get-started/onboarding-checklist.tsx
git commit -m "feat(onboarding): emit a training task per required track"
```

---

## Task 7: Multi-track clearance — `overallClearance`, My Info, dashboard

**Files:**
- Modify: `src/platform/compliance/rules.ts`, `src/platform/compliance/rules.test.ts`
- Modify: `src/modules/volunteers/services/compliance.ts`, `src/modules/recruitment/services/training.ts` (`listTrainingRoster`)
- Modify: `src/app/(app)/my-info/page.tsx`, `src/modules/my-info/components/clearance-card.tsx`
- Modify: `src/app/(app)/page.tsx` (dashboard rail)

**Interfaces:**
- Produces: `overallClearance(certStatus: ComplianceStatus, allRequiredTrainingsComplete: boolean): OverallClearance`
- Produces: `ClearanceCard` accepts `trainingRows: { label: string; state: TrainingState }[]` instead of a single `trainingState` + `trainingRequired`.

- [ ] **Step 1: Update the clearance-rules test**

In `rules.test.ts`, replace the `overallClearance` describe block:

```typescript
describe("overallClearance", () => {
  it("is CLEARED only when the cert is valid and all required trainings are complete", () => {
    expect(overallClearance("COMPLIANT", true)).toBe("CLEARED");
    expect(overallClearance("EXPIRING_SOON", true)).toBe("CLEARED");
    expect(overallClearance("COMPLIANT", false)).toBe("NOT_CLEARED");
  });
  it("is NOT_CLEARED for any invalid cert even when trainings are complete", () => {
    for (const s of ["EXPIRED", "UNKNOWN_DATE", "NO_CERTIFICATE"] as const) {
      expect(overallClearance(s, true)).toBe("NOT_CLEARED");
    }
  });
  it("clears on cert alone when no trainings are required", () => {
    expect(overallClearance("COMPLIANT", true)).toBe("CLEARED"); // caller passes true when nothing required
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/platform/compliance/rules.test.ts -t "overallClearance"`
Expected: FAIL (current signature is `(certStatus, training, trainingRequired?)`).

- [ ] **Step 3: Simplify `overallClearance`**

In `rules.ts`:

```typescript
export function overallClearance(
  certStatus: ComplianceStatus,
  allRequiredTrainingsComplete: boolean
): OverallClearance {
  const certValid = certStatus === "COMPLIANT" || certStatus === "EXPIRING_SOON";
  return certValid && allRequiredTrainingsComplete ? "CLEARED" : "NOT_CLEARED";
}
```

- [ ] **Step 4: Update roster/compliance callers (volunteer-track booleans)**

These compute per-volunteer clearance, so pass `trainingState === "COMPLETE"`:

- `compliance.ts:193` → `overallClearance(status, trainingState === "COMPLETE")`
- `compliance.ts:405` → `overallClearance(computedStatus, trainingState === "COMPLETE")`
- `training.ts` `listTrainingRoster` → `overallClearance(certStatus, trainingState === "COMPLETE")`

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/platform/compliance/rules.test.ts src/modules/volunteers/services/compliance.test.ts src/modules/recruitment/services/training.test.ts`
Expected: PASS. (The roster test `overallClearance` assertion still holds: cert valid + training PENDING → `NOT_CLEARED`.)

- [ ] **Step 6: Make `ClearanceCard` render per-track rows**

Replace the props + requirement assembly in `src/modules/my-info/components/clearance-card.tsx`:

```typescript
export function ClearanceCard({
  clearance,
  certStatus,
  trainingRows,
  termName,
}: {
  clearance: OverallClearance;
  certStatus: ComplianceStatus;
  /** One row per training the person must complete (volunteer and/or director). */
  trainingRows: { label: string; state: TrainingState }[];
  termName?: string | null;
}) {
  const cert = certRequirement(certStatus);
  const trainings = trainingRows.map((r) => ({ ...trainingRequirement(r.state), label: r.label }));
  const requirements = [cert, ...trainings];
  const cleared = clearance === "CLEARED";
  const forTerm = termName ? ` for ${termName}` : "";
  const anyTrainingIncomplete = trainings.some((t) => !t.met);
```

Update `trainingRequirement` to take a label:

```typescript
function trainingRequirement(state: TrainingState): Omit<Requirement, "label"> {
  return state === "COMPLETE"
    ? { statusLabel: "Complete", met: true, tone: "success" }
    : { statusLabel: "Not complete", met: false, tone: "warning" };
}
```

In the cleared banner sub-copy, use `trainings.length > 0`:

```tsx
            <p className="mt-0.5 text-[13px] leading-snug text-slate-700">
              {trainings.length > 0
                ? "Your HIPAA certificate and training are on file, so you can be scheduled for shifts."
                : "Your HIPAA certificate is on file, so you can be scheduled for shifts."}
            </p>
```

Replace the CTA condition `{trainingRequired && !training.met && (` with `{anyTrainingIncomplete && (` (the CTA links to `/training`, which lists all outstanding trainings).

- [ ] **Step 7: Wire My Info to the new card**

In `src/app/(app)/my-info/page.tsx`, replace the `isActiveVolunteer`/`resolveTrainingState`/`overallClearance` block:

```typescript
import { resolveTrainingState, requiredTrainingTracks } from "@/modules/recruitment/services/training";
```

```typescript
  const tracks = activeTerm ? await requiredTrainingTracks(person.personId, activeTerm.id) : [];
  const trainingRows = activeTerm
    ? await Promise.all(
        tracks.map(async (track) => ({
          label: track === "DIRECTOR" ? "Director training" : "Volunteer training",
          state: await resolveTrainingState(person.personId, activeTerm.id, track),
        }))
      )
    : [];
  const allTrainingsComplete = trainingRows.every((r) => r.state === "COMPLETE");
  const clearance = overallClearance(status, allTrainingsComplete);
```

And the JSX:

```tsx
          <ClearanceCard
            clearance={clearance}
            certStatus={status}
            trainingRows={trainingRows}
            termName={activeTerm?.name ?? null}
          />
```

- [ ] **Step 8: Wire the dashboard rail**

In `src/app/(app)/page.tsx`, replace the `isActiveVolunteer`/`trainingState`/`trainingLine`/`statusLines` block:

```typescript
import { requiredTrainingTracks, resolveTrainingState } from "@/modules/recruitment/services/training";
```

```typescript
  const tracks = term ? await requiredTrainingTracks(person.personId, term.id) : [];
  const trainingLines = term
    ? await Promise.all(
        tracks.map(async (track) => {
          const state = await resolveTrainingState(person.personId, term.id, track);
          const label = track === "DIRECTOR" ? "Director training" : "Volunteer training";
          return state === "COMPLETE"
            ? { ok: true, title: `${label} complete`, sub: "You're cleared for this term", href: "/training" }
            : { ok: false, title: `Complete your ${label.toLowerCase()}`, sub: "Required to be cleared", href: "/training" };
        })
      )
    : [];
```

```typescript
  const statusLines: Array<{ ok: boolean; title: string; sub: string; href: string }> = [
    { ...hipaaLine, href: "/my-info" },
    ...trainingLines,
  ];
```

Remove the now-unused `resolveTrainingState` single-call and `isActiveVolunteer` usage.

- [ ] **Step 9: Typecheck + run the touched suites**

```bash
npx tsc --noEmit 2>&1 | grep -v ".next/types/validator" | grep "error TS" || echo "clean"
npx vitest run src/platform/compliance/rules.test.ts src/modules/volunteers/services/compliance.test.ts
```
Expected: `clean`; tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/platform/compliance/ src/modules/volunteers/services/compliance.ts src/modules/recruitment/services/training.ts src/modules/my-info/components/clearance-card.tsx "src/app/(app)/my-info/page.tsx" "src/app/(app)/page.tsx"
git commit -m "feat(clearance): per-track training rows across My Info and the dashboard"
```

---

## Task 8: Admin — designate a DIRECTOR cycle as the term's director training

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/page.tsx`

**Interfaces:**
- Consumes: `setTrainingCycleAction` (unchanged) and `setTrainingCycle` (now track-agnostic, Task 2).

- [ ] **Step 1: Show the training panel for DIRECTOR cycles too**

In `src/app/(app)/recruitment/cycles/[id]/page.tsx`, the training panel is gated by `cycle.track === "VOLUNTEER"`. Change the wrapper condition to render for both tracks and make the copy track-aware. Replace the opening condition and heading:

```tsx
      {(cycle.track === "VOLUNTEER" || cycle.track === "DIRECTOR") && (
        <div className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-subtle-foreground">
            {cycle.track === "DIRECTOR" ? "Director training" : "Training"}
          </p>
```

The toggle label already reads "Use as this term's training" / "Stop using as this term's training", which is correct for both tracks. Leave the quiz-settings and roster links as-is (they apply per cycle regardless of track).

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v ".next/types/validator" | grep "error TS" || echo "clean"
```
Expected: `clean`.

- [ ] **Step 3: Manual verification (no unit test for the page)**

Start the dev server, sign in as a recruitment lead, open a DIRECTOR-track cycle, and confirm the "Use as this term's training" toggle appears and persists.

```bash
PORT=3002 npm run dev   # then visit /recruitment/cycles/<directorCycleId>
```

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/page.tsx"
git commit -m "feat(recruitment): allow designating a director cycle as term training"
```

---

## Task 9: Full-suite verification

- [ ] **Step 1: Run the whole test suite**

```bash
npm run test:prepare
npx vitest run
```
Expected: green (ignore the four known cert `/tmp` ENOENT flakes).

- [ ] **Step 2: Typecheck the project**

```bash
npx tsc --noEmit 2>&1 | grep -v ".next/types/validator" | grep "error TS" || echo "clean"
```
Expected: `clean`.

- [ ] **Step 3: Lint**

```bash
npm run lint
```
Expected: no new errors.

- [ ] **Step 4: Manual end-to-end smoke (dev server)**

With a director-only person and a designated DIRECTOR cycle: confirm the gate shows "Director training", `/training` shows the director section, completing the quiz clears them, and My Info + dashboard reflect it. With a director+volunteer and both cycles: confirm two rows everywhere and clearance only after both complete.

---

## Self-Review

- **Spec coverage:** model rename (T1), per-track cycle designation (T2), `requiredTrainingTracks` (T3), per-track `getMyTraining` + pages (T4), track-aware completion paths (T5), per-track gate tasks (T6), multi-track clearance + My Info + dashboard (T7), admin toggle (T8), verification (T9). All spec sections map to a task.
- **Placeholder scan:** none — every code step shows full code; the one intentional cross-task dependency (the `track` prop on `TrainingQuiz`) is called out in T4 and delivered in T5.
- **Type consistency:** `requiredTrainingTracks → TrainingTrack[]`, `getMyTraining → MyTraining[]` (with `track`/`trackLabel`), `resolveTrainingState(personId, termId, track)`, `submitQuiz({ track, answers, intake })`, `recordAttendance(personId, termId, track, actorId)`, `completeTraining({ ..., track })`, `overallClearance(certStatus, boolean)`, `ClearanceCard({ trainingRows })` are used consistently across tasks.
