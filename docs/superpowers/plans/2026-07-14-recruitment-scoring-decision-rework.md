# Recruitment Scoring + Decision Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the recruitment volunteer flow into a staged pipeline - committee 1–5 scoring (running average) → lead routes a best-fit department → department interview scoring (1–5) + final decision - retire the categorical `Recommendation` enum, and fix the interview decision-confirmation bug.

**Architecture:** A new application-level `CommitteeScore` (one row per reviewer, averaged) sits before department routing. New `Application.routed*` fields record the committee's best-fit pick. The existing `Interview`/`Evaluation`/`decideInterview` machinery is generalized to numeric 1–5 scoring and made reachable for routed volunteer applications. A new `recruitment.score` permission gates committee scoring, separate from decision/release power. Pipeline stage is derived (a pure `applicationStage()` helper); `Application.status` stays `DRAFT|SUBMITTED`.

**Tech Stack:** Next.js App Router (Server Components + Server Actions), Prisma + Postgres, vitest integration tests against a local throwaway Postgres, the `@/platform/ui` design system.

## Global Constraints

- **Prisma client import:** `import { prisma, isUniqueConstraintError } from "@/platform/db"`. `@/*` → `src/*`.
- **Services are auth-agnostic in how they get the actor:** they take the actor's `personId` as a string param and self-authorize with `can()` / `reviewScope()`. NEVER call `requirePersonSession()` / `redirect()` inside a service - those live only in `"use server"` action files and Server Components.
- **Permission check:** `await can(personId, "recruitment.<perm>")` from `@/platform/rbac/engine`. Wildcard `*` is handled inside `can`.
- **Audit:** `await recordAudit({ actorPersonId, action: "recruitment.<verb>", entityType, entityId, after? })` from `@/platform/audit`. Fire-and-forget; runs after the mutation.
- **Error classes:** `RecruitmentAuthError` + `AcceptanceError` are defined in `services/review.ts`; `InterviewError` in `services/interviews.ts`. New services define their own (`CommitteeScoreError`, `RoutingError`) and import `RecruitmentAuthError` from `./review`.
- **Local test DB ONLY - never Neon.** Repo `.env` points every DB URL at shared Neon; running migrations or vitest against it would wipe production. Use native local Postgres: `postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit`. Prefix every DB command with `TEST_DATABASE_URL`/`DATABASE_URL` set to that URL.
- **Single-test command:** `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run <path>`. Migrate the test DB first after any schema change: `DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx prisma migrate deploy`.
- **Migrations are hand-authored** here (do not rely on `prisma migrate dev`, which folds pre-existing drift). Folder name = `<14-digit-timestamp>_<snake_case>`; pick a timestamp strictly greater than `ls prisma/migrations | sort | tail -1`. Model-add order: `-- CreateTable`, `-- CreateIndex` (plain `@@index` → `..._idx`, `@@unique` → `..._key`), `-- AddForeignKey` (`ON DELETE <policy> ON UPDATE CASCADE`). After editing `schema.prisma`, run `npx prisma generate`.
- **New Prisma models MUST be added to the TRUNCATE list** in `src/platform/test/db.ts` or rows leak across tests.
- **Every new FK-to-`Person` needs a named `@relation` on BOTH sides** or `prisma validate` fails. Append Person back-relations near the recruitment cluster (schema.prisma ~line 169–180).
- **Tone vocabularies differ:** `Alert` uses `error|success|warning|info`; `Badge` uses `default|brand|success|warning|critical`; `Button` uses `primary|outline|danger|ghost`. Do not cross them (typecheck fails).
- **`redirect()` throws** - place a success `redirect()` AFTER the `try/catch`, never inside `try`.
- **Typecheck:** `npx tsc --noEmit`. Directory paths use the route group `(app)` on disk but not in the URL. Use worktree-rooted absolute paths for edits.

---

## Slice 1 - Foundation

### Task 1: Add the `recruitment.score` permission

**Files:**
- Modify: `src/platform/modules/registry.ts` (recruitment entry, ~lines 134–143)
- Test: `src/platform/modules/registry.test.ts` and/or `src/modules/admin/services/rbac.test.ts` (only if they assert the exact recruitment permission list)

**Interfaces:**
- Produces: the grantable permission string `"recruitment.score"` (auto-appears as a checkbox under Recruitment in `/admin/roles` and is accepted by `saveGrants`, because both read `MODULES[].permissions`).

- [ ] **Step 1: Check for tests that pin the recruitment permission list**

Run: `grep -rn "recruitment.review_all" src/platform/modules src/modules/admin`
If a test asserts the exact array `["recruitment.access", "recruitment.manage_cycles", "recruitment.review_all"]`, note the file; you will update it in Step 4.

- [ ] **Step 2: Add the permission string**

In `src/platform/modules/registry.ts`, change the recruitment entry's `permissions` array:

```ts
    permissions: ["recruitment.access", "recruitment.manage_cycles", "recruitment.review_all", "recruitment.score"],
```

- [ ] **Step 3: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Update any pinned-list test, then run RBAC/registry tests**

If Step 1 found a test asserting the old array, add `"recruitment.score"` to the expected array. Then run:
`TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run src/platform/modules/registry.test.ts src/modules/admin/services/rbac.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/modules/registry.ts src/platform/modules/registry.test.ts src/modules/admin/services/rbac.test.ts
git commit -m "feat(recruitment): add grantable recruitment.score permission"
```

---

### Task 2: Broaden recruitment staff access (committee scorers + department directors)

**Files:**
- Create: `src/app/(app)/recruitment/cycles/access.ts`
- Modify: `src/app/(app)/recruitment/cycles/layout.tsx`
- Modify: `src/app/(app)/recruitment/page.tsx` (the `/recruitment` index - read it first)
- Modify: every staff-only page under `src/app/(app)/recruitment/cycles/[id]/**` EXCEPT `applicants/**` (re-add their `recruitment.access` gate)

**Interfaces:**
- Produces: `requireRecruitmentStaff()` - admits anyone with `recruitment.access` OR `recruitment.score` OR a non-empty `reviewScope` (SRR or a directed department); redirects others to `/no-access`.

**Why:** The current `cycles/layout.tsx` gates the whole subtree on `recruitment.access`, so committee scorers and department directors can't reach the applicants surface. Broaden the layout to admit them, and re-gate the staff-only sibling pages so they keep their `recruitment.access`-only protection (the "layout admits, pages enforce" pattern). The `applicants/**` pages self-authorize via `reviewScope`/`canView`, so they are the intentional exception.

- [ ] **Step 1: Create the shared admit helper**

Create `src/app/(app)/recruitment/cycles/access.ts`:

```ts
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { reviewScope } from "@/modules/recruitment/services/review";

/**
 * Recruitment staff-surface gate. Admits anyone with ANY recruitment
 * capability: module access, committee scoring, or a review scope (SRR /
 * review_all or an active-term department director). Sub-permissions are still
 * enforced per-page and per-action; this only decides who may enter the subtree.
 */
export async function requireRecruitmentStaff() {
  const person = await requirePersonSession();
  const [access, score, scope] = await Promise.all([
    can(person.personId, "recruitment.access"),
    can(person.personId, "recruitment.score"),
    reviewScope(person.personId),
  ]);
  if (access || score || scope.all || scope.departmentCodes.length > 0) return person;
  redirect("/no-access");
}
```

