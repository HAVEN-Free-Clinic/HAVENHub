# Volunteer Training + Quiz Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate a volunteer's term clearance on completed training (live attendance OR a passed makeup quiz) in addition to the existing HIPAA certificate, with the quiz authored per cycle in the existing form builder.

**Architecture:** Each `Term` has one designated training `RecruitmentCycle` that owns a builder-authored quiz (reusing `FormSection`/`FormField`, extended with `FormSection.purpose=QUIZ` and `FormField.correctValue`). A new `VolunteerTraining` row per `(personId, termId)` records completion via a director attendance tick or a passed `QuizAttempt`; quiz attempts are capped with a director-resettable lock. A pure `overallClearance(certStatus, trainingState)` combines the unchanged certificate status with training state; the volunteers compliance read surfaces both plus the derived clearance. The recruitment module writes its own models and reads `TermMembership`/`Person` via prisma; the volunteers compliance read pulls `VolunteerTraining` via prisma, so no module imports another.

**Tech Stack:** Next.js 16 App Router (server components, server actions), Prisma + Postgres, zod, vitest (integration against a real test DB), Playwright (e2e).

**Branch:** `plan-14/recruitment-training` (already checked out, stacked on plans 10 to 13).

**Spec:** `docs/superpowers/specs/2026-06-09-recruitment-training-design.md`

---

## Conventions (read once)

- Run a single test file: `npx vitest run <path>`. Run the whole suite: `npm test`.
- Typecheck: `npm run typecheck`. Lint: `npm run lint`. Build: `npm run build`.
- Service tests reset the DB per test with `resetDb()` from `@/platform/test/db` in `beforeEach`/`afterEach`, then seed inline (see `src/modules/recruitment/services/onboarding.test.ts` for the canonical seed shape).
- Migrations: `npm run db:migrate -- --name <name>`. INSPECT the generated SQL: additive only (CREATE TYPE/TABLE/INDEX, ALTER TABLE ADD COLUMN, ADD CONSTRAINT). STOP on any DROP or any ALTER of unrelated objects. NEVER run `prisma migrate reset` (the dev DB holds live data). If `migrate dev` refuses due to drift, hand-write the SQL then `npx prisma migrate resolve --applied <ts>_<name>` and `npx prisma generate`.
- No em-dashes anywhere in shipped strings, comments, or UI copy (use colons, parentheses, or "and"). HAVEN Hub is two words in prose; identifiers stay `havenhub`.
- Module-boundary lint rule: files under `src/modules/<m>` may import `@/platform/*` and their own module, never another module. Cross-domain reads/writes go through prisma models directly.

---

## File Structure

**Create:**
- `prisma/migrations/<ts>_recruitment_training/migration.sql` (generated, inspected)
- `src/modules/recruitment/engine/quiz-grading.ts` + `.test.ts` (pure grader)
- `src/modules/recruitment/services/training.ts` + `.test.ts` (designated cycle, attendance, quiz, roster, self-serve)
- `src/app/recruitment/cycles/[id]/training/page.tsx` + `actions.ts` (director/SRR roster)
- `src/app/recruitment/cycles/[id]/builder/quiz/page.tsx` (quiz authoring tab) [or extend the builder page, see Task 9]
- `src/app/training/page.tsx` + `actions.ts` (volunteer self-serve)
- `e2e/recruitment-training.spec.ts` (Playwright)

**Modify:**
- `prisma/schema.prisma` (enums, `RecruitmentCycle`, `FormSection`, `FormField`, new `VolunteerTraining` + `QuizAttempt`, `Person`/`Term` back-relations)
- `src/platform/test/db.ts` (TRUNCATE list)
- `src/platform/compliance/rules.ts` (`TrainingState`, `OverallClearance`, `overallClearance`)
- `src/modules/recruitment/engine/schema-builder.ts` / `visibility.ts` consumers in `services/submissions.ts` (exclude QUIZ sections from the public form)
- `src/modules/recruitment/services/form-builder.ts` (`purpose` on addSection, `correctValue` on add/updateField, quiz-safe edit rule)
- `src/modules/recruitment/services/cycles.ts` (include `purpose`/`correctValue` already covered by `getCycle`; no change expected beyond types) and `src/app/recruitment/actions.ts` (designate-cycle + quiz-settings actions)
- `src/modules/volunteers/services/compliance.ts` (training state + overall clearance on rows)
- `src/app/recruitment/cycles/[id]/page.tsx` (designate toggle, quiz settings, link to quiz tab + training roster)
- `src/app/my-info/page.tsx` (training/clearance card linking to `/training`)

---

## Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/platform/test/db.ts`
- Create: `prisma/migrations/<ts>_recruitment_training/migration.sql` (generated)
- Test: `src/modules/recruitment/services/training-schema.test.ts` (temporary smoke test, kept)

- [ ] **Step 1: Add enums.** In `prisma/schema.prisma`, beside the other recruitment enums (after `enum ContractStatus { ... }` near line 375), add:

```prisma
enum FormPurpose {
  APPLICATION
  QUIZ
}

enum TrainingStatus {
  PENDING
  COMPLETE
}

enum TrainingMethod {
  ATTENDANCE
  QUIZ
}
```

- [ ] **Step 2: Extend `RecruitmentCycle`.** Add three fields inside `model RecruitmentCycle` (after `acceptsRenewals` near line 675):

```prisma
  isTermTraining  Boolean          @default(false)
  quizPassPercent Int              @default(80)
  quizMaxAttempts Int              @default(3)
```

And add the back-relation for training rows in the same model's relation block:

```prisma
  trainings    VolunteerTraining[]
```

- [ ] **Step 3: Extend `FormSection` and `FormField`.** In `model FormSection` add (after `appliesTo` near line 697):

```prisma
  purpose        FormPurpose    @default(APPLICATION)
```

In `model FormField` add (after `validation` near line 715):

```prisma
  correctValue String?
```

- [ ] **Step 4: Add `VolunteerTraining` and `QuizAttempt` models.** Add at the end of the recruitment block (after `model OnboardingContract { ... }` near line 824):

```prisma
model VolunteerTraining {
  id                     String           @id @default(cuid())
  personId               String
  termId                 String
  cycleId                String
  status                 TrainingStatus   @default(PENDING)
  completedVia           TrainingMethod?
  completedAt            DateTime?
  attendanceRecordedById String?
  attendanceRecordedAt   DateTime?
  locked                 Boolean          @default(false)
  lockResetAt            DateTime?
  subcommitteeInterest   String?
  additionalShiftAvailability String?
  minShiftsWanted        String?
  feedback               String?
  createdAt              DateTime         @default(now())
  updatedAt              DateTime         @updatedAt

  person               Person           @relation("volunteerTrainingPerson", fields: [personId], references: [id], onDelete: Cascade)
  term                 Term             @relation(fields: [termId], references: [id], onDelete: Cascade)
  cycle                RecruitmentCycle @relation(fields: [cycleId], references: [id], onDelete: Restrict)
  attendanceRecordedBy Person?          @relation("volunteerTrainingAttendanceRecorder", fields: [attendanceRecordedById], references: [id], onDelete: SetNull)
  attempts             QuizAttempt[]

  @@unique([personId, termId])
  @@index([termId])
}

model QuizAttempt {
  id         String   @id @default(cuid())
  trainingId String
  answers    Json
  score      Int
  total      Int
  passed     Boolean
  takenAt    DateTime @default(now())

  training VolunteerTraining @relation(fields: [trainingId], references: [id], onDelete: Cascade)

  @@index([trainingId, takenAt])
}
```

- [ ] **Step 5: Add the back-relations on `Person` and `Term`.** In `model Person` add two relation fields (anywhere in its relation list):

```prisma
  volunteerTrainings        VolunteerTraining[] @relation("volunteerTrainingPerson")
  trainingAttendanceMarked  VolunteerTraining[] @relation("volunteerTrainingAttendanceRecorder")
```

In `model Term` add (beside `recruitmentCycles`):

```prisma
  volunteerTrainings VolunteerTraining[]
```

- [ ] **Step 6: Generate the migration.** Run `npm run db:migrate -- --name recruitment_training`. INSPECT the SQL: it must be additive only (3 CREATE TYPE, 2 CREATE TABLE, ALTER TABLE ADD COLUMN x5 on existing tables, indexes, FKs). It will NOT yet contain the partial unique index (Prisma cannot express it); you add that next. STOP if you see any DROP.

- [ ] **Step 7: Add the partial unique index by hand.** Append to the just-generated `prisma/migrations/<ts>_recruitment_training/migration.sql`:

```sql
-- One designated training cycle per term (partial unique; Prisma cannot express this predicate).
CREATE UNIQUE INDEX "RecruitmentCycle_termId_training_unique"
  ON "RecruitmentCycle"("termId") WHERE "isTermTraining";
```

Apply it to the dev DB: `npx prisma migrate resolve --rolled-back <ts>_recruitment_training` is NOT needed; instead run the raw statement once against dev with `npx prisma db execute --file prisma/migrations/<ts>_recruitment_training/migration.sql --schema prisma/schema.prisma` ONLY if migrate dev did not already apply the appended SQL. Simpler and safe: re-run `npm run db:migrate` with no name; Prisma detects the appended statement is already represented and marks it applied, or apply the single index via `npx prisma db execute`. Verify with `npx prisma migrate status` showing no pending migrations.

- [ ] **Step 8: Add the new tables to `resetDb`.** In `src/platform/test/db.ts`, add `"VolunteerTraining"` and `"QuizAttempt"` to the TRUNCATE list, immediately before `"OnboardingContract"`:

```ts
    `TRUNCATE "QuizAttempt", "VolunteerTraining", "Evaluation", "InterviewPanelist", "Interview", "OnboardingContract", "Acceptance", "Application", "Applicant", "FormField", "FormSection", "RecruitmentCycle",