- [ ] **Step 2: Broaden the cycles layout**

Replace the body of `src/app/(app)/recruitment/cycles/layout.tsx`:

```tsx
import type { ReactNode } from "react";
import { requireRecruitmentStaff } from "./access";

/**
 * Recruitment-staff gate for the whole cycle-management subtree
 * (`/recruitment/cycles/**`). Admits module-access staff, committee scorers
 * (recruitment.score) and department directors; each staff-only page re-gates
 * itself on recruitment.access, and the applicants surface self-authorizes by
 * review scope.
 */
export default async function RecruitmentCyclesLayout({ children }: { children: ReactNode }) {
  await requireRecruitmentStaff();
  return <>{children}</>;
}
```

- [ ] **Step 3: Enumerate the staff-only cycle pages**

Run: `find "src/app/(app)/recruitment/cycles/[id]" -name page.tsx`
Every result EXCEPT `.../applicants/page.tsx` and `.../applicants/[applicationId]/page.tsx` is staff-only and must be re-gated in Step 4. Also open `src/app/(app)/recruitment/page.tsx` (the index above this layout).

- [ ] **Step 4: Re-gate the staff-only pages**

At the top of each staff-only page's default export (right after `const { ... } = await params;`), add:

```tsx
import { requirePermission } from "@/platform/auth/session";
// ...inside the component, before any data fetching:
await requirePermission("recruitment.access");
```

For `src/app/(app)/recruitment/page.tsx`: if it currently calls `requireModuleAccess("recruitment")` or `requirePermission("recruitment.access")`, leave it - the index stays `recruitment.access`-only (it is above the broadened layout). Do NOT add `requirePermission` to `applicants/page.tsx` or `applicants/[applicationId]/page.tsx`.

- [ ] **Step 5: Verify typecheck + existing recruitment page smoke**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/recruitment"
git commit -m "feat(recruitment): admit committee scorers and directors to cycle surfaces; re-gate staff pages"
```

---

### Task 3: Convert interview evaluations to numeric 1–5 (retire `Recommendation`)

**Files:**
- Create: `src/modules/recruitment/engine/scoring.ts`
- Create: `prisma/migrations/<ts>_evaluation_numeric_score/migration.sql`
- Modify: `prisma/schema.prisma` (Evaluation model + drop `Recommendation` enum)
- Modify: `src/modules/recruitment/services/evaluations.ts`
- Modify: `src/modules/recruitment/engine/interview-eval.ts`
- Modify: `src/app/(app)/recruitment/interviews/actions.ts` (`submitEvaluationAction`)
- Modify: `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx` (Evaluations card + panelist Select)
- Test: `src/modules/recruitment/engine/scoring.test.ts` (new), `src/modules/recruitment/services/evaluations.test.ts` (update)

**Interfaces:**
- Produces: `scoreAverage(scores: number[]): { average: number | null; count: number }`.
- Produces: `evaluationSummary(evaluations: { score: number }[]): { average: number | null; count: number }`.
- Produces: `submitEvaluation(interviewId, evaluatorId, score: number, comments: string | null): Promise<Evaluation>`.

- [ ] **Step 1: Write the failing pure-helper test**

Create `src/modules/recruitment/engine/scoring.test.ts`:

```ts
import { expect, it } from "vitest";
import { scoreAverage } from "./scoring";

it("returns null average and 0 count for no scores", () => {
  expect(scoreAverage([])).toEqual({ average: null, count: 0 });
});

it("averages 1-5 scores", () => {
  expect(scoreAverage([5, 4, 3])).toEqual({ average: 4, count: 3 });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run src/modules/recruitment/engine/scoring.test.ts`
Expected: FAIL ("Cannot find module './scoring'").

- [ ] **Step 3: Implement the pure helper**

Create `src/modules/recruitment/engine/scoring.ts`:

```ts
/** Mean of a set of 1-5 scores. `average` is null when there are no scores. */
export function scoreAverage(scores: number[]): { average: number | null; count: number } {
  if (scores.length === 0) return { average: null, count: 0 };
  const sum = scores.reduce((a, b) => a + b, 0);
  return { average: sum / scores.length, count: scores.length };
}
```

- [ ] **Step 4: Run the helper test to green**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run src/modules/recruitment/engine/scoring.test.ts`
Expected: PASS.

- [ ] **Step 5: Edit the schema - Evaluation numeric + drop the enum**

In `prisma/schema.prisma`, change the `Evaluation` model field:

```prisma
  // was: recommendation Recommendation
  score          Int
```

Delete the entire `Recommendation` enum block:

```prisma
enum Recommendation {
  STRONG_YES
  YES
  MAYBE
  NO
}
```

- [ ] **Step 6: Hand-author the data-preserving migration**

Pick a timestamp `> ls prisma/migrations | sort | tail -1` (e.g. `20260714100000`). Create `prisma/migrations/20260714100000_evaluation_numeric_score/migration.sql`:

```sql
-- Convert Evaluation.recommendation (enum) -> score (1-5 int), preserving data.
ALTER TABLE "Evaluation" ADD COLUMN "score" INTEGER;
UPDATE "Evaluation" SET "score" = CASE "recommendation"
  WHEN 'STRONG_YES' THEN 5
  WHEN 'YES' THEN 4
  WHEN 'MAYBE' THEN 3
  WHEN 'NO' THEN 1
END;
ALTER TABLE "Evaluation" ALTER COLUMN "score" SET NOT NULL;
ALTER TABLE "Evaluation" DROP COLUMN "recommendation";
DROP TYPE "Recommendation";
```

- [ ] **Step 7: Apply the migration + regenerate the client**

Run:
```bash
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx prisma migrate deploy
npx prisma generate
```
Expected: migration applied; client generated. (If `prisma migrate status` reports drift, re-check that the SQL matches the schema edit exactly.)

- [ ] **Step 8: Update the evaluation service (numeric) + its test**

In `src/modules/recruitment/services/evaluations.ts`, replace the file body:

```ts
import type { Evaluation } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";

export async function submitEvaluation(
  interviewId: string,
  evaluatorId: string,
  score: number,
  comments: string | null,
): Promise<Evaluation> {
  const panelist = await prisma.interviewPanelist.findUnique({ where: { interviewId_personId: { interviewId, personId: evaluatorId } } });
  if (!panelist) throw new RecruitmentAuthError("You are not on this interview's panel.");
  const ev = await prisma.evaluation.upsert({
    where: { interviewId_evaluatorId: { interviewId, evaluatorId } },
    create: { interviewId, evaluatorId, score, comments },
    update: { score, comments },
  });
  await recordAudit({ actorPersonId: evaluatorId, action: "recruitment.evaluation_submit", entityType: "Evaluation", entityId: ev.id });
  return ev;
}
```

In `src/modules/recruitment/services/evaluations.test.ts`, replace the two `submitEvaluation(...)` calls and the assertion to use numeric scores:

```ts
it("lets a panelist submit and update their evaluation (upsert)", async () => {
  const { iv, panelist } = await seedInterview();
  await submitEvaluation(iv.id, panelist.id, 4, "solid");
  await submitEvaluation(iv.id, panelist.id, 5, "even better");
  const evals = await prisma.evaluation.findMany({ where: { interviewId: iv.id } });
  expect(evals).toHaveLength(1);
  expect(evals[0].score).toBe(5);
  expect(evals[0].comments).toBe("even better");
});