```

(Keep the rest of the statement exactly as-is.)

- [ ] **Step 9: Write a schema smoke test.** Create `src/modules/recruitment/services/training-schema.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("persists a VolunteerTraining row and a QuizAttempt, and enforces one training cycle per term", async () => {
  const term = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const c1 = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "A", publicSlug: "a", departments: [], createdById: srr.id, isTermTraining: true } });

  const training = await prisma.volunteerTraining.create({ data: { personId: srr.id, termId: term.id, cycleId: c1.id } });
  expect(training.status).toBe("PENDING");
  const attempt = await prisma.quizAttempt.create({ data: { trainingId: training.id, answers: {}, score: 0, total: 2, passed: false } });
  expect(attempt.passed).toBe(false);

  // Second training cycle in the same term cannot also be designated.
  await expect(
    prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "B", publicSlug: "b", departments: [], createdById: srr.id, isTermTraining: true } })
  ).rejects.toMatchObject({ code: "P2002" });
});
```

- [ ] **Step 10: Run the smoke test.** `npx vitest run src/modules/recruitment/services/training-schema.test.ts`. Expected: PASS. If the partial-unique assertion fails, the index from Step 7 was not applied; apply it and re-run.

- [ ] **Step 11: Commit.**

```bash
git add prisma/schema.prisma prisma/migrations src/platform/test/db.ts src/modules/recruitment/services/training-schema.test.ts
git commit -m "feat(recruitment): training + quiz schema (VolunteerTraining, QuizAttempt, quiz form fields)"
```

---

## Task 2: Quiz grading engine (pure)

**Files:**
- Create: `src/modules/recruitment/engine/quiz-grading.ts`
- Test: `src/modules/recruitment/engine/quiz-grading.test.ts`

- [ ] **Step 1: Write the failing test.** Create `src/modules/recruitment/engine/quiz-grading.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { gradeQuiz, type GradedQuestion } from "./quiz-grading";

const q = (key: string, correctValue: string | null): GradedQuestion => ({ key, correctValue });

describe("gradeQuiz", () => {
  it("scores only graded questions and computes percent", () => {
    const questions = [q("a", "x"), q("b", "y"), q("c", null)]; // c is non-graded
    const r = gradeQuiz(questions, { a: "x", b: "z", c: "anything" }, 50);
    expect(r.score).toBe(1);
    expect(r.total).toBe(2);
    expect(r.percent).toBe(50);
    expect(r.passed).toBe(true); // 50 >= 50
  });

  it("passes at exactly the threshold and fails below it", () => {
    const questions = [q("a", "x"), q("b", "y"), q("c", "z"), q("d", "w")];
    const answers = { a: "x", b: "y", c: "z", d: "WRONG" }; // 3/4 = 75
    expect(gradeQuiz(questions, answers, 75).passed).toBe(true);
    expect(gradeQuiz(questions, answers, 76).passed).toBe(false);
  });

  it("treats missing answers as wrong", () => {
    const r = gradeQuiz([q("a", "x"), q("b", "y")], { a: "x" }, 80);
    expect(r.score).toBe(1);
    expect(r.total).toBe(2);
    expect(r.percent).toBe(50);
    expect(r.passed).toBe(false);
  });

  it("never passes a quiz with no graded questions", () => {
    const r = gradeQuiz([q("a", null)], { a: "x" }, 0);
    expect(r.total).toBe(0);
    expect(r.percent).toBe(0);
    expect(r.passed).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify failure.** `npx vitest run src/modules/recruitment/engine/quiz-grading.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Create `src/modules/recruitment/engine/quiz-grading.ts`:

```ts
/** Pure quiz grader. No DB, no side effects. A question with correctValue == null
 *  is non-graded (excluded from the total). A quiz with no graded questions can
 *  never pass, so an unfinished quiz never clears a volunteer. */

export type GradedQuestion = { key: string; correctValue: string | null };

export type QuizResult = {
  score: number;
  total: number;
  percent: number;
  passed: boolean;
};

export function gradeQuiz(
  questions: GradedQuestion[],
  answers: Record<string, unknown>,
  passPercent: number
): QuizResult {
  const graded = questions.filter((q) => q.correctValue !== null);
  const total = graded.length;
  let score = 0;
  for (const q of graded) {
    if (answers[q.key] === q.correctValue) score += 1;
  }
  const percent = total === 0 ? 0 : Math.round((100 * score) / total);
  const passed = total > 0 && percent >= passPercent;
  return { score, total, percent, passed };
}
```

- [ ] **Step 4: Run it to verify pass.** `npx vitest run src/modules/recruitment/engine/quiz-grading.test.ts`. Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/modules/recruitment/engine/quiz-grading.ts src/modules/recruitment/engine/quiz-grading.test.ts
git commit -m "feat(recruitment): pure quiz grading engine"
```

---

## Task 3: Overall clearance (pure)

**Files:**
- Modify: `src/platform/compliance/rules.ts`
- Test: `src/platform/compliance/rules.test.ts` (append)

- [ ] **Step 1: Write the failing test.** Append to `src/platform/compliance/rules.test.ts`:

```ts
import { overallClearance } from "./rules";

describe("overallClearance", () => {
  it("is CLEARED only when the cert is valid and training is COMPLETE", () => {
    expect(overallClearance("COMPLIANT", "COMPLETE")).toBe("CLEARED");
    expect(overallClearance("EXPIRING_SOON", "COMPLETE")).toBe("CLEARED");
    expect(overallClearance("COMPLIANT", "PENDING")).toBe("NOT_CLEARED");
    expect(overallClearance("EXPIRING_SOON", "PENDING")).toBe("NOT_CLEARED");
  });

  it("is NOT_CLEARED for any invalid cert regardless of training", () => {
    for (const s of ["EXPIRED", "UNKNOWN_DATE", "NO_CERTIFICATE"] as const) {
      expect(overallClearance(s, "COMPLETE")).toBe("NOT_CLEARED");
      expect(overallClearance(s, "PENDING")).toBe("NOT_CLEARED");
    }
  });
});
```

(If `rules.test.ts` already imports from `./rules` and uses `describe`, fold this `describe` block in beside the others and reuse the existing import line rather than adding a duplicate import.)

- [ ] **Step 2: Run it to verify failure.** `npx vitest run src/platform/compliance/rules.test.ts`. Expected: FAIL (`overallClearance` is not exported).

- [ ] **Step 3: Implement.** Append to `src/platform/compliance/rules.ts`:

```ts
/** Training state for a person in a term: COMPLETE once they have a completed
 *  VolunteerTraining row, else PENDING. Derived, never stored on the cert. */
export type TrainingState = "PENDING" | "COMPLETE";

/** The combined clearance a volunteer needs to be active for the term: a valid
 *  certificate AND completed training. The certificate-specific ComplianceStatus
 *  values are unchanged; this only combines them with training. */
export type OverallClearance = "CLEARED" | "NOT_CLEARED";

export function overallClearance(
  certStatus: ComplianceStatus,
  training: TrainingState
): OverallClearance {
  const certValid = certStatus === "COMPLIANT" || certStatus === "EXPIRING_SOON";
  return certValid && training === "COMPLETE" ? "CLEARED" : "NOT_CLEARED";
}
```

- [ ] **Step 4: Run it to verify pass.** `npx vitest run src/platform/compliance/rules.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/platform/compliance/rules.ts src/platform/compliance/rules.test.ts
git commit -m "feat(compliance): overallClearance combines cert status with training state"
```

---

## Task 4: Training service, part 1 (designated cycle + quiz settings)

**Files:**
- Create: `src/modules/recruitment/services/training.ts`
- Test: `src/modules/recruitment/services/training.test.ts`

- [ ] **Step 1: Write the failing test.** Create `src/modules/recruitment/services/training.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import {
  setTrainingCycle, getTrainingCycleForTerm, updateQuizSettings, TrainingStateError,
} from "./training";

async function seed() {
  const term = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.manage_cycles" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const plain = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });
  const c1 = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "A", publicSlug: "a", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  const c2 = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "B", publicSlug: "b", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  return { term, srr, plain, c1, c2 };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("designates one training cycle per term; re-designating moves the flag", async () => {
  const { term, srr, c1, c2 } = await seed();
  await setTrainingCycle(c1.id, true, srr.id);
  expect((await getTrainingCycleForTerm(term.id))?.id).toBe(c1.id);
  // Designating c2 clears c1.
  await setTrainingCycle(c2.id, true, srr.id);
  expect((await getTrainingCycleForTerm(term.id))?.id).toBe(c2.id);
  expect((await prisma.recruitmentCycle.findUnique({ where: { id: c1.id } }))?.isTermTraining).toBe(false);
  // Turning it off leaves no designated cycle.
  await setTrainingCycle(c2.id, false, srr.id);
  expect(await getTrainingCycleForTerm(term.id)).toBeNull();
});

it("requires manage_cycles to designate", async () => {
  const { plain, c1 } = await seed();
  await expect(setTrainingCycle(c1.id, true, plain.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("updates quiz settings within bounds and rejects bad values", async () => {
  const { srr, c1 } = await seed();
  const updated = await updateQuizSettings(c1.id, { quizPassPercent: 90, quizMaxAttempts: 5 }, srr.id);
  expect(updated.quizPassPercent).toBe(90);
  expect(updated.quizMaxAttempts).toBe(5);
  await expect(updateQuizSettings(c1.id, { quizPassPercent: 150, quizMaxAttempts: 5 }, srr.id)).rejects.toBeInstanceOf(TrainingStateError);
  await expect(updateQuizSettings(c1.id, { quizPassPercent: 80, quizMaxAttempts: 0 }, srr.id)).rejects.toBeInstanceOf(TrainingStateError);
});
```

- [ ] **Step 2: Run it to verify failure.** `npx vitest run src/modules/recruitment/services/training.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement the service skeleton + these three functions.** Create `src/modules/recruitment/services/training.ts`:

```ts
import type { RecruitmentCycle } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";

export class TrainingStateError extends Error {
  constructor(message: string) { super(message); this.name = "TrainingStateError"; }
}
export class QuizLockedError extends Error {
  constructor(message: string) { super(message); this.name = "QuizLockedError"; }
}

/** The term's designated training cycle, or null. */
export async function getTrainingCycleForTerm(termId: string): Promise<RecruitmentCycle | null> {
  return prisma.recruitmentCycle.findFirst({ where: { termId, isTermTraining: true } });
}

/** Mark a cycle as the term's training source (or clear it). Designating one
 *  clears any other in the same term inside a transaction, preserving the
 *  one-per-term invariant. Requires manage_cycles. */
export async function setTrainingCycle(cycleId: string, value: boolean, actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new RecruitmentAuthError("Only recruitment leads can set the training cycle.");
  }
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new TrainingStateError("Cycle not found.");
  if (cycle.track !== "VOLUNTEER") throw new TrainingStateError("Only a volunteer cycle can host training.");
  await prisma.$transaction(async (tx) => {
    if (value) {
      await tx.recruitmentCycle.updateMany({ where: { termId: cycle.termId, isTermTraining: true, NOT: { id: cycleId } }, data: { isTermTraining: false } });
    }
    await tx.recruitmentCycle.update({ where: { id: cycleId }, data: { isTermTraining: value } });
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_designate", entityType: "RecruitmentCycle", entityId: cycleId, after: { isTermTraining: value } });
}

/** Update the cycle's quiz threshold and attempt cap. Requires manage_cycles. */
export async function updateQuizSettings(
  cycleId: string,
  input: { quizPassPercent: number; quizMaxAttempts: number },
  actorId: string
): Promise<RecruitmentCycle> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new RecruitmentAuthError("Only recruitment leads can change quiz settings.");
  }
  if (!Number.isInteger(input.quizPassPercent) || input.quizPassPercent < 0 || input.quizPassPercent > 100) {
    throw new TrainingStateError("Pass percent must be between 0 and 100.");
  }
  if (!Number.isInteger(input.quizMaxAttempts) || input.quizMaxAttempts < 1) {
    throw new TrainingStateError("Max attempts must be at least 1.");
  }
  const updated = await prisma.recruitmentCycle.update({ where: { id: cycleId }, data: { quizPassPercent: input.quizPassPercent, quizMaxAttempts: input.quizMaxAttempts } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_quiz_settings", entityType: "RecruitmentCycle", entityId: cycleId, after: input });
  return updated;
}
```

- [ ] **Step 4: Run it to verify pass.** `npx vitest run src/modules/recruitment/services/training.test.ts`. Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/modules/recruitment/services/training.ts src/modules/recruitment/services/training.test.ts
git commit -m "feat(recruitment): designate term training cycle and quiz settings"
```

---

## Task 5: Training service, part 2 (attendance + training-state resolution)

**Files:**
- Modify: `src/modules/recruitment/services/training.ts`
- Test: `src/modules/recruitment/services/training.test.ts` (append)

- [ ] **Step 1: Write the failing test.** Append to `src/modules/recruitment/services/training.test.ts`:

```ts
import { recordAttendance, resolveTrainingState, completeTraining } from "./training";

async function seedMember(opts: { directorOf?: string } = {}) {
  const base = await seed();
  const dept = await prisma.department.findUniqueOrThrow({ where: { code: "SRHD" } });
  await setTrainingCycle(base.c1.id, true, base.srr.id);
  const vol = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
  const membership = await prisma.termMembership.create({ data: { personId: vol.id, termId: base.term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  // A department director scoped to SRHD via an active DIRECTOR membership.
  const dir = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: dir.id, termId: base.term.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
  return { ...base, dept, vol, membership, dir };
}

it("records attendance: marks COMPLETE/ATTENDANCE for the person and is idempotent", async () => {
  const { term, srr, vol } = await seedMember();
  await recordAttendance(vol.id, term.id, srr.id);
  expect(await resolveTrainingState(vol.id, term.id)).toBe("COMPLETE");
  const row = await prisma.volunteerTraining.findUniqueOrThrow({ where: { personId_termId: { personId: vol.id, termId: term.id } } });
  expect(row.completedVia).toBe("ATTENDANCE");
  expect(row.attendanceRecordedById).toBe(srr.id);
  // Idempotent: second tick does not throw or duplicate.
  await recordAttendance(vol.id, term.id, srr.id);
  expect(await prisma.volunteerTraining.count({ where: { personId: vol.id, termId: term.id } })).toBe(1);
});

it("a director in scope can record attendance; an unrelated person cannot", async () => {
  const { term, vol, dir, plain } = await seedMember();
  await recordAttendance(vol.id, term.id, dir.id); // SRHD director, in scope
  expect(await resolveTrainingState(vol.id, term.id)).toBe("COMPLETE");
  // Reset and try with an out-of-scope plain person.
  await prisma.volunteerTraining.deleteMany({});
  await expect(recordAttendance(vol.id, term.id, plain.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("resolveTrainingState is PENDING with no row (no backfill)", async () => {
  const { term, vol } = await seedMember();
  expect(await resolveTrainingState(vol.id, term.id)).toBe("PENDING");
});

it("recordAttendance fails when the term has no designated training cycle", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  await setTrainingCycle(c1.id, false, srr.id);
  await expect(recordAttendance(vol.id, term.id, srr.id)).rejects.toBeInstanceOf(TrainingStateError);
});
```

- [ ] **Step 2: Run it to verify failure.** `npx vitest run src/modules/recruitment/services/training.test.ts`. Expected: FAIL (`recordAttendance`/`resolveTrainingState`/`completeTraining` not exported).

- [ ] **Step 3: Implement.** Add to `src/modules/recruitment/services/training.ts` (import `reviewScope` and the prisma client tx type):

```ts
import type { Prisma, TrainingMethod, TrainingState } from "@prisma/client";
import { reviewScope } from "./review";
```

Note: `TrainingState` is not a Prisma type; import it from the compliance rules instead:

```ts
import type { TrainingState } from "@/platform/compliance/rules";
```

Then add the functions:

```ts
type Tx = Prisma.TransactionClient;

/** PENDING unless the person has a COMPLETE VolunteerTraining row for the term. */
export async function resolveTrainingState(personId: string, termId: string): Promise<TrainingState> {
  const row = await prisma.volunteerTraining.findUnique({ where: { personId_termId: { personId, termId } } });
  return row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";
}

/** Upsert the person's training row to COMPLETE for the term, stamping the method.
 *  Shared by the attendance and quiz paths. Idempotent. */
export async function completeTraining(
  db: Tx | typeof prisma,
  args: { personId: string; termId: string; cycleId: string; via: TrainingMethod; actorId?: string }
): Promise<void> {
  const now = new Date();
  const attendance = args.via === "ATTENDANCE";
  await db.volunteerTraining.upsert({
    where: { personId_termId: { personId: args.personId, termId: args.termId } },
    create: {
      personId: args.personId, termId: args.termId, cycleId: args.cycleId,
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

/** Record live-session attendance for a volunteer (by personId) in the term.
 *  Director-scoped (the volunteer must be in a department the actor manages) or
 *  review_all. Completes via ATTENDANCE. */
export async function recordAttendance(personId: string, termId: string, actorId: string): Promise<void> {
  const cycle = await getTrainingCycleForTerm(termId);
  if (!cycle) throw new TrainingStateError("This term has no designated training cycle.");

  // The volunteer's active VOLUNTEER memberships in the term, with department codes.
  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId, kind: "VOLUNTEER", status: "ACTIVE" },
    include: { department: { select: { code: true } } },
  });
  if (memberships.length === 0) throw new TrainingStateError("Not an active volunteer this term.");

  const scope = await reviewScope(actorId);
  const inScope = scope.all || memberships.some((m) => scope.departmentCodes.includes(m.department.code));
  if (!inScope) throw new RecruitmentAuthError("You can't record training for that volunteer.");

  await completeTraining(prisma, { personId, termId, cycleId: cycle.id, via: "ATTENDANCE", actorId });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_attendance", entityType: "VolunteerTraining", entityId: `${personId}:${termId}`, after: { personId, termId } });
}
```

- [ ] **Step 4: Run it to verify pass.** `npx vitest run src/modules/recruitment/services/training.test.ts`. Expected: PASS (all training tests so far).

- [ ] **Step 5: Commit.**

```bash
git add src/modules/recruitment/services/training.ts src/modules/recruitment/services/training.test.ts
git commit -m "feat(recruitment): record attendance and resolve training state"
```

---

## Task 6: Training service, part 3 (quiz submission, lock, reset, self-serve read)

**Files:**
- Modify: `src/modules/recruitment/services/training.ts`
- Test: `src/modules/recruitment/services/training.test.ts` (append)

- [ ] **Step 1: Write the failing test.** Append to `src/modules/recruitment/services/training.test.ts`:

```ts
import { getMyTraining, submitQuiz, resetTraining } from "./training";

/** Add a 2-question quiz to the designated cycle (both graded). */
async function addQuiz(cycleId: string) {
  const section = await prisma.formSection.create({ data: { cycleId, title: "Quiz", order: 10, appliesTo: "BOTH", purpose: "QUIZ" } });
  await prisma.formField.createMany({ data: [
    { sectionId: section.id, cycleId, key: "q1", label: "Q1", type: "SINGLE_SELECT", order: 0, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], correctValue: "a" },
    { sectionId: section.id, cycleId, key: "q2", label: "Q2", type: "SINGLE_SELECT", order: 1, options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }], correctValue: "y" },
  ] });
}

it("quiz path: failing accrues attempts then locks; passing completes and saves intake", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  await updateQuizSettings(c1.id, { quizPassPercent: 100, quizMaxAttempts: 2 }, srr.id);
  await addQuiz(c1.id);

  // First failing attempt.
  const r1 = await submitQuiz(vol.id, { answers: { q1: "a", q2: "x" }, intake: { feedback: "hi" } });
  expect(r1.passed).toBe(false);
  expect(await resolveTrainingState(vol.id, term.id)).toBe("PENDING");

  // Second failing attempt reaches the cap and locks.
  const r2 = await submitQuiz(vol.id, { answers: { q1: "a", q2: "x" }, intake: {} });
  expect(r2.passed).toBe(false);
  const locked = await prisma.volunteerTraining.findUniqueOrThrow({ where: { personId_termId: { personId: vol.id, termId: term.id } } });
  expect(locked.locked).toBe(true);

  // Submitting while locked is rejected.
  await expect(submitQuiz(vol.id, { answers: { q1: "a", q2: "y" }, intake: {} })).rejects.toBeInstanceOf(QuizLockedError);

  // Director reset opens a fresh window.
  await resetTraining(vol.id, term.id, srr.id);
  const r3 = await submitQuiz(vol.id, { answers: { q1: "a", q2: "y" }, intake: { feedback: "done" } });
  expect(r3.passed).toBe(true);
  const done = await prisma.volunteerTraining.findUniqueOrThrow({ where: { personId_termId: { personId: vol.id, termId: term.id } } });
  expect(done.status).toBe("COMPLETE");
  expect(done.completedVia).toBe("QUIZ");
  expect(done.feedback).toBe("done");
  // Prior attempts are preserved as history (3 attempts total).
  expect(await prisma.quizAttempt.count({ where: { training: { personId: vol.id, termId: term.id } } })).toBe(3);
});

it("getMyTraining returns the cycle, questions, and state for the volunteer", async () => {
  const { vol, c1 } = await seedMember();
  await addQuiz(c1.id);
  const my = await getMyTraining(vol.id);
  expect(my.state).toBe("PENDING");
  expect(my.locked).toBe(false);
  expect(my.questions.map((q) => q.key)).toEqual(["q1", "q2"]);
});

it("submitQuiz rejects when already complete", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  await addQuiz(c1.id);
  await recordAttendance(vol.id, term.id, srr.id); // complete via attendance
  await expect(submitQuiz(vol.id, { answers: { q1: "a", q2: "y" }, intake: {} })).rejects.toBeInstanceOf(TrainingStateError);
});
```

- [ ] **Step 2: Run it to verify failure.** `npx vitest run src/modules/recruitment/services/training.test.ts`. Expected: FAIL (`getMyTraining`/`submitQuiz`/`resetTraining` not exported).

- [ ] **Step 3: Implement.** Add to `src/modules/recruitment/services/training.ts`. Import the grader and types:

```ts
import { gradeQuiz, type GradedQuestion } from "../engine/quiz-grading";
import type { FieldType } from "@prisma/client";
```

Add an intake type, a quiz-question loader, and the three functions:

```ts
export type TrainingIntake = {
  subcommitteeInterest?: string | null;
  additionalShiftAvailability?: string | null;
  minShiftsWanted?: string | null;
  feedback?: string | null;
};

/** Active term used for self-serve training (mirrors compliance: newest ACTIVE term). */
async function activeTermOrThrow() {
  const term = await prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } });
  if (!term) throw new TrainingStateError("No active term.");
  return term;
}

/** The designated cycle's graded quiz questions, in form order. */
async function quizQuestions(cycleId: string): Promise<GradedQuestion[]> {
  const fields = await prisma.formField.findMany({
    where: { cycleId, type: "SINGLE_SELECT", section: { purpose: "QUIZ" } },
    orderBy: [{ section: { order: "asc" } }, { order: "asc" }],
    select: { key: true, correctValue: true },
  });
  return fields.map((f) => ({ key: f.key, correctValue: f.correctValue }));
}

export type MyTraining = {
  term: { id: string; name: string };
  cycle: { id: string; title: string } | null;
  state: TrainingState;
  locked: boolean;
  completedVia: TrainingMethod | null;
  attemptsUsed: number;
  maxAttempts: number;
  passPercent: number;
  questions: { key: string; label: string; options: { value: string; label: string }[] }[];
  intake: TrainingIntake;
};

/** Everything the volunteer's /training page needs. */
export async function getMyTraining(personId: string): Promise<MyTraining> {
  const term = await activeTermOrThrow();
  const cycle = await getTrainingCycleForTerm(term.id);
  const row = await prisma.volunteerTraining.findUnique({ where: { personId_termId: { personId, termId: term.id } } });
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

  return {
    term: { id: term.id, name: term.name },
    cycle: cycle ? { id: cycle.id, title: cycle.title } : null,
    state, locked: row?.locked ?? false, completedVia: row?.completedVia ?? null,
    attemptsUsed, maxAttempts: cycle?.quizMaxAttempts ?? 0, passPercent: cycle?.quizPassPercent ?? 0,
    questions,
    intake: {
      subcommitteeInterest: row?.subcommitteeInterest ?? null,
      additionalShiftAvailability: row?.additionalShiftAvailability ?? null,
      minShiftsWanted: row?.minShiftsWanted ?? null,
      feedback: row?.feedback ?? null,
    },
  };
}

/** Grade and persist a quiz attempt for the signed-in volunteer. Lazily creates
 *  the training row. Saves intake. On pass: completes training (clears all the
 *  person's active volunteer memberships in the term). On reaching the attempt
 *  cap without a pass: locks. Prior attempts are never deleted. */
export async function submitQuiz(
  personId: string,
  input: { answers: Record<string, unknown>; intake: TrainingIntake }
): Promise<QuizResultPublic> {
  const term = await activeTermOrThrow();
  const cycle = await getTrainingCycleForTerm(term.id);
  if (!cycle) throw new TrainingStateError("This term has no designated training cycle.");

  const isVolunteer = await prisma.termMembership.count({ where: { personId, termId: term.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  if (isVolunteer === 0) throw new TrainingStateError("Not an active volunteer this term.");

  const questions = await quizQuestions(cycle.id);
  if (questions.length === 0) throw new TrainingStateError("This training has no quiz questions yet.");

  return prisma.$transaction(async (tx) => {
    // Lazily create or load the training row.
    const row = await tx.volunteerTraining.upsert({
      where: { personId_termId: { personId, termId: term.id } },
      create: { personId, termId: term.id, cycleId: cycle.id },
      update: {},
    });
    if (row.status === "COMPLETE") throw new TrainingStateError("Training is already complete.");
    if (row.locked) throw new QuizLockedError("Your quiz is locked. Ask your director to reset it.");

    // Save intake.
    await tx.volunteerTraining.update({
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

    if (result.passed) {
      await completeTraining(tx, { personId, termId: term.id, cycleId: cycle.id, via: "QUIZ" });
    } else {
      const windowAttempts = await tx.quizAttempt.count({ where: { trainingId: row.id, ...(row.lockResetAt ? { takenAt: { gte: row.lockResetAt } } : {}) } });
      if (windowAttempts >= cycle.quizMaxAttempts) {
        await tx.volunteerTraining.update({ where: { id: row.id }, data: { locked: true } });
      }
    }
    return { score: result.score, total: result.total, percent: result.percent, passed: result.passed };
  });
}

/** Clear a locked volunteer so they can retake the quiz. Opens a fresh attempt
 *  window (lockResetAt = now); prior attempts stay in history. Director-scoped or
 *  review_all. */
export async function resetTraining(personId: string, termId: string, actorId: string): Promise<void> {
  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId, kind: "VOLUNTEER", status: "ACTIVE" },
    include: { department: { select: { code: true } } },
  });
  if (memberships.length === 0) throw new TrainingStateError("Not an active volunteer this term.");
  const scope = await reviewScope(actorId);
  const inScope = scope.all || memberships.some((m) => scope.departmentCodes.includes(m.department.code));
  if (!inScope) throw new RecruitmentAuthError("You can't reset training for that volunteer.");

  await prisma.volunteerTraining.updateMany({ where: { personId, termId, status: { not: "COMPLETE" } }, data: { locked: false, lockResetAt: new Date() } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_reset", entityType: "VolunteerTraining", entityId: `${personId}:${termId}` });
}
```

Add the public result type near the top (after the error classes):

```ts
export type QuizResultPublic = { score: number; total: number; percent: number; passed: boolean };
```

- [ ] **Step 4: Run it to verify pass.** `npx vitest run src/modules/recruitment/services/training.test.ts`. Expected: PASS (all training tests).

- [ ] **Step 5: Commit.**

```bash
git add src/modules/recruitment/services/training.ts src/modules/recruitment/services/training.test.ts
git commit -m "feat(recruitment): quiz submission with attempt cap, lock, reset, and self-serve read"
```

---

## Task 7: Builder quiz extension and public-form exclusion

**Files:**
- Modify: `src/modules/recruitment/services/form-builder.ts`
- Modify: `src/modules/recruitment/services/submissions.ts` (exclude QUIZ sections from the public form)
- Test: `src/modules/recruitment/services/form-builder.test.ts` (append)
- Test: `src/modules/recruitment/services/submissions.test.ts` (append one case)

- [ ] **Step 1: Write the failing builder test.** Append to `src/modules/recruitment/services/form-builder.test.ts` (reuse its existing seed/imports; if it has a `seed()` returning a cycle id, use that, otherwise create a DRAFT cycle inline as the other tests do):

```ts
import { addSection, addField, updateField } from "./form-builder";

it("creates a QUIZ section and a graded question with a correctValue", async () => {
  // Arrange: a DRAFT cycle (reuse the file's existing helper or create one inline).
  const term = await prisma.term.create({ data: { code: "SU26", name: "S", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "C", publicSlug: "c", departments: [], createdById: srr.id, status: "DRAFT" } });

  const section = await addSection(cycle.id, { title: "Quiz", appliesTo: "BOTH", departmentCode: null, purpose: "QUIZ" });
  expect(section.purpose).toBe("QUIZ");
  const field = await addField(section.id, { label: "Capital of France?", type: "SINGLE_SELECT", required: true, options: [{ value: "paris", label: "Paris" }, { value: "lyon", label: "Lyon" }], correctValue: "paris" });
  expect(field.correctValue).toBe("paris");

  // correctValue is a safe edit even after OPEN.
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "OPEN" } });
  const updated = await updateField(field.id, { correctValue: "lyon" });
  expect(updated.correctValue).toBe("lyon");
});
```

- [ ] **Step 2: Run it to verify failure.** `npx vitest run src/modules/recruitment/services/form-builder.test.ts`. Expected: FAIL (`purpose`/`correctValue` not accepted).

- [ ] **Step 3: Implement builder changes.** In `src/modules/recruitment/services/form-builder.ts`:

Extend `addSection`'s input and create data:

```ts
export async function addSection(
  cycleId: string,
  input: { title: string; appliesTo: ApplicantScope; departmentCode: string | null; description?: string; purpose?: "APPLICATION" | "QUIZ" }
): Promise<FormSection> {
  await assertCycleEditable(cycleId, false);
  const count = await prisma.formSection.count({ where: { cycleId } });
  return prisma.formSection.create({
    data: { cycleId, title: input.title, description: input.description ?? null, appliesTo: input.appliesTo, departmentCode: input.departmentCode, purpose: input.purpose ?? "APPLICATION", order: count },
  });
}
```

Extend `addField`'s input and create data with `correctValue`:

```ts
export async function addField(
  sectionId: string,
  input: { label: string; type: FieldType; required: boolean; helpText?: string; options?: unknown; validation?: unknown; correctValue?: string | null }
): Promise<FormField> {
  const section = await prisma.formSection.findUnique({ where: { id: sectionId } });
  if (!section) throw new FormEditError("Section not found.");
  await assertCycleEditable(section.cycleId, input.required === true);

  const existing = await prisma.formField.findMany({ where: { cycleId: section.cycleId }, select: { key: true } });
  const key = uniqueKey(input.label, existing.map((f) => f.key));
  const count = await prisma.formField.count({ where: { sectionId } });

  return prisma.formField.create({
    data: {
      sectionId, cycleId: section.cycleId, key, label: input.label, type: input.type,
      required: input.required, helpText: input.helpText ?? null,
      options: (input.options ?? undefined) as never, validation: (input.validation ?? undefined) as never,
      correctValue: input.correctValue ?? null,
      order: count,
    },
  });
}
```

Extend `updateField`'s patch with `correctValue` (a SAFE edit, so it does not affect the `structural` flag):

```ts
export async function updateField(
  fieldId: string,
  patch: { label?: string; helpText?: string; type?: FieldType; required?: boolean; options?: unknown; validation?: unknown; correctValue?: string | null }
): Promise<FormField> {
  const field = await prisma.formField.findUnique({ where: { id: fieldId } });
  if (!field) throw new FormEditError("Field not found.");

  const structural =
    (patch.type !== undefined && patch.type !== field.type) ||
    (patch.required === true && field.required === false);
  await assertCycleEditable(field.cycleId, structural);

  return prisma.formField.update({
    where: { id: fieldId },
    data: {
      label: patch.label ?? undefined,
      helpText: patch.helpText ?? undefined,
      type: patch.type ?? undefined,
      required: patch.required ?? undefined,
      options: patch.options === undefined ? undefined : (patch.options as never),
      validation: patch.validation === undefined ? undefined : (patch.validation as never),
      correctValue: patch.correctValue === undefined ? undefined : patch.correctValue,
    },
  });
}
```

- [ ] **Step 4: Run it to verify pass.** `npx vitest run src/modules/recruitment/services/form-builder.test.ts`. Expected: PASS.

- [ ] **Step 5: Exclude QUIZ sections from the public application.** Open `src/modules/recruitment/services/submissions.ts` and find where it loads the cycle's sections to build the schema and render the public form (it maps sections to `SectionDef`/uses `getCycle` or a direct `formSection.findMany`). Add `purpose: "APPLICATION"` to that section query's `where`, OR filter the loaded sections with `.filter((s) => s.purpose === "APPLICATION")` before passing them to `buildApplicationSchema` and before returning them for render. Find the exact spot:

Run: `grep -n "formSection\|sections\|buildApplicationSchema\|getCycle" src/modules/recruitment/services/submissions.ts`

Apply the filter at every place sections feed the public form or its server-side validation. Quiz sections must never appear in `/apply/[slug]` nor be enforced by `buildApplicationSchema`.

- [ ] **Step 6: Write the failing exclusion test.** Append to `src/modules/recruitment/services/submissions.test.ts` a case that adds a QUIZ section with a required field to an OPEN cycle, then submits a valid application WITHOUT answering the quiz field, and asserts the submission succeeds (the quiz field is not enforced) and the stored answers do not require it. Model the seed and submit call on the existing passing tests in that file (reuse its `seed()` and the submit function it already imports). Example shape:

```ts
it("ignores QUIZ sections when validating and rendering the public application", async () => {
  const { cycle /* OPEN, from this file's seed */ } = await seedOpenCycle();
  const quiz = await prisma.formSection.create({ data: { cycleId: cycle.id, title: "Quiz", order: 99, appliesTo: "BOTH", purpose: "QUIZ" } });
  await prisma.formField.create({ data: { sectionId: quiz.id, cycleId: cycle.id, key: "secret_q", label: "Q", type: "SINGLE_SELECT", required: true, order: 0, options: [{ value: "a", label: "A" }], correctValue: "a" } });
  // Submitting WITHOUT secret_q must still succeed.
  const app = await submitApplicationUnderTest(/* valid identity answers only */);
  expect(app).toBeTruthy();
});
```

Adapt `seedOpenCycle`/`submitApplicationUnderTest` to the file's real helpers and the real submit signature.

- [ ] **Step 7: Run both tests.** `npx vitest run src/modules/recruitment/services/submissions.test.ts src/modules/recruitment/services/form-builder.test.ts`. Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/modules/recruitment/services/form-builder.ts src/modules/recruitment/services/submissions.ts src/modules/recruitment/services/form-builder.test.ts src/modules/recruitment/services/submissions.test.ts
git commit -m "feat(recruitment): quiz sections in builder; exclude them from public intake"
```

---

## Task 8: Compliance read extension (training state + overall clearance)

**Files:**
- Modify: `src/modules/volunteers/services/compliance.ts`
- Test: `src/modules/volunteers/services/compliance.test.ts` (append)

- [ ] **Step 1: Write the failing test.** Append to `src/modules/volunteers/services/compliance.test.ts` (reuse its existing seed that creates an active term, a director with a department, and a volunteer with a cert). Add a designated training cycle + a COMPLETE training row for the volunteer and assert the row carries `trainingState` and `overallClearance`:

```ts
it("departmentCompliance carries training state and overall clearance", async () => {
  const { activeTerm, director, dept, volunteer } = await seedDirectorWithVolunteer(); // adapt to the file's real helper
  // Give the volunteer a COMPLIANT cert (recent completion date).
  await prisma.hipaaCertificate.create({ data: { personId: volunteer.id, fileName: "c.pdf", storedName: "c.pdf", size: 1, mimeType: "application/pdf", completionDate: new Date() } });
  // Designate a training cycle and mark the volunteer COMPLETE.
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: activeTerm.id, title: "T", publicSlug: "t", departments: [dept.code], createdById: srr.id, isTermTraining: true } });
  await prisma.volunteerTraining.create({ data: { personId: volunteer.id, termId: activeTerm.id, cycleId: cycle.id, status: "COMPLETE", completedVia: "QUIZ", completedAt: new Date() } });

  const cards = await departmentCompliance(director.id);
  const row = cards.flatMap((c) => c.members).find((m) => m.person.id === volunteer.id)!;
  expect(row.trainingState).toBe("COMPLETE");
  expect(row.overallClearance).toBe("CLEARED");
});
```

- [ ] **Step 2: Run it to verify failure.** `npx vitest run src/modules/volunteers/services/compliance.test.ts`. Expected: FAIL (`trainingState`/`overallClearance` missing on the row type).

- [ ] **Step 3: Implement.** In `src/modules/volunteers/services/compliance.ts`:

Import the new helpers:

```ts
import { complianceStatus, overallClearance } from "@/platform/compliance/rules";
import type { ComplianceStatus, TrainingState, OverallClearance } from "@/platform/compliance/rules";
```

Extend `MemberCompliance`:

```ts
export type MemberCompliance = {
  person: Person;
  kind: "DIRECTOR" | "VOLUNTEER";
  cert: HipaaCertificate | null;
  status: ComplianceStatus;
  verifiedByName: string | null;
  trainingState: TrainingState;
  overallClearance: OverallClearance;
};
```

In `departmentCompliance`, after fetching `memberships` (the `findMany` near line 107), fetch the COMPLETE training set for the active term once, in one query, and build a person-id set:

```ts
  const completedTraining = new Set(
    (await prisma.volunteerTraining.findMany({
      where: { termId: activeTerm.id, status: "COMPLETE" },
      select: { personId: true },
    })).map((t) => t.personId)
  );
```

Then where each `MemberCompliance` is pushed (the `entry.members.push({...})` near line 176), add:

```ts
    const trainingState: TrainingState = completedTraining.has(m.person.id) ? "COMPLETE" : "PENDING";
    entry.members.push({
      person: m.person,
      kind: m.kind,
      cert: newestCert,
      status,
      verifiedByName,
      trainingState,
      overallClearance: overallClearance(status, trainingState),
    });
```

Do the equivalent in `masterCompliance`: after the active-term lookup, build the same `completedTraining` set; extend `MasterComplianceRow` is `Omit<MemberCompliance, "kind"> & { departments: string[] }`, so it inherits `trainingState`/`overallClearance` automatically. Populate them in the `scope.map(...)` that builds `scopeRows` (near line 360):

```ts
    const trainingState: TrainingState = completedTraining.has(person.id) ? "COMPLETE" : "PENDING";
    return {
      person,
      cert: newestCert,
      status: computedStatus,
      verifiedByName,
      departments: Array.from(deptCodes).sort(),
      trainingState,
      overallClearance: overallClearance(computedStatus, trainingState),
    };
```

(`DIRECTOR` members are volunteers-track-agnostic; training is a volunteer-track concept, but the set only contains people with a training row, so directors simply resolve to PENDING/NOT_CLEARED unless they also hold a training row. This is acceptable: the column is informational and directors are not gated by the volunteer training flow. If the existing compliance UI must not show NOT_CLEARED for directors, gate the display on `kind === "VOLUNTEER"` in the page, not in this service.)

- [ ] **Step 4: Run it to verify pass.** `npx vitest run src/modules/volunteers/services/compliance.test.ts`. Expected: PASS.

- [ ] **Step 5: Surface the new columns in the compliance pages (display only).** Find the compliance page(s) that render `MemberCompliance`/`MasterComplianceRow` rows:

Run: `grep -rln "departmentCompliance\|masterCompliance\|MemberCompliance" src/app src/modules/volunteers/components`

In each table, add a "Training" cell showing `trainingState` and an "Overall" cell showing `overallClearance` (only for `kind === "VOLUNTEER"` rows in the department view; the master view shows it for every row). Keep the existing certificate column and sort untouched. This is presentational; no new test required beyond the service test, but verify the pages typecheck.

- [ ] **Step 6: Typecheck and commit.**

```bash
npm run typecheck
git add src/modules/volunteers/services/compliance.ts src/modules/volunteers/services/compliance.test.ts src/app src/modules/volunteers/components
git commit -m "feat(compliance): surface training state and overall clearance on compliance views"
```

---

## Task 9: Builder quiz authoring UI (Training quiz tab)

**Files:**
- Modify: `src/app/recruitment/cycles/[id]/builder/page.tsx` (add a link/tab to the quiz authoring view)
- Create: `src/app/recruitment/cycles/[id]/builder/quiz/page.tsx`
- Modify: `src/app/recruitment/cycles/[id]/builder/actions.ts` (add quiz section/question actions)

- [ ] **Step 1: Inspect the existing builder.** Read `src/app/recruitment/cycles/[id]/builder/page.tsx` and `.../builder/actions.ts` to learn the section/field action signatures and the form patterns (they call `addSection`/`addField`/`updateField` via server actions, then `revalidatePath`). The quiz tab reuses the same services with `purpose: "QUIZ"` and a `correctValue` control.

- [ ] **Step 2: Add quiz authoring actions.** In `.../builder/actions.ts`, add server actions guarded by `requirePermission("recruitment.manage_cycles")`:

```ts
export async function addQuizSectionAction(cycleId: string, formData: FormData) {
  const person = await requirePermission("recruitment.manage_cycles");
  const title = String(formData.get("title") ?? "").trim() || "Quiz";
  try {
    await addSection(cycleId, { title, appliesTo: "BOTH", departmentCode: null, purpose: "QUIZ" });
  } catch (err) {
    if (err instanceof FormEditError) redirect(`/recruitment/cycles/${cycleId}/builder/quiz?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  revalidatePath(`/recruitment/cycles/${cycleId}/builder/quiz`);
}

export async function addQuizQuestionAction(cycleId: string, sectionId: string, formData: FormData) {
  await requirePermission("recruitment.manage_cycles");
  const label = String(formData.get("label") ?? "").trim();
  // Options arrive as repeated "optionValue"/"optionLabel" pairs from the form.
  const values = formData.getAll("optionValue").map(String);
  const labels = formData.getAll("optionLabel").map(String);
  const options = values.map((v, i) => ({ value: v, label: labels[i] ?? v })).filter((o) => o.value.length > 0);
  const correctValue = String(formData.get("correctValue") ?? "") || null;
  if (!label || options.length < 2) {
    redirect(`/recruitment/cycles/${cycleId}/builder/quiz?error=${encodeURIComponent("A question needs a label and at least two options.")}`);
  }
  await addField(sectionId, { label, type: "SINGLE_SELECT", required: true, options, correctValue });
  revalidatePath(`/recruitment/cycles/${cycleId}/builder/quiz`);
}

export async function setCorrectAnswerAction(cycleId: string, fieldId: string, formData: FormData) {
  await requirePermission("recruitment.manage_cycles");
  const correctValue = String(formData.get("correctValue") ?? "") || null;
  await updateField(fieldId, { correctValue });
  revalidatePath(`/recruitment/cycles/${cycleId}/builder/quiz`);
}
```

Add the imports `addSection`, `addField`, `updateField`, `FormEditError` from `@/modules/recruitment/services/form-builder` if not already present, plus `requirePermission`, `redirect`, `revalidatePath`.

- [ ] **Step 3: Create the quiz authoring page.** Create `src/app/recruitment/cycles/[id]/builder/quiz/page.tsx`. It loads the cycle via `getCycle(id)`, filters `sections` to `purpose === "QUIZ"`, and renders: a form to add a quiz section, and per section a list of questions (each showing its options with a radio to mark the correct one via `setCorrectAnswerAction`) plus an add-question form. Mirror the markup conventions in the existing builder page (Tailwind classes, `<form action={action.bind(null, id, ...)}>`). Example skeleton:

```tsx
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { addQuizSectionAction, addQuizQuestionAction, setCorrectAnswerAction } from "../actions";

export default async function QuizBuilderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  await requirePermission("recruitment.manage_cycles");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const quizSections = cycle.sections.filter((s) => s.purpose === "QUIZ");

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Training quiz: {cycle.title}</h1>
      {error && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {quizSections.map((section) => (
        <section key={section.id} className="rounded border p-4">
          <h2 className="font-medium">{section.title}</h2>
          <ul className="mt-3 space-y-3">
            {section.fields.map((f) => {
              const opts = (f.options as { value: string; label: string }[] | null) ?? [];
              return (
                <li key={f.id} className="text-sm">
                  <p className="font-medium">{f.label}</p>
                  <form action={setCorrectAnswerAction.bind(null, id, f.id)} className="mt-1 flex flex-wrap gap-3">
                    {opts.map((o) => (
                      <label key={o.value} className="flex items-center gap-1">
                        <input type="radio" name="correctValue" value={o.value} defaultChecked={f.correctValue === o.value} />
                        {o.label}
                      </label>
                    ))}
                    <button className="text-xs underline">Save correct answer</button>
                  </form>
                </li>
              );
            })}
          </ul>
          <form action={addQuizQuestionAction.bind(null, id, section.id)} className="mt-4 space-y-2">
            <input name="label" placeholder="Question" className="w-full rounded border px-2 py-1 text-sm" />
            <div className="grid grid-cols-2 gap-2">
              <input name="optionValue" placeholder="value (e.g. a)" className="rounded border px-2 py-1 text-sm" />
              <input name="optionLabel" placeholder="Answer A" className="rounded border px-2 py-1 text-sm" />
              <input name="optionValue" placeholder="value (e.g. b)" className="rounded border px-2 py-1 text-sm" />
              <input name="optionLabel" placeholder="Answer B" className="rounded border px-2 py-1 text-sm" />
            </div>
            <input name="correctValue" placeholder="correct value (e.g. a)" className="w-full rounded border px-2 py-1 text-sm" />
            <button className="rounded-md border px-3 py-1.5 text-sm">Add question</button>
          </form>
        </section>
      ))}

      <form action={addQuizSectionAction.bind(null, id)}>
        <input name="title" placeholder="Quiz section title" className="rounded border px-2 py-1 text-sm" />
        <button className="ml-2 rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white">Add quiz section</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Add a tab link from the application builder.** In `.../builder/page.tsx`, add near the top a link: `<Link href={`/recruitment/cycles/${id}/builder/quiz`} className="...">Training quiz</Link>` so the two authoring surfaces are reachable from each other.

- [ ] **Step 5: Typecheck and build the route.** `npm run typecheck`. Expected: PASS. (No unit test for pages; coverage comes from the e2e in Task 13.)

- [ ] **Step 6: Commit.**

```bash
git add src/app/recruitment/cycles/[id]/builder
git commit -m "feat(recruitment): quiz authoring tab with correct-answer picker"
```

---

## Task 10: Cycle overview, designate training + quiz settings

**Files:**
- Modify: `src/app/recruitment/cycles/[id]/page.tsx`
- Modify: `src/app/recruitment/actions.ts`

- [ ] **Step 1: Add the actions.** In `src/app/recruitment/actions.ts`, add:

```ts
import { setTrainingCycle, updateQuizSettings, TrainingStateError } from "@/modules/recruitment/services/training";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";

export async function setTrainingCycleAction(cycleId: string, value: boolean) {
  const person = await requirePermission("recruitment.manage_cycles");
  try {
    await setTrainingCycle(cycleId, value, person.personId);
  } catch (err) {
    if (err instanceof TrainingStateError || err instanceof RecruitmentAuthError) {
      redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent((err as Error).message)}`);
    }
    throw err;
  }
  revalidatePath(`/recruitment/cycles/${cycleId}`);
}

export async function updateQuizSettingsAction(cycleId: string, formData: FormData) {
  const person = await requirePermission("recruitment.manage_cycles");
  const quizPassPercent = Number(formData.get("quizPassPercent"));
  const quizMaxAttempts = Number(formData.get("quizMaxAttempts"));
  try {
    await updateQuizSettings(cycleId, { quizPassPercent, quizMaxAttempts }, person.personId);
  } catch (err) {
    if (err instanceof TrainingStateError) {
      redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath(`/recruitment/cycles/${cycleId}`);
}
```

- [ ] **Step 2: Surface them on the overview page.** In `src/app/recruitment/cycles/[id]/page.tsx`, for `VOLUNTEER` cycles add a "Training" block: a Link to the training roster (`/recruitment/cycles/${id}/training`) and to the quiz tab (`/recruitment/cycles/${id}/builder/quiz`), a toggle form bound to `setTrainingCycleAction.bind(null, id, !cycle.isTermTraining)` showing "Use as this term's training" / "Stop using as training", and a small settings form for `quizPassPercent` / `quizMaxAttempts` bound to `updateQuizSettingsAction.bind(null, id)`. Import the two actions. Example block (place after the existing button row):

```tsx
{cycle.track === "VOLUNTEER" && (
  <div className="rounded border p-4 text-sm space-y-3">
    <p className="font-medium">Training</p>
    <div className="flex gap-3">
      <Link href={`/recruitment/cycles/${id}/builder/quiz`} className="rounded-md border px-3 py-1.5">Edit quiz</Link>
      <Link href={`/recruitment/cycles/${id}/training`} className="rounded-md border px-3 py-1.5">Training roster</Link>
    </div>
    <form action={setTrainingCycleAction.bind(null, id, !cycle.isTermTraining)}>
      <button className="underline">{cycle.isTermTraining ? "Stop using as this term's training" : "Use as this term's training"}</button>
    </form>
    <form action={updateQuizSettingsAction.bind(null, id)} className="flex items-end gap-3">
      <label className="flex flex-col">Pass %<input name="quizPassPercent" type="number" min={0} max={100} defaultValue={cycle.quizPassPercent} className="w-20 rounded border px-2 py-1" /></label>
      <label className="flex flex-col">Max attempts<input name="quizMaxAttempts" type="number" min={1} defaultValue={cycle.quizMaxAttempts} className="w-20 rounded border px-2 py-1" /></label>
      <button className="rounded-md border px-3 py-1.5">Save quiz settings</button>
    </form>
  </div>
)}
```

Import `setTrainingCycleAction`, `updateQuizSettingsAction` from `../../actions`.

- [ ] **Step 3: Typecheck.** `npm run typecheck`. Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/app/recruitment/cycles/[id]/page.tsx src/app/recruitment/actions.ts
git commit -m "feat(recruitment): designate training cycle and edit quiz settings from overview"
```

---

## Task 11: Director/SRR training roster page

**Files:**
- Modify: `src/modules/recruitment/services/training.ts` (add `listTrainingRoster`)
- Create: `src/app/recruitment/cycles/[id]/training/page.tsx`
- Create: `src/app/recruitment/cycles/[id]/training/actions.ts`
- Test: `src/modules/recruitment/services/training.test.ts` (append a roster test)

- [ ] **Step 1: Write the failing roster test.** Append to `src/modules/recruitment/services/training.test.ts`:

```ts
import { listTrainingRoster } from "./training";

it("listTrainingRoster lists in-scope active volunteers with cert + training state", async () => {
  const { term, srr, vol, c1, dept } = await seedMember();
  await prisma.hipaaCertificate.create({ data: { personId: vol.id, fileName: "c.pdf", storedName: "c.pdf", size: 1, mimeType: "application/pdf", completionDate: new Date() } });
  const rows = await listTrainingRoster(c1.id, srr.id);
  const row = rows.find((r) => r.personId === vol.id)!;
  expect(row.departmentCode).toBe(dept.code);
  expect(row.trainingState).toBe("PENDING");
  expect(row.overallClearance).toBe("NOT_CLEARED"); // cert valid but training pending
});
```

- [ ] **Step 2: Run it to verify failure.** `npx vitest run src/modules/recruitment/services/training.test.ts`. Expected: FAIL (`listTrainingRoster` not exported).

- [ ] **Step 3: Implement `listTrainingRoster`.** Add to `training.ts` (import `complianceStatus`, `overallClearance`, and types from rules):

```ts
import { complianceStatus, overallClearance } from "@/platform/compliance/rules";
import type { OverallClearance } from "@/platform/compliance/rules";

export type TrainingRosterRow = {
  personId: string;
  name: string;
  departmentCode: string;
  certStatus: ReturnType<typeof complianceStatus>;
  trainingState: TrainingState;
  locked: boolean;
  overallClearance: OverallClearance;
};

/** The designated cycle's training roster: in-scope active volunteer memberships
 *  in the cycle's term, each with cert status and training state. Director-scoped
 *  or review_all. Throws TrainingStateError if the cycle is not the designated
 *  training cycle for its term. */
export async function listTrainingRoster(cycleId: string, viewerId: string): Promise<TrainingRosterRow[]> {
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new TrainingStateError("Cycle not found.");
  if (!cycle.isTermTraining) throw new TrainingStateError("This cycle is not the term's training cycle.");

  const term = await prisma.term.findUniqueOrThrow({ where: { id: cycle.termId } });
  const scope = await reviewScope(viewerId);

  const memberships = await prisma.termMembership.findMany({
    where: {
      termId: cycle.termId, kind: "VOLUNTEER", status: "ACTIVE",
      ...(scope.all ? {} : { department: { code: { in: scope.departmentCodes } } }),
    },
    include: {
      department: { select: { code: true } },
      person: { select: { id: true, name: true, hipaaCertificates: { orderBy: { uploadedAt: "desc" }, take: 1 } } },
    },
  });

  const training = new Map(
    (await prisma.volunteerTraining.findMany({ where: { termId: cycle.termId } })).map((t) => [t.personId, t])
  );

  return memberships.map((m) => {
    const cert = m.person.hipaaCertificates[0] ?? null;
    const certStatus = complianceStatus(cert ? { completionDate: cert.completionDate } : null, term.endDate);
    const row = training.get(m.person.id);
    const trainingState: TrainingState = row?.status === "COMPLETE" ? "COMPLETE" : "PENDING";
    return {
      personId: m.person.id, name: m.person.name, departmentCode: m.department.code,
      certStatus, trainingState, locked: row?.locked ?? false,
      overallClearance: overallClearance(certStatus, trainingState),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run it to verify pass.** `npx vitest run src/modules/recruitment/services/training.test.ts`. Expected: PASS.

- [ ] **Step 5: Create the roster actions.** Create `src/app/recruitment/cycles/[id]/training/actions.ts`:

```ts
"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { recordAttendance, resetTraining, getTrainingCycleForTerm, TrainingStateError } from "@/modules/recruitment/services/training";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import { prisma } from "@/platform/db";

function bounce(cycleId: string, params: { msg?: string; err?: string }) {
  const q = new URLSearchParams();
  if (params.msg) q.set("msg", params.msg);
  if (params.err) q.set("err", params.err);
  return `/recruitment/cycles/${cycleId}/training?${q.toString()}`;
}

async function termOfCycle(cycleId: string): Promise<string> {
  const c = await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycleId }, select: { termId: true } });
  return c.termId;
}

export async function recordAttendanceAction(cycleId: string, personId: string) {
  const person = await requirePersonSession();
  try {
    await recordAttendance(personId, await termOfCycle(cycleId), person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof TrainingStateError) redirect(bounce(cycleId, { err: (err as Error).message }));
    throw err;
  }
  redirect(bounce(cycleId, { msg: "Attendance recorded." }));
}

export async function resetTrainingAction(cycleId: string, personId: string) {
  const person = await requirePersonSession();
  try {
    await resetTraining(personId, await termOfCycle(cycleId), person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof TrainingStateError) redirect(bounce(cycleId, { err: (err as Error).message }));
    throw err;
  }
  redirect(bounce(cycleId, { msg: "Training reset." }));
}
```

(`getTrainingCycleForTerm` import is unused here; drop it if lint flags it. Keep the import list minimal.)

- [ ] **Step 6: Create the roster page.** Create `src/app/recruitment/cycles/[id]/training/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listTrainingRoster, TrainingStateError } from "@/modules/recruitment/services/training";
import { recordAttendanceAction, resetTrainingAction } from "./actions";

export default async function TrainingRosterPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const viewer = await requirePersonSession();
  const cycle = await getCycle(id);
  if (!cycle) notFound();

  let rows;
  try {
    rows = await listTrainingRoster(id, viewer.personId);
  } catch (e) {
    if (e instanceof TrainingStateError) {
      return <div className="max-w-2xl"><h1 className="text-2xl font-semibold">Training: {cycle.title}</h1><p className="mt-3 text-sm text-slate-500">{e.message} Set this cycle as the term training cycle from the overview.</p></div>;
    }
    throw e;
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Training: {cycle.title}</h1>
      {err && <p role="alert" className="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
      {msg && <p className="mt-3 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">{msg}</p>}
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th className="py-2">Volunteer</th><th>Dept</th><th>Cert</th><th>Training</th><th>Overall</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.personId}-${r.departmentCode}`} className="border-t">
              <td className="py-2">{r.name}</td>
              <td>{r.departmentCode}</td>
              <td>{r.certStatus}</td>
              <td>{r.trainingState}{r.locked ? " (locked)" : ""}</td>
              <td>{r.overallClearance}</td>
              <td className="space-x-2">
                {r.trainingState !== "COMPLETE" && <form className="inline" action={recordAttendanceAction.bind(null, id, r.personId)}><button className="text-xs underline">Record attendance</button></form>}
                {r.locked && <form className="inline" action={resetTrainingAction.bind(null, id, r.personId)}><button className="text-xs underline">Reset</button></form>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="py-6 text-slate-500">No active volunteers in scope.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 7: Typecheck.** `npm run typecheck`. Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/modules/recruitment/services/training.ts src/modules/recruitment/services/training.test.ts src/app/recruitment/cycles/[id]/training
git commit -m "feat(recruitment): training roster with attendance + reset controls"
```

---

## Task 12: Volunteer self-serve /training page + My Info card

**Files:**
- Create: `src/app/training/page.tsx`
- Create: `src/app/training/actions.ts`
- Modify: `src/app/my-info/page.tsx` (add a training/clearance card linking to `/training`)

- [ ] **Step 1: Create the self-serve action.** Create `src/app/training/actions.ts`:

```ts
"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { submitQuiz, TrainingStateError, QuizLockedError } from "@/modules/recruitment/services/training";

export async function submitQuizAction(formData: FormData) {
  const person = await requirePersonSession();

  // Collect answers: every form field named "q:<key>" carries that question's answer.
  const answers: Record<string, string> = {};
  for (const [name, value] of formData.entries()) {
    if (name.startsWith("q:")) answers[name.slice(2)] = String(value);
  }
  const intake = {
    subcommitteeInterest: (formData.get("subcommitteeInterest") as string) || null,
    additionalShiftAvailability: (formData.get("additionalShiftAvailability") as string) || null,
    minShiftsWanted: (formData.get("minShiftsWanted") as string) || null,
    feedback: (formData.get("feedback") as string) || null,
  };

  try {
    const result = await submitQuiz(person.personId, { answers, intake });
    redirect(`/training?${new URLSearchParams(result.passed ? { passed: "1" } : { score: String(result.percent) }).toString()}`);
  } catch (err) {
    if (err instanceof QuizLockedError) redirect(`/training?err=${encodeURIComponent(err.message)}`);
    if (err instanceof TrainingStateError) redirect(`/training?err=${encodeURIComponent(err.message)}`);
    throw err;
  }
}
```

- [ ] **Step 2: Create the page.** Create `src/app/training/page.tsx`. It calls `getMyTraining(person.personId)` and renders one of: no-cycle notice, complete state with editable intake, locked state, or the quiz + intake form. Skeleton:

```tsx
import { requirePersonSession } from "@/platform/auth/session";
import { AppShell } from "@/platform/ui/app-shell";
import { PageHeader } from "@/platform/ui/page-header";
import { getMyTraining } from "@/modules/recruitment/services/training";
import { submitQuizAction } from "./actions";

export default async function TrainingPage({ searchParams }: { searchParams: Promise<{ passed?: string; score?: string; err?: string }> }) {
  const person = await requirePersonSession();
  const sp = await searchParams;
  const my = await getMyTraining(person.personId);

  return (
    <AppShell userName={person.name} termLabel={my.term.name}>
      <PageHeader title="Volunteer Training" description="Complete training to be cleared for the term." />
      <div className="mt-6 max-w-2xl space-y-4 text-sm">
        {sp.err && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-700">{sp.err}</p>}
        {sp.passed && <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-green-800">You passed. Training is complete.</p>}
        {sp.score && !sp.passed && <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">You scored {sp.score}%. Try again.</p>}

        {!my.cycle && <p className="text-slate-500">Training is not open yet for this term.</p>}

        {my.cycle && my.state === "COMPLETE" && (
          <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-green-800">Training complete{my.completedVia ? ` (via ${my.completedVia.toLowerCase()})` : ""}. You are cleared on the training requirement.</p>
        )}

        {my.cycle && my.state !== "COMPLETE" && my.locked && (
          <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-700">Your quiz is locked after {my.maxAttempts} attempts. Contact your director to reset it.</p>
        )}

        {my.cycle && my.state !== "COMPLETE" && !my.locked && (
          <form action={submitQuizAction} className="space-y-5">
            <p className="text-slate-500">If you attended the live session, your director will mark your attendance. Otherwise, complete this makeup quiz (need {my.passPercent}%, {my.maxAttempts - my.attemptsUsed} attempt(s) left).</p>
            {my.questions.map((q) => (
              <fieldset key={q.key} className="space-y-1">
                <legend className="font-medium">{q.label}</legend>
                {q.options.map((o) => (
                  <label key={o.value} className="flex items-center gap-2"><input type="radio" name={`q:${q.key}`} value={o.value} required /> {o.label}</label>
                ))}
              </fieldset>
            ))}
            <div className="space-y-2 border-t pt-4">
              <p className="font-medium">A few quick questions</p>
              <input name="subcommitteeInterest" placeholder="Subcommittee interest" className="w-full rounded border px-2 py-1" />
              <input name="minShiftsWanted" placeholder="Minimum shifts wanted" className="w-full rounded border px-2 py-1" />
              <input name="additionalShiftAvailability" placeholder="Additional shift availability" className="w-full rounded border px-2 py-1" />
              <textarea name="feedback" placeholder="Feedback or questions" className="w-full rounded border px-2 py-1" />
            </div>
            <button className="rounded-md bg-slate-900 px-3 py-1.5 text-white">Submit quiz</button>
          </form>
        )}
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 3: Add a My Info training card.** In `src/app/my-info/page.tsx`, after computing `status` (near line 163), resolve the training state and overall clearance for the active term and add a "Clearance" section. Import at top:

```ts
import { resolveTrainingState } from "@/modules/recruitment/services/training";
import { overallClearance } from "@/platform/compliance/rules";
import Link from "next/link";
```

Compute after `status`:

```ts
  const trainingState = activeTerm ? await resolveTrainingState(person.personId, activeTerm.id) : "PENDING";
  const clearance = overallClearance(status, trainingState);
```

Add a section in the returned JSX (after the HIPAA section):

```tsx
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">Clearance</h2>
          <div className="rounded border p-4 text-sm space-y-1">
            <p>HIPAA certificate: <span className="font-medium">{status}</span></p>
            <p>Training: <span className="font-medium">{trainingState}</span></p>
            <p>Overall: <span className="font-medium">{clearance}</span></p>
            {trainingState !== "COMPLETE" && <Link href="/training" className="text-blue-700 underline">Complete your training</Link>}
          </div>
        </section>
```

- [ ] **Step 4: Typecheck.** `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/app/training src/app/my-info/page.tsx
git commit -m "feat(recruitment): volunteer self-serve training page and My Info clearance card"
```

---

## Task 13: End-to-end (Playwright)

**Files:**
- Create: `e2e/recruitment-training.spec.ts`

- [ ] **Step 1: Inspect an existing e2e for the sign-in helper and seeding pattern.** Run `ls e2e` and read one recruitment e2e (for example `e2e/recruitment-*.spec.ts`) to reuse its auth/storage-state and any DB seeding utility. Match its setup exactly (how it signs in as `j.carney@yale.edu`, how it creates a term/cycle, whether it seeds via a script or the UI).

- [ ] **Step 2: Write the spec.** Create `e2e/recruitment-training.spec.ts` following that pattern. The flow:

```
1. Sign in as j.carney@yale.edu (SRR / manage_cycles + review_all).
2. Create or open a VOLUNTEER cycle in the active term.
3. Author a 2-question quiz (Training quiz tab): both SINGLE_SELECT with a correct value. Set pass % = 100, max attempts = 3.
4. Designate the cycle as the term's training cycle (overview toggle).
5. Ensure two active VOLUNTEER memberships exist in the term with valid HIPAA certs (seed via the same utility other recruitment e2es use, or promote two applicants through the existing flow).
6. As volunteer A: visit /training, submit the quiz with a wrong answer (fails), then submit again all-correct (passes). Assert /training shows "Training complete" and /my-info Clearance shows Overall: CLEARED.
7. As SRR: open the cycle training roster, record attendance for volunteer B. Assert volunteer B's row reads Training COMPLETE and Overall CLEARED without taking the quiz.
```

Keep assertions on visible text (`getByText(/Training complete/i)`, `getByText(/CLEARED/)`). Use the project's existing role/session switching utility for the two volunteer identities; if the harness only supports the SRR identity, assert the volunteer-facing transitions via the roster and compliance views instead, and cover the quiz pass/fail/lock transitions through the Task 6 service tests (already done).

- [ ] **Step 3: Run it.** `npm run e2e -- recruitment-training`. Expected: PASS. If the e2e harness cannot switch to non-SRR identities, reduce the volunteer-side assertions to what the SRR can observe (roster + compliance) and note it in the commit message.

- [ ] **Step 4: Commit.**

```bash
git add e2e/recruitment-training.spec.ts
git commit -m "test(recruitment): e2e training quiz pass and attendance clear"
```

---

## Task 14: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit + integration suite.** `npm test`. Expected: all green. Investigate any failure; the only known-flaky tests are upload-boundary/rbac/compliance under parallel DB contention (re-run the named file in isolation to confirm it passes alone).

- [ ] **Step 2: Typecheck.** `npm run typecheck`. Expected: no errors. If a stale `.next` type error appears, `rm -rf .next` and re-run.

- [ ] **Step 3: Lint (includes the module-boundary rule).** `npm run lint`. Expected: no errors. Fix any unused-import/var nits in the new files. Confirm no file under `src/modules/recruitment` imports `src/modules/volunteers` and vice versa.

- [ ] **Step 4: Build.** `npm run build`. Expected: success (the new `/training` and roster routes compile).

- [ ] **Step 5: No em-dash sweep.** Run `grep -rn "—" src/app/training src/app/recruitment/cycles/[id]/training src/app/recruitment/cycles/[id]/builder/quiz src/modules/recruitment/services/training.ts` and confirm zero hits in shipped strings/comments.

- [ ] **Step 6: Commit any fixes, then hand off.**

```bash
git add -A
git commit -m "chore(recruitment): plan 14 verification fixes" || echo "nothing to commit"
```

Then use **superpowers:finishing-a-development-branch**.

---

## Self-Review (filled in by the plan author)

**Spec coverage:**
- §2.1 cycle fields (isTermTraining, quizPassPercent, quizMaxAttempts) -> Task 1 Step 2; partial unique -> Task 1 Step 7.
- §2.2 FormSection.purpose -> Task 1 Step 3; QUIZ excluded from public form -> Task 7 Steps 5 to 7.
- §2.3 FormField.correctValue -> Task 1 Step 3 + Task 7.
- §2.4 VolunteerTraining (person, term) -> Task 1 Step 4.
- §2.5 QuizAttempt -> Task 1 Step 4.
- §2.6 resetDb -> Task 1 Step 8.
- §3 quiz authoring -> Tasks 9, 10.
- §4.1 attendance path -> Task 5.
- §4.2 quiz path (lazy row, save intake, grade, complete/lock) -> Task 6.
- §4.3 overallClearance + training-state resolution -> Tasks 3, 8.
- §5 grading engine + lockResetAt window + reset preserves history -> Tasks 2, 6.
- §6.1 /training self-serve -> Task 12; §6.2 roster -> Task 11; §6.3 compliance read -> Task 8.
- §7 permissions (manage_cycles to author/designate; reviewScope for attendance/reset; session-owns-membership for self-serve) -> Tasks 4, 5, 6, 12.
- §8 typed errors (TrainingAuthError via RecruitmentAuthError, QuizLockedError, TrainingStateError) and module boundary -> Tasks 4 to 6, 8, 14 Step 3. NOTE: the spec names `TrainingAuthError`; this plan reuses the existing `RecruitmentAuthError` for actor-scope failures (the shared recruitment auth error) rather than introducing a near-duplicate class. Both attendance/reset/designate throw `RecruitmentAuthError`; `QuizLockedError` and `TrainingStateError` are new. This is a deliberate simplification, called out here for the reviewer.
- §9 tests (engine unit, service integration, e2e) -> Tasks 2, 3, 4, 5, 6, 7, 8, 11, 13.

**Type consistency:** `TrainingState`/`OverallClearance` defined in Task 3 and reused in Tasks 6, 8, 11. `GradedQuestion`/`gradeQuiz` defined in Task 2, used in Task 6. `completeTraining(db, {personId, termId, cycleId, via, actorId?})` defined in Task 5, reused in Task 6. `resolveTrainingState` defined in Task 5, reused in Task 12. The Prisma compound unique key is `personId_termId` (matches `@@unique([personId, termId])`) everywhere.

**Deviations from spec, surfaced for the reviewer:**
1. `VolunteerTraining` keyed on `(personId, termId)` not `membershipId` (spec was updated to match; more correct for attend-once-per-term and unambiguous quiz state).
2. Actor-scope failures reuse `RecruitmentAuthError` rather than a new `TrainingAuthError` (avoids a duplicate error class; same caller-visible behavior).