it("rejects an evaluation from a non-panelist", async () => {
  const { iv, outsider } = await seedInterview();
  await expect(submitEvaluation(iv.id, outsider.id, 4, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
});
```

- [ ] **Step 9: Update the eval summary engine**

Replace `src/modules/recruitment/engine/interview-eval.ts`:

```ts
import { scoreAverage } from "./scoring";

export function evaluationSummary(
  evaluations: { score: number }[],
): { average: number | null; count: number } {
  return scoreAverage(evaluations.map((e) => e.score));
}

/** Panelist ids who have not submitted an evaluation, preserving input order. */
export function missingPanelists(
  panelistIds: string[],
  evaluations: { evaluatorId: string }[],
): string[] {
  const submitted = new Set(evaluations.map((e) => e.evaluatorId));
  return panelistIds.filter((id) => !submitted.has(id));
}
```

- [ ] **Step 10: Update the evaluation action (numeric validation)**

In `src/app/(app)/recruitment/interviews/actions.ts`: remove `import type { Recommendation } from "@prisma/client";` and replace `submitEvaluationAction`:

```ts
export async function submitEvaluationAction(interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const score = Number(formData.get("score"));
  const comments = String(formData.get("comments") ?? "").trim() || null;
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    redirect(detail(interviewId, "Score must be 1 to 5."));
  }
  try { await submitEvaluation(interviewId, person.personId, score, comments); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(interviewId));
}
```

- [ ] **Step 11: Update the interview page eval UI**

In `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx`:

Replace `const RECS = ["STRONG_YES", "YES", "MAYBE", "NO"];` with:

```tsx
const SCORES = [1, 2, 3, 4, 5];
```

Replace the Evaluations card header + summary line:

```tsx
        <SectionHeader>Evaluations ({summary.count})</SectionHeader>
        <p className="mt-1 text-xs text-subtle-foreground">
          Average {summary.average != null ? summary.average.toFixed(1) : "-"}
        </p>
```

Replace the per-evaluation list item body:

```tsx
                <strong className="text-foreground">{e.evaluator.name}</strong>: {e.score}/5
                {e.comments ? ` (${e.comments})` : ""}
```

Replace the panelist "Your evaluation" `<Select>` block:

```tsx
                <Select name="score" required defaultValue={myEval?.score != null ? String(myEval.score) : ""}>
                  <option value="" disabled>
                    Select…
                  </option>
                  {SCORES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
```

(Change the surrounding `<Field label="Recommendation">` to `<Field label="Score (1-5)">`.)

- [ ] **Step 12: Run the evaluation + engine tests + typecheck**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run src/modules/recruitment/engine/scoring.test.ts src/modules/recruitment/engine/interview-eval.test.ts src/modules/recruitment/services/evaluations.test.ts
npx tsc --noEmit
```
Expected: tests PASS; no type errors. (If `interview-eval.test.ts` asserts the old `{strongYes,...}` shape, update it to `{ average, count }`.)

- [ ] **Step 13: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/modules/recruitment "src/app/(app)/recruitment/interviews"
git commit -m "feat(recruitment): numeric 1-5 interview evaluations, retire Recommendation enum"
```

---

## Slice 2 - Committee scoring

### Task 4: `CommitteeScore` model + migration

**Files:**
- Modify: `prisma/schema.prisma` (new `CommitteeScore` model + `Application`/`Person` back-relations)
- Create: `prisma/migrations/<ts>_committee_score/migration.sql`
- Modify: `src/platform/test/db.ts` (TRUNCATE list)

**Interfaces:**
- Produces: Prisma model `CommitteeScore { id, applicationId, scorerId, score Int, comments String?, createdAt, updatedAt }`, unique `(applicationId, scorerId)`.

- [ ] **Step 1: Add the model + relations to the schema**

In `prisma/schema.prisma`, add after the `Acceptance` model:

```prisma
model CommitteeScore {
  id            String   @id @default(cuid())
  applicationId String
  scorerId      String
  score         Int
  comments      String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  application Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  scorer      Person      @relation("committeeScoreScorer", fields: [scorerId], references: [id], onDelete: Cascade)

  @@unique([applicationId, scorerId])
  @@index([applicationId])
}
```

Add the back-relation to `Application` (in its relation block, next to `acceptances`/`interviews`):

```prisma
  committeeScores CommitteeScore[]
```

Add the back-relation to `Person` (near the recruitment cluster at ~line 169–180):

```prisma
  committeeScores           CommitteeScore[]     @relation("committeeScoreScorer")
```

- [ ] **Step 2: Validate the schema**

Run: `npx prisma validate`
Expected: "The schema is valid".

- [ ] **Step 3: Hand-author the migration**

Pick a timestamp `> 20260714100000` (e.g. `20260714110000`). Create `prisma/migrations/20260714110000_committee_score/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "CommitteeScore" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "scorerId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "comments" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommitteeScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommitteeScore_applicationId_scorerId_key" ON "CommitteeScore"("applicationId", "scorerId");

-- CreateIndex
CREATE INDEX "CommitteeScore_applicationId_idx" ON "CommitteeScore"("applicationId");

-- AddForeignKey
ALTER TABLE "CommitteeScore" ADD CONSTRAINT "CommitteeScore_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommitteeScore" ADD CONSTRAINT "CommitteeScore_scorerId_fkey" FOREIGN KEY ("scorerId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 4: Add the table to the test TRUNCATE list**

In `src/platform/test/db.ts`, add `"CommitteeScore"` to the `TRUNCATE` list (place it before `"Application"`, since CASCADE handles order anyway):

```ts
    `TRUNCATE "EhsTrainingDepartment", ... "Evaluation", "InterviewPanelist", "Interview", "OnboardingContract", "Acceptance", "CommitteeScore", "Application", "Applicant", ...
```

- [ ] **Step 5: Apply + generate**

Run:
```bash
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx prisma migrate deploy
npx prisma generate
```
Expected: migration applied; client generated.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/platform/test/db.ts
git commit -m "feat(recruitment): add CommitteeScore model"
```

---

### Task 5: `committee-scoring.ts` service

**Files:**
- Create: `src/modules/recruitment/services/committee-scoring.ts`
- Test: `src/modules/recruitment/services/committee-scoring.test.ts`

**Interfaces:**
- Consumes: `scoreAverage` from `../engine/scoring`; `RecruitmentAuthError` from `./review`.
- Produces: `submitCommitteeScore(applicationId, scorerId, score, comments): Promise<CommitteeScore>`; `committeeScoreSummary(applicationId): Promise<{ average: number | null; count: number; scores: CommitteeScore[] }>`; `class CommitteeScoreError`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/recruitment/services/committee-scoring.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { submitCommitteeScore, committeeScoreSummary, CommitteeScoreError } from "./committee-scoring";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const educ = await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  const scorer = await prisma.person.create({ data: { name: "Scorer", status: "ACTIVE" } });
  const scorer2 = await prisma.person.create({ data: { name: "Scorer2", status: "ACTIVE" } });
  const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Committee", grants: { create: [{ permission: "recruitment.score" }] } } });
  await prisma.roleAssignment.create({ data: { personId: scorer.id, roleId: role.id } });
  await prisma.roleAssignment.create({ data: { personId: scorer2.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC"], createdById: scorer.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email: "a@y.edu", emailLower: "a@y.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  return { scorer, scorer2, outsider, application };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("submitCommitteeScore", () => {
  it("upserts one score per reviewer and audits", async () => {
    const { scorer, application } = await seed();
    await submitCommitteeScore(application.id, scorer.id, 3, "ok");
    await submitCommitteeScore(application.id, scorer.id, 5, "changed my mind");
    const rows = await prisma.committeeScore.findMany({ where: { applicationId: application.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(5);
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.committee_score" } });
    expect(audit).not.toBeNull();
  });

  it("rejects a non-scorer", async () => {
    const { outsider, application } = await seed();
    await expect(submitCommitteeScore(application.id, outsider.id, 4, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("rejects an out-of-range score", async () => {
    const { scorer, application } = await seed();
    await expect(submitCommitteeScore(application.id, scorer.id, 6, null)).rejects.toBeInstanceOf(CommitteeScoreError);
  });
});

describe("committeeScoreSummary", () => {
  it("averages every reviewer's score", async () => {
    const { scorer, scorer2, application } = await seed();
    await submitCommitteeScore(application.id, scorer.id, 4, null);
    await submitCommitteeScore(application.id, scorer2.id, 2, null);
    const summary = await committeeScoreSummary(application.id);
    expect(summary.count).toBe(2);
    expect(summary.average).toBe(3);
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run src/modules/recruitment/services/committee-scoring.test.ts`
Expected: FAIL ("Cannot find module './committee-scoring'").

- [ ] **Step 3: Implement the service**

Create `src/modules/recruitment/services/committee-scoring.ts`:

```ts
import type { CommitteeScore } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";
import { scoreAverage } from "../engine/scoring";

export class CommitteeScoreError extends Error {
  constructor(message: string) { super(message); this.name = "CommitteeScoreError"; }
}

/** A committee reviewer's 1-5 score for an application (one per reviewer). */
export async function submitCommitteeScore(
  applicationId: string,
  scorerId: string,
  score: number,
  comments: string | null,
): Promise<CommitteeScore> {
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new CommitteeScoreError("Score must be a whole number from 1 to 5.");
  }
  const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { status: true } });
  if (!app) throw new CommitteeScoreError("Application not found.");
  if (app.status !== "SUBMITTED") throw new CommitteeScoreError("This application hasn't been submitted yet.");
  const authorized = (await can(scorerId, "recruitment.score")) || (await can(scorerId, "recruitment.review_all"));
  if (!authorized) throw new RecruitmentAuthError("You can't score applications.");
  const saved = await prisma.committeeScore.upsert({
    where: { applicationId_scorerId: { applicationId, scorerId } },
    create: { applicationId, scorerId, score, comments },
    update: { score, comments },
  });
  await recordAudit({ actorPersonId: scorerId, action: "recruitment.committee_score", entityType: "CommitteeScore", entityId: saved.id, after: { applicationId, score } });
  return saved;
}

/** Running average + all reviewer scores for an application. */
export async function committeeScoreSummary(
  applicationId: string,
): Promise<{ average: number | null; count: number; scores: CommitteeScore[] }> {
  const scores = await prisma.committeeScore.findMany({ where: { applicationId }, orderBy: { createdAt: "asc" } });
  return { ...scoreAverage(scores.map((s) => s.score)), scores };
}
```

- [ ] **Step 4: Run to green**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run src/modules/recruitment/services/committee-scoring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/committee-scoring.ts src/modules/recruitment/services/committee-scoring.test.ts
git commit -m "feat(recruitment): committee scoring service (1-5, running average)"
```

---

### Task 6: Committee scoring UI + roster average column

**Files:**
- Modify: `src/modules/recruitment/services/review.ts` (`ReviewApplication` type + `listApplicantsForReview` include/see-all)
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts` (new `committeeScoreAction`)
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` (score card)
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx` (Committee avg column)

**Interfaces:**
- Consumes: `submitCommitteeScore`, `committeeScoreSummary`, `CommitteeScoreError`; `scoreAverage`.
- Produces: `committeeScoreAction(cycleId, applicationId, formData)`; `ReviewApplication.committeeScores: { score: number }[]`.

- [ ] **Step 1: Let committee scorers see all applications + include scores**

In `src/modules/recruitment/services/review.ts`, update `ReviewApplication` and `listApplicantsForReview`:

```ts
export type ReviewApplication = Application & {
  applicant: { firstName: string; lastName: string; email: string };
  acceptances: Acceptance[];
  committeeScores: { score: number }[];
};

export async function listApplicantsForReview(cycleId: string, viewerId: string): Promise<ReviewApplication[]> {
  const [scope, managesCycles, canScore] = await Promise.all([
    reviewScope(viewerId),
    can(viewerId, "recruitment.manage_cycles"),
    can(viewerId, "recruitment.score"),
  ]);
  const seeAll = scope.all || managesCycles || canScore;
  const apps = await prisma.application.findMany({
    where: { cycleId, status: "SUBMITTED" },
    include: {
      applicant: { select: { firstName: true, lastName: true, email: true } },
      acceptances: true,
      committeeScores: { select: { score: true } },
    },
    orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
  });
  if (seeAll) return apps;
  const mine = new Set(scope.departmentCodes);
  return apps.filter((a) => a.departmentChoices.some((d) => mine.has(d)));
}
```

(Note: the director filter still uses `departmentChoices` here - Task 7 switches it to routing.)

- [ ] **Step 2: Add the committee-score action**

In `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts`, add the import and a new action:

```ts
import { submitCommitteeScore, CommitteeScoreError } from "@/modules/recruitment/services/committee-scoring";

export async function committeeScoreAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const score = Number(formData.get("score"));
  const comments = String(formData.get("comments") ?? "").trim() || null;
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    redirect(bounce(cycleId, applicationId, "Score must be 1 to 5."));
  }
  try {
    await submitCommitteeScore(applicationId, person.personId, score, comments);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof CommitteeScoreError) redirect(bounce(cycleId, applicationId, err.message));
    throw err;
  }
  revalidatePath(bounce(cycleId, applicationId));
}
```

- [ ] **Step 3: Add the score card to the applicant detail page**

In `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`:

Add imports:
```tsx
import { committeeScoreSummary } from "@/modules/recruitment/services/committee-scoring";
import { committeeScoreAction } from "../actions";
```

After the existing data fetches, add (gate matches the service auth - `review_all` or `recruitment.score`, NOT `manage_cycles`):
```tsx
const canScore = scope.all || (await can(person.personId, "recruitment.score"));
const scoreSummary = canScore ? await committeeScoreSummary(applicationId) : null;
const myScore = scoreSummary?.scores.find((s) => s.scorerId === person.personId) ?? null;
```

Insert a new `<Card>` immediately AFTER the Subcommittee card block and BEFORE the decision/interview branch:
```tsx
{canScore && scoreSummary && (
  <Card>
    <SectionHeader>Committee score</SectionHeader>
    <p className="mt-1 text-xs text-subtle-foreground">
      Average {scoreSummary.average != null ? scoreSummary.average.toFixed(1) : "-"} · {scoreSummary.count} scored
    </p>
    <form action={committeeScoreAction.bind(null, id, applicationId)} className="mt-3 flex flex-wrap items-end gap-3">
      <div className="w-28">
        <Field label="Your score">
          <Select name="score" required defaultValue={myScore ? String(myScore.score) : ""}>
            <option value="" disabled>Select…</option>
            {[1, 2, 3, 4, 5].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="min-w-[12rem] flex-1">
        <Field label="Comments" hint="Optional.">
          <Input name="comments" defaultValue={myScore?.comments ?? ""} />
        </Field>
      </div>
      <SubmitButton size="sm" pendingLabel="Saving…">{myScore ? "Update score" : "Submit score"}</SubmitButton>
    </form>
  </Card>
)}
```

- [ ] **Step 4: Add the Committee avg column to the roster**

In `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx`:

Add import:
```tsx
import { scoreAverage } from "@/modules/recruitment/engine/scoring";
```

Add a `<TH>` after `Type`:
```tsx
            <TH>Committee avg</TH>
```

Inside the row map (after the `Type` `<TD>`), add:
```tsx
                <TD className="text-foreground-soft">
                  {(() => {
                    const s = scoreAverage(a.committeeScores.map((c) => c.score));
                    return s.average != null ? `${s.average.toFixed(1)} · ${s.count}` : "-";
                  })()}
                </TD>
```

Update the empty-state `colSpan={5}` to `colSpan={6}`.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Verify in the running app**

Start the app (`/run` skill or `npm run dev`), sign in as a `recruitment.score` holder, open a volunteer cycle's Applicants roster (Committee avg column shows), open an applicant, submit a 1–5 score, confirm the running average updates.

- [ ] **Step 7: Commit**

```bash
git add src/modules/recruitment/services/review.ts "src/app/(app)/recruitment/cycles"
git commit -m "feat(recruitment): committee scoring UI + roster average column"
```

---

## Slice 3 - Routing

### Task 7: `Application` routing fields, migration, stage helper, director visibility

**Files:**
- Modify: `prisma/schema.prisma` (`Application` routing fields + `Person` back-relation)
- Create: `prisma/migrations/<ts>_application_routing/migration.sql`
- Create: `src/modules/recruitment/engine/application-stage.ts`
- Test: `src/modules/recruitment/engine/application-stage.test.ts`
- Modify: `src/modules/recruitment/services/review.ts` (director visibility → routed dept; include interviews)

**Interfaces:**
- Produces: `Application.routedDepartmentCode/routedById/routedAt`.
- Produces: `type ApplicationStage`; `applicationStage(input): ApplicationStage`.

- [ ] **Step 1: Add routing fields to the schema**

In `prisma/schema.prisma`, add to `Application` (scalar block):

```prisma
  routedDepartmentCode String?
  routedById           String?
  routedAt             DateTime?
```

Add to `Application`'s relation block:

```prisma
  routedBy    Person? @relation("applicationRoutedBy", fields: [routedById], references: [id], onDelete: SetNull)
```

Add to `Person` (recruitment cluster):

```prisma
  applicationsRouted        Application[]        @relation("applicationRoutedBy")
```

- [ ] **Step 2: Hand-author the migration**

Pick a timestamp `> 20260714110000` (e.g. `20260714120000`). Create `prisma/migrations/20260714120000_application_routing/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "Application" ADD COLUMN "routedDepartmentCode" TEXT;
ALTER TABLE "Application" ADD COLUMN "routedById" TEXT;
ALTER TABLE "Application" ADD COLUMN "routedAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_routedById_fkey" FOREIGN KEY ("routedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply + generate**

Run:
```bash
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx prisma migrate deploy
npx prisma generate
```

- [ ] **Step 4: Write the failing stage-helper test**

Create `src/modules/recruitment/engine/application-stage.test.ts`:

```ts
import { expect, it } from "vitest";
import { applicationStage } from "./application-stage";

it("is AWAITING_SCORING with no scores, no routing, no interviews", () => {
  expect(applicationStage({ scoreCount: 0, routedDepartmentCode: null, interviews: [] })).toBe("AWAITING_SCORING");
});
it("is SCORING once a score exists but not routed", () => {
  expect(applicationStage({ scoreCount: 2, routedDepartmentCode: null, interviews: [] })).toBe("SCORING");
});
it("is ROUTED once routed with no interview", () => {
  expect(applicationStage({ scoreCount: 2, routedDepartmentCode: "EDUC", interviews: [] })).toBe("ROUTED");
});
it("is INTERVIEWING once an interview exists but is undecided", () => {
  expect(applicationStage({ scoreCount: 2, routedDepartmentCode: "EDUC", interviews: [{ decision: "PENDING" }] })).toBe("INTERVIEWING");
});
it("is DECIDED once any interview has a non-pending decision", () => {
  expect(applicationStage({ scoreCount: 2, routedDepartmentCode: "EDUC", interviews: [{ decision: "ACCEPT" }] })).toBe("DECIDED");
});
```

- [ ] **Step 5: Run it to verify failure**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run src/modules/recruitment/engine/application-stage.test.ts`
Expected: FAIL ("Cannot find module './application-stage'").

- [ ] **Step 6: Implement the stage helper**

Create `src/modules/recruitment/engine/application-stage.ts`:

```ts
export type ApplicationStage =
  | "AWAITING_SCORING"
  | "SCORING"
  | "ROUTED"
  | "INTERVIEWING"
  | "DECIDED";

/** Derived pipeline stage. `status` on Application stays DRAFT|SUBMITTED; the
 *  stage is computed from committee scores, the routed department, and the
 *  application's interviews. */
export function applicationStage(input: {
  scoreCount: number;
  routedDepartmentCode: string | null;
  interviews: { decision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST" }[];
}): ApplicationStage {
  if (input.interviews.some((i) => i.decision !== "PENDING")) return "DECIDED";
  if (input.interviews.length > 0) return "INTERVIEWING";
  if (input.routedDepartmentCode) return "ROUTED";
  if (input.scoreCount > 0) return "SCORING";
  return "AWAITING_SCORING";
}

export const applicationStageLabel: Record<ApplicationStage, string> = {
  AWAITING_SCORING: "Awaiting scoring",
  SCORING: "Scoring",
  ROUTED: "Routed",
  INTERVIEWING: "Interviewing",
  DECIDED: "Decided",
};
```

- [ ] **Step 7: Run to green**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run src/modules/recruitment/engine/application-stage.test.ts`
Expected: PASS.

- [ ] **Step 8: Switch director visibility to routed dept + include interviews**

In `src/modules/recruitment/services/review.ts`, update `ReviewApplication` and the director-filter tail of `listApplicantsForReview`:

```ts
export type ReviewApplication = Application & {
  applicant: { firstName: string; lastName: string; email: string };
  acceptances: Acceptance[];
  committeeScores: { score: number }[];
  interviews: { decision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST" }[];
};
```

Add `interviews: { select: { decision: true } }` to the `include`, and replace the director filter:

```ts
  if (seeAll) return apps;
  const mine = new Set(scope.departmentCodes);
  // Director queues are driven by committee ROUTING, not applicant choice: a
  // director sees the applications routed to a department they direct.
  return apps.filter((a) => a.routedDepartmentCode != null && mine.has(a.routedDepartmentCode));
```

- [ ] **Step 9: Update the review test for routed visibility**

In `src/modules/recruitment/services/review.test.ts`, the director-scope test "scopes a director to applicants who ranked their department" now needs the applicant ROUTED to the director's dept. Update it:

```ts
  it("scopes a director to applicants routed to their department", async () => {
    const { director, srr, cycle, appSrhd } = await seed();
    // Route appSrhd to SRHD (the director's department) as SRR.
    await prisma.application.update({ where: { id: appSrhd.id }, data: { routedDepartmentCode: "SRHD", routedById: srr.id, routedAt: new Date() } });
    const apps = await listApplicantsForReview(cycle.id, director.id);
    expect(apps.map((a) => a.id)).toEqual([appSrhd.id]);
  });
```

- [ ] **Step 10: Run the review test + typecheck**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run src/modules/recruitment/services/review.test.ts
npx tsc --noEmit
```
Expected: PASS; no type errors.

- [ ] **Step 11: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/modules/recruitment
git commit -m "feat(recruitment): application routing fields, stage helper, routed director visibility"
```

---

### Task 8: `routing.ts` service (`routeApplication`)

**Files:**
- Create: `src/modules/recruitment/services/routing.ts`
- Test: `src/modules/recruitment/services/routing.test.ts`

**Interfaces:**
- Consumes: `can`, `recordAudit`, `RecruitmentAuthError`.
- Produces: `routeApplication(applicationId, departmentCode, actorId): Promise<Application>`; `class RoutingError`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/recruitment/services/routing.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { routeApplication, RoutingError } from "./routing";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  await prisma.department.create({ data: { code: "MDIC", name: "Medical" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const other = await prisma.person.create({ data: { name: "Other", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "SRR", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC", "MDIC"], createdById: lead.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email: "a@y.edu", emailLower: "a@y.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  return { lead, other, application };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("routeApplication", () => {
  it("lets a lead route to any cycle department (even off-choice) and audits", async () => {
    const { lead, application } = await seed();
    const routed = await routeApplication(application.id, "MDIC", lead.id); // MDIC not in departmentChoices
    expect(routed.routedDepartmentCode).toBe("MDIC");
    expect(routed.routedById).toBe(lead.id);
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.route" } });
    expect(audit).not.toBeNull();
  });

  it("rejects a non-lead", async () => {
    const { other, application } = await seed();
    await expect(routeApplication(application.id, "EDUC", other.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });

  it("rejects a department not in the cycle", async () => {
    const { lead, application } = await seed();
    await expect(routeApplication(application.id, "NOPE", lead.id)).rejects.toBeInstanceOf(RoutingError);
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run src/modules/recruitment/services/routing.test.ts`
Expected: FAIL ("Cannot find module './routing'").

- [ ] **Step 3: Implement the service**

Create `src/modules/recruitment/services/routing.ts`:

```ts
import type { Application } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";

export class RoutingError extends Error {
  constructor(message: string) { super(message); this.name = "RoutingError"; }
}

/** A recruitment lead assigns the committee's best-fit department. Routing may
 *  be off-choice (the UI flags it); the derived flag is
 *  `!application.departmentChoices.includes(routedDepartmentCode)`. */
export async function routeApplication(
  applicationId: string,
  departmentCode: string,
  actorId: string,
): Promise<Application> {
  if (!(await can(actorId, "recruitment.review_all"))) {
    throw new RecruitmentAuthError("You can't route applications.");
  }
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { cycle: { select: { departments: true } } },
  });
  if (!app) throw new RoutingError("Application not found.");
  if (app.status !== "SUBMITTED") throw new RoutingError("This application hasn't been submitted yet.");
  if (!app.cycle.departments.includes(departmentCode)) throw new RoutingError("That department is not part of this cycle.");
  const updated = await prisma.application.update({
    where: { id: applicationId },
    data: { routedDepartmentCode: departmentCode, routedById: actorId, routedAt: new Date() },
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.route", entityType: "Application", entityId: applicationId, after: { departmentCode } });
  return updated;
}
```

- [ ] **Step 4: Run to green**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run src/modules/recruitment/services/routing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/routing.ts src/modules/recruitment/services/routing.test.ts
git commit -m "feat(recruitment): routeApplication service (best-fit department routing)"
```

---

### Task 9: Routing UI (detail Route control + roster Stage column)

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts` (`routeAction`)
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` (Routing card)
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx` (Stage column)

**Interfaces:**
- Consumes: `routeApplication`, `RoutingError`; `applicationStage`, `applicationStageLabel`.
- Produces: `routeAction(cycleId, applicationId, formData)`.

- [ ] **Step 1: Add the route action**

In `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts`, add:

```ts
import { routeApplication, RoutingError } from "@/modules/recruitment/services/routing";

export async function routeAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const departmentCode = String(formData.get("departmentCode") ?? "").trim();
  try {
    await routeApplication(applicationId, departmentCode, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof RoutingError) redirect(bounce(cycleId, applicationId, err.message));
    throw err;
  }
  revalidatePath(bounce(cycleId, applicationId));
}
```

- [ ] **Step 2: Add the Routing card to the detail page**

In `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`:

Add imports:
```tsx
import { routeAction } from "../actions";
```

After the existing fetches, compute lead-routing eligibility:
```tsx
const canRoute = scope.all; // recruitment.review_all
const routedOffChoice = app.routedDepartmentCode != null && !app.departmentChoices.includes(app.routedDepartmentCode);
```

Insert a Routing `<Card>` AFTER the Committee score card and BEFORE the decision/interview branch:
```tsx
{canRoute && (
  <Card>
    <SectionHeader>Routing</SectionHeader>
    {app.routedDepartmentCode ? (
      <p className="mt-3 text-sm text-foreground-soft">
        Routed to <strong className="text-foreground">{app.routedDepartmentCode}</strong>
        {routedOffChoice && <Badge tone="warning" className="ml-2">off-choice</Badge>}
      </p>
    ) : (
      <p className="mt-3 text-sm text-muted-foreground">Not routed yet. Applicant ranked: {app.departmentChoices.join(", ") || "-"}.</p>
    )}
    <form action={routeAction.bind(null, id, applicationId)} className="mt-4 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4">
      <div className="w-40">
        <Field label={app.routedDepartmentCode ? "Re-route to" : "Route to"}>
          <Select name="departmentCode" required defaultValue={app.routedDepartmentCode ?? ""}>
            <option value="" disabled>Select…</option>
            {app.cycle.departments.map((d) => (
              <option key={d} value={d}>
                {d}{app.departmentChoices.includes(d) ? " (ranked)" : ""}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <SubmitButton size="sm" pendingLabel="Routing…">Route</SubmitButton>
    </form>
  </Card>
)}
```

- [ ] **Step 3: Add the Stage column to the roster**

In `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx`:

Add import:
```tsx
import { applicationStage, applicationStageLabel } from "@/modules/recruitment/engine/application-stage";
```

Add a `<TH>` after `Committee avg`:
```tsx
            <TH>Stage</TH>
```

Inside the row map (after the Committee avg `<TD>`), add:
```tsx
                <TD>
                  <Badge>{applicationStageLabel[applicationStage({
                    scoreCount: a.committeeScores.length,
                    routedDepartmentCode: a.routedDepartmentCode,
                    interviews: a.interviews,
                  })]}</Badge>
                </TD>
```

Update the empty-state `colSpan={6}` to `colSpan={7}`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify in the running app**

As a `recruitment.review_all` lead, open a scored applicant, route them to a department (try an off-choice pick → "off-choice" badge), and confirm the roster Stage column advances to "Routed".

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/recruitment/cycles"
git commit -m "feat(recruitment): routing UI (best-fit department) + roster stage column"
```

---

## Slice 4 - Department stage reachability + decision-confirmation fix

### Task 10: Make interviews reachable for routed volunteers; remove instant-accept

**Files:**
- Modify: `src/modules/recruitment/services/interviews.ts` (`createInterview` guards)
- Modify: `src/modules/recruitment/services/review.ts` (remove `acceptApplicant`)
- Modify: `src/modules/recruitment/services/review.test.ts` (remove `acceptApplicant` cases)
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts` (remove `acceptApplicantAction`)
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` (replace the volunteer Accept card with a Department-review card)
- Test: `src/modules/recruitment/services/interviews.test.ts` (routed-volunteer case)

**Interfaces:**
- Consumes: `Application.routedDepartmentCode`.
- Produces: `createInterview` accepts routed volunteer applications (dept must equal the routed dept); director track unchanged.

- [ ] **Step 1: Write the failing interviews test (routed volunteer)**

In `src/modules/recruitment/services/interviews.test.ts`, add a case (reuse/adapt the existing seed but with a VOLUNTEER cycle + a routed application; the director must direct the routed dept):

```ts
it("creates an interview for a routed volunteer application in its routed department", async () => {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const educ = await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  const director = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: educ.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC"], createdById: director.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email: "a@y.edu", emailLower: "a@y.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: [], routedDepartmentCode: "EDUC" } });
  const iv = await createInterview(application.id, "EDUC", director.id);
  expect(iv.departmentCode).toBe("EDUC");
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run src/modules/recruitment/services/interviews.test.ts`
Expected: FAIL (current `createInterview` throws `InterviewError("Interviews apply to director cycles.")`).

- [ ] **Step 3: Generalize `createInterview`**

In `src/modules/recruitment/services/interviews.ts`, inside `createInterview`, DELETE the track guard line:

```ts
  if (app.cycle.track !== "DIRECTOR") throw new InterviewError("Interviews apply to director cycles.");
```

and REPLACE the ranked-choice guard:

```ts
  if (!scope.all && !app.departmentChoices.includes(departmentCode)) {
    throw new RecruitmentAuthError("This applicant did not rank that department.");
  }
```

with:

```ts
  if (app.routedDepartmentCode) {
    // Volunteer pipeline: the department comes from committee routing, not choice.
    if (departmentCode !== app.routedDepartmentCode) {
      throw new InterviewError("This applicant was routed to a different department.");
    }
  } else if (!scope.all && !app.departmentChoices.includes(departmentCode)) {
    // Director track (no routing): fall back to the applicant's ranked choice.
    throw new RecruitmentAuthError("This applicant did not rank that department.");
  }
```

- [ ] **Step 4: Run the interviews test to green**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run src/modules/recruitment/services/interviews.test.ts`
Expected: PASS (existing director-track cases still pass - routedDepartmentCode is null there).

- [ ] **Step 5: Remove the instant-accept service + tests**

In `src/modules/recruitment/services/review.ts`, delete the entire `acceptApplicant(...)` function. Keep `RecruitmentAuthError`, `AcceptanceError`, `reviewScope`, `listApplicantsForReview`, `listAcceptances`, `revokeAcceptance`.

In `src/modules/recruitment/services/review.test.ts`, delete the `describe("acceptApplicant", ...)` block and any `acceptApplicant` import.

- [ ] **Step 6: Remove the instant-accept action**

In `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts`, delete `acceptApplicantAction` and remove `acceptApplicant` from the `@/modules/recruitment/services/review` import. Keep `revokeAcceptanceAction`? It is only used by the Accept card being removed in Step 7 - delete `revokeAcceptanceAction` too, and drop `revokeAcceptance` from the import. Keep `scheduleInterviewAction` (reused below).

- [ ] **Step 7: Replace the volunteer Accept card with a Department-review card**

In `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`:

Remove the `acceptApplicantAction, revokeAcceptanceAction` names from the `../actions` import (keep `scheduleInterviewAction`, `committeeScoreAction`, `routeAction`).

Change the interviews fetch so routed volunteer apps load their interviews:
```tsx
const existingInterviews = (app.routedDepartmentCode || app.cycle.track === "DIRECTOR")
  ? await listApplicationInterviews(applicationId) : [];
const canManageRouted = app.routedDepartmentCode
  ? (scope.all || scope.departmentCodes.includes(app.routedDepartmentCode)) : false;
```

Replace the whole `{app.cycle.track === "VOLUNTEER" ? ( ...Accept card... ) : ( ...Interview card... )}` block with:

```tsx
{app.cycle.track === "DIRECTOR" ? (
  <Card>
    <SectionHeader>Interview</SectionHeader>
    {error && <Alert tone="error" className="mt-3">{error}</Alert>}
    {existingInterviews.length > 0 && (
      <ul className="mt-3 space-y-1 text-sm">
        {existingInterviews.map((iv) => (
          <li key={iv.id}>
            <Link className="font-medium text-brand-fg hover:text-brand-hover" href={`/recruitment/interviews/${iv.id}`}>
              Interview for {iv.departmentCode}
            </Link>
          </li>
        ))}
      </ul>
    )}
    {scheduleChoices.length > 0 ? (
      <form action={scheduleInterviewAction.bind(null, id, applicationId)} className="mt-4 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4">
        <div className="w-40">
          <Field label="Department">
            <Select name="departmentCode" required>
              {scheduleChoices.map((d) => (<option key={d} value={d}>{d}</option>))}
            </Select>
          </Field>
        </div>
        <SubmitButton size="sm" pendingLabel="Scheduling…">Schedule interview</SubmitButton>
      </form>
    ) : existingInterviews.length === 0 ? (
      <p className="mt-3 text-sm text-muted-foreground">No eligible department to interview for in your scope.</p>
    ) : null}
  </Card>
) : (
  <Card>
    <SectionHeader>Department review</SectionHeader>
    {error && <Alert tone="error" className="mt-3">{error}</Alert>}
    {!app.routedDepartmentCode ? (
      <p className="mt-3 text-sm text-muted-foreground">Awaiting committee routing.</p>
    ) : existingInterviews.length > 0 ? (
      <ul className="mt-3 space-y-1 text-sm">
        {existingInterviews.map((iv) => (
          <li key={iv.id}>
            <Link className="font-medium text-brand-fg hover:text-brand-hover" href={`/recruitment/interviews/${iv.id}`}>
              Interview for {iv.departmentCode}
            </Link>
          </li>
        ))}
      </ul>
    ) : canManageRouted ? (
      <form action={scheduleInterviewAction.bind(null, id, applicationId)} className="mt-4 border-t border-border-subtle pt-4">
        <input type="hidden" name="departmentCode" value={app.routedDepartmentCode} />
        <p className="mb-3 text-sm text-foreground-soft">Routed to <strong className="text-foreground">{app.routedDepartmentCode}</strong>.</p>
        <SubmitButton size="sm" pendingLabel="Starting…">Start interview</SubmitButton>
      </form>
    ) : (
      <p className="mt-3 text-sm text-muted-foreground">Routed to {app.routedDepartmentCode}. Waiting on the department to interview.</p>
    )}
  </Card>
)}
```

If `scheduleChoices` / `interviewedDepts` were only used by the old director branch, keep their definitions (still used above). If `getApplication` uses an explicit `select`, ensure `routedDepartmentCode` is included (it is a scalar; add it if a `select` omits it - check `src/modules/recruitment/services/submissions.ts` `getApplication`).

- [ ] **Step 8: Run affected tests + typecheck**

Run:
```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_recruit npx vitest run src/modules/recruitment/services/review.test.ts src/modules/recruitment/services/interviews.test.ts src/modules/recruitment/services/interview-decisions.test.ts
npx tsc --noEmit
```
Expected: PASS; no type errors. (Also grep for any remaining `acceptApplicant` references: `grep -rn "acceptApplicant" src` - there should be none.)

- [ ] **Step 9: Commit**

```bash
git add src/modules/recruitment "src/app/(app)/recruitment/cycles"
git commit -m "feat(recruitment): route volunteer decisions through interviews; remove instant-accept"
```

---

### Task 11: Fix the decision-confirmation bug (interview page)

**Files:**
- Modify: `src/app/(app)/recruitment/interviews/actions.ts` (`detail()` helper + success redirects)
- Modify: `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx` (read `saved`, success Alert, reflect decision)

**Interfaces:**
- Produces: on-page success confirmation for the decision (and sibling actions), and a Decision form that reflects the recorded decision.

- [ ] **Step 1: Extend the `detail()` helper to carry a success flag**

In `src/app/(app)/recruitment/interviews/actions.ts`, replace the `detail` helper:

```ts
function detail(interviewId: string, opts?: { error?: string; saved?: string }) {
  const base = `/recruitment/interviews/${interviewId}`;
  if (opts?.error) return `${base}?error=${encodeURIComponent(opts.error)}`;
  if (opts?.saved) return `${base}?saved=${encodeURIComponent(opts.saved)}`;
  return base;
}
```

Update every existing `detail(interviewId, "message")` call to `detail(interviewId, { error: "message" })` (there are error-path calls in `scheduleAction`, `addPanelistAction`, `removePanelistAction`, `sendInviteAction`, `decideAction`, `rescindAcceptanceAction`, `submitEvaluationAction`).

- [ ] **Step 2: Redirect on success from `decideAction` (and siblings)**

In `decideAction`, replace the trailing `revalidatePath(detail(interviewId));` with a success redirect placed AFTER the try/catch:

```ts
  try { await decideInterview(interviewId, outcome, person.personId, notes); }
  catch (err) { if (isDomain(err)) redirect(detail(interviewId, { error: (err as Error).message })); throw err; }
  redirect(detail(interviewId, { saved: "decision" }));
```

Apply the same pattern to the other actions in the file - replace their final `revalidatePath(detail(interviewId));` with `redirect(detail(interviewId, { saved: "<key>" }));` after the try/catch, using keys: `schedule`, `panelist`, `invite`, `evaluation`, `rescind` (for `scheduleAction`, `addPanelistAction`, `sendInviteAction`, `submitEvaluationAction`, `rescindAcceptanceAction`; `removePanelistAction` uses `panelist` too). Keep `import { revalidatePath } from "next/cache";` only if still referenced; if no longer used, remove it.

- [ ] **Step 3: Read `saved` and render a success Alert + reflect the decision**

In `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx`:

Widen the searchParams type + destructure:
```tsx
export default async function InterviewDetail({ params, searchParams }: { params: Promise<{ interviewId: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const { interviewId } = await params;
  const { error, saved } = await searchParams;
```

Add a success map near the decision maps:
```tsx
const savedMessage: Record<string, string> = {
  decision: "Decision recorded.",
  schedule: "Schedule saved.",
  panelist: "Panel updated.",
  invite: "Invite sent.",
  evaluation: "Evaluation saved.",
  rescind: "Acceptance rescinded.",
};
```

Render the success Alert right after the existing error Alert (`{error && <Alert tone="error">{error}</Alert>}`):
```tsx
      {saved && savedMessage[saved] && <Alert tone="success">{savedMessage[saved]}</Alert>}
```

Make the Decision `<Select>` reflect the recorded outcome - change:
```tsx
                <Select name="outcome" required>
```
to:
```tsx
                <Select name="outcome" required defaultValue={iv.decision === "PENDING" ? "ACCEPT" : iv.decision}>
```

Add a "recorded" line inside the Decision `<Card>`, right after the decide `<form>`:
```tsx
          {iv.decision !== "PENDING" && iv.decidedAt && (
            <p className="mt-2 text-xs text-subtle-foreground">
              {decisionLabel[iv.decision as keyof typeof decisionLabel]} · recorded <DateTime value={iv.decidedAt} />
            </p>
          )}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify the fix in the running app**

Open a manageable interview, record a decision, and confirm: (a) a green "Decision recorded." Alert appears, (b) the outcome dropdown now shows the recorded decision (not resetting to Accept), (c) the "… recorded <date>" line shows, and (d) the header Badge reflects the new decision.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/recruitment/interviews"
git commit -m "fix(recruitment): confirm interview decisions on-page + reflect recorded state"
```

---

## Self-Review (completed before handoff)

- **Spec coverage:** Committee 1–5 scoring + running average → Tasks 4–6. Best-fit routing (prefer choices, off-choice flag) → Tasks 7–9. Department 1–5 interview scoring + final decision → Tasks 3, 10. Retire `Recommendation` → Task 3. `recruitment.score` permission → Task 1. Surface reachability → Task 2. Tri-modal visibility → Tasks 6 (score see-all) + 7 (director routed filter). `applicationStage` → Task 7. Decision-confirmation bug → Task 11. Instant-accept removed → Task 10. All spec sections map to a task.
- **Placeholder scan:** No TBD/TODO; every code step carries complete code. Two `Read`-first steps (index page in Task 2; `getApplication` in Task 10) are explicit, bounded mechanical checks, not deferred design.
- **Type consistency:** `scoreAverage`/`evaluationSummary`/`committeeScoreSummary` all return `{ average: number | null; count: number }`. `applicationStage` input shape matches the `interviews: { decision }[]` selected in `review.ts`. `detail(interviewId, { error?, saved? })` is used consistently after Task 11.
- **Deviation from spec (noted):** the spec described "one Prisma migration"; this plan uses **three** migrations (one per slice: Task 3, 4, 7) so each slice stays green and independently reviewable. Same end schema.
