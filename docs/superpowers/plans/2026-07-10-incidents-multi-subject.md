# Incidents: link multiple people involved, per-person strikes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an incident report link any number of people involved, each carrying an independent, per-person strike request a reviewer decides separately.

**Architecture:** Introduce a join model `IncidentReportSubject` (one row per linked person) that also holds that person's strike-request state. Move the report-level strike fields onto that row; generalise `DisciplinaryAction`'s report link from unique-per-report to unique-per-(report, person). Regenerate the intake service, reviewer flow, notifications, and the four UI surfaces from "the subject" to "each linked person". Free-text `subjectDescription` stays as the fallback for unlisted people.

**Tech Stack:** Next.js 16 App Router (server components + server actions), Prisma 6 + Postgres, Vitest (DB-backed), Playwright e2e, Tailwind design-system primitives.

**Spec:** `docs/superpowers/specs/2026-07-10-incidents-multi-subject-design.md`

## Global Constraints

- **Worktree + branch:** all work lands in `/Users/jcarney/Documents/Code-Projects/HAVENHub-wt-incidents-multi` on `feat/incidents-multi-subject` (off `origin/main`). Use worktree-rooted absolute paths for file edits.
- **Per-worktree test DB (never Neon):** `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi"`. Env vars do NOT persist between shell calls and vitest ignores `.env`, so **inline this on every `npm test` / `prisma` command** (e.g. `TEST_DATABASE_URL=... npm test`). The repo `.env` points `DATABASE_URL` at shared prod Neon; never run `prisma migrate`/vitest against it.
- **Shared Prisma client:** `node_modules` is symlinked to the main checkout, so `prisma generate` regenerates the client for every worktree. That is expected here (the change is this branch's). CI (with each branch's own schema) is the authoritative gate for DB-backed tests; if local docker Postgres is unavailable, push and let CI run them.
- **Migration hygiene:** hand-write the migration SQL (do not rely on `prisma migrate dev` autogen, which folds pre-existing repo drift). Scalar-list defaults must emit `DEFAULT ARRAY[]::TEXT[]` (unchanged here). Run `prisma migrate status` clean before any Neon deploy; previews share the prod DB, so a branch behind a migration crashes P2021.
- **Copy rules:** no em-dashes in any user-facing copy (use commas, parentheses, or periods). "HAVEN Hub" is two words in prose/UI; identifiers stay `havenhub`.
- **Lint purity:** no `Date.now()` in React render (use `new Date()`); CI lints before testing, so a lint failure hides test output. Run `npm run lint` and `npm run typecheck` before declaring any UI task done.
- **TDD + frequent commits:** service/schema tasks are test-first; each task ends with a commit.

---

## File Structure

- `prisma/schema.prisma` — add `IncidentReportSubject`; edit `IncidentReport`, `DisciplinaryAction`, `Person` relations. (Task 1)
- `prisma/migrations/20260710150000_incidents_multi_subject/migration.sql` — new hand-written migration. (Task 1)
- `src/modules/incidents/services/report.ts` — intake, reads, decideStrike, notifications. (Tasks 2, 3, 4, 5)
- `src/modules/incidents/services/report.test.ts` — updated + new DB-backed tests. (Tasks 2, 3, 4, 5)
- `src/platform/email/templates/incidents.ts` — `strike_requested` template `subjectNames`. (Task 5)
- `src/app/(app)/incidents/actions.ts` — form parsing for `subjects[]` + `reportSubjectId`. (Task 6)
- `src/app/(app)/incidents/subject-picker.tsx` — multi-person client picker. (Task 7)
- `src/app/(app)/incidents/page.tsx` — report form section 4 wiring. (Task 8)
- `src/app/(app)/incidents/[id]/page.tsx` — subjects list + per-subject strike controls. (Task 9)
- `src/app/(app)/incidents/mine/page.tsx`, `src/app/(app)/incidents/review/page.tsx` — subject names + aggregate strike column. (Task 10)
- `e2e/incidents.spec.ts` (or the existing incidents spec) — multi-person + per-person strike flow. (Task 11)

---

### Task 1: Schema, migration, and generated client

**Files:**
- Modify: `prisma/schema.prisma` (models `IncidentReport`, `DisciplinaryAction`, `Person`; new model `IncidentReportSubject`)
- Create: `prisma/migrations/20260710150000_incidents_multi_subject/migration.sql`

**Interfaces:**
- Produces: Prisma model `IncidentReportSubject { id, reportId, personId, strikeDecision: StrikeDecision|null, strikeDecidedById, strikeDecidedAt, createdAt, report, person, strikeDecidedBy }`; `IncidentReport.subjects: IncidentReportSubject[]` and `IncidentReport.strikeActions: DisciplinaryAction[]`; `DisciplinaryAction` composite unique `(reportId, personId)`. `IncidentReport.subjectPersonId`/`strikeDecision`/`strikeDecidedById`/`strikeDecidedAt` and the `subject`/`strikeDecidedBy`/`strikeAction` relations are REMOVED.

- [ ] **Step 1: Provision the per-worktree test DB and apply existing migrations**

Run (from the worktree root):
```bash
npm run db:up
docker compose exec -T postgres psql -U haven -d havenhub -c "CREATE DATABASE havenhub_incidents_multi" || true
DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" \
DATABASE_URL_UNPOOLED="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" \
  npx prisma migrate deploy
```
Expected: existing migrations apply, ending "All migrations have been successfully applied." (If docker is unavailable locally, skip local DB steps throughout and rely on CI per Global Constraints.)

- [ ] **Step 2: Add the `IncidentReportSubject` model to `prisma/schema.prisma`**

Add immediately after the `IncidentReport` model:
```prisma
/// Links an incident report to one person involved (one row per person) and
/// carries that person's per-report strike-request state, so a single report
/// can hold independent strike requests against multiple people.
model IncidentReportSubject {
  id                String          @id @default(cuid())
  reportId          String
  personId          String
  /// null = linked for context only. PENDING/APPROVED/DECLINED = strike request state.
  strikeDecision    StrikeDecision?
  strikeDecidedById String?
  strikeDecidedAt   DateTime?
  createdAt         DateTime        @default(now())
  /// Cascade: the link belongs to the report.
  report            IncidentReport  @relation(fields: [reportId], references: [id], onDelete: Cascade)
  /// Cascade: the link is meaningless without the person.
  person            Person          @relation("incidentReportSubjectPerson", fields: [personId], references: [id], onDelete: Cascade)
  /// The reviewer who decided this person's strike request.
  strikeDecidedBy   Person?         @relation("incidentReportSubjectStrikeDecidedBy", fields: [strikeDecidedById], references: [id], onDelete: SetNull)

  @@unique([reportId, personId])
  @@index([reportId])
  @@index([personId])
}
```

- [ ] **Step 3: Edit the `IncidentReport` model**

In `model IncidentReport`, REMOVE these lines:
```prisma
  subjectPersonId       String?
  strikeDecision        StrikeDecision?
  strikeDecidedById     String?
  strikeDecidedAt       DateTime?
```
and REMOVE these relation lines:
```prisma
  subject               Person?              @relation("incidentReportSubject", fields: [subjectPersonId], references: [id], onDelete: SetNull)
  strikeDecidedBy       Person?              @relation("incidentReportStrikeDecidedBy", fields: [strikeDecidedById], references: [id], onDelete: Restrict)
  strikeAction          DisciplinaryAction?  @relation("incidentReportStrikeAction")
```
and REMOVE the index line `@@index([subjectPersonId])`.

ADD these two relation lines (next to `attachments`):
```prisma
  subjects              IncidentReportSubject[]
  strikeActions         DisciplinaryAction[]       @relation("incidentReportStrikeAction")
```
Keep `subjectDescription String?` and everything else unchanged.

- [ ] **Step 4: Edit the `DisciplinaryAction` model**

Change the `reportId` line from:
```prisma
  reportId        String?  @unique
```
to:
```prisma
  reportId        String?
```
Keep the `report` relation line as-is. Add a composite unique below the existing `@@index([personId])`:
```prisma
  @@unique([reportId, personId])
```

- [ ] **Step 5: Edit the `Person` model relations**

Replace:
```prisma
  incidentReportsAbout        IncidentReport[]           @relation("incidentReportSubject")
```
with:
```prisma
  incidentSubjectLinks        IncidentReportSubject[]    @relation("incidentReportSubjectPerson")
```
and replace:
```prisma
  incidentStrikeDecisions     IncidentReport[]           @relation("incidentReportStrikeDecidedBy")
```
with:
```prisma
  incidentSubjectStrikeDecisions IncidentReportSubject[] @relation("incidentReportSubjectStrikeDecidedBy")
```

- [ ] **Step 6: Validate the schema**

Run: `npx prisma validate`
Expected: "The schema at prisma/schema.prisma is valid."

- [ ] **Step 7: Write the migration SQL**

Create `prisma/migrations/20260710150000_incidents_multi_subject/migration.sql`:
```sql
-- CreateTable
CREATE TABLE "IncidentReportSubject" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "strikeDecision" "StrikeDecision",
    "strikeDecidedById" TEXT,
    "strikeDecidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IncidentReportSubject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IncidentReportSubject_reportId_personId_key" ON "IncidentReportSubject"("reportId", "personId");
CREATE INDEX "IncidentReportSubject_reportId_idx" ON "IncidentReportSubject"("reportId");
CREATE INDEX "IncidentReportSubject_personId_idx" ON "IncidentReportSubject"("personId");

-- AddForeignKey
ALTER TABLE "IncidentReportSubject" ADD CONSTRAINT "IncidentReportSubject_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "IncidentReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncidentReportSubject" ADD CONSTRAINT "IncidentReportSubject_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncidentReportSubject" ADD CONSTRAINT "IncidentReportSubject_strikeDecidedById_fkey" FOREIGN KEY ("strikeDecidedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: one subject row per existing report that named a single subject,
-- carrying over its strike-decision state. gen_random_uuid() is built-in on
-- Postgres 13+ (docker + Neon are current).
INSERT INTO "IncidentReportSubject" ("id", "reportId", "personId", "strikeDecision", "strikeDecidedById", "strikeDecidedAt", "createdAt")
SELECT gen_random_uuid()::text, "id", "subjectPersonId", "strikeDecision", "strikeDecidedById", "strikeDecidedAt", "createdAt"
FROM "IncidentReport"
WHERE "subjectPersonId" IS NOT NULL;

-- Swap DisciplinaryAction uniqueness from reportId to (reportId, personId).
DROP INDEX "DisciplinaryAction_reportId_key";
CREATE UNIQUE INDEX "DisciplinaryAction_reportId_personId_key" ON "DisciplinaryAction"("reportId", "personId");

-- Drop the old single-subject and report-level strike columns.
ALTER TABLE "IncidentReport" DROP CONSTRAINT "IncidentReport_subjectPersonId_fkey";
ALTER TABLE "IncidentReport" DROP CONSTRAINT "IncidentReport_strikeDecidedById_fkey";
DROP INDEX "IncidentReport_subjectPersonId_idx";
ALTER TABLE "IncidentReport" DROP COLUMN "subjectPersonId";
ALTER TABLE "IncidentReport" DROP COLUMN "strikeDecision";
ALTER TABLE "IncidentReport" DROP COLUMN "strikeDecidedById";
ALTER TABLE "IncidentReport" DROP COLUMN "strikeDecidedAt";
```

- [ ] **Step 8: Apply the migration and regenerate the client**

Run:
```bash
DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" \
DATABASE_URL_UNPOOLED="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" \
  npx prisma migrate deploy
npx prisma generate
DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" npx prisma migrate status
```
Expected: migrate deploy applies `20260710150000_incidents_multi_subject`; generate succeeds; `migrate status` reports "Database schema is up to date!".

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260710150000_incidents_multi_subject/migration.sql
git commit -m "feat(incidents): IncidentReportSubject join model + per-person strike migration"
```

---

### Task 2: `submitReport` accepts multiple subjects with per-person strike requests

**Files:**
- Modify: `src/modules/incidents/services/report.ts` (`SubmitReportInput`, `submitReport`, `notifyReviewersOfSubmission` call site)
- Test: `src/modules/incidents/services/report.test.ts`

**Interfaces:**
- Consumes: `IncidentReportSubject` (Task 1); existing `canRequestStrikeAgainst(actorPersonId, subjectPersonId): Promise<boolean>`.
- Produces: `SubmitReportInput.subjects?: Array<{ personId: string; requestStrike?: boolean }>` (replaces `subjectPersonId?` + `requestStrike?`). `submitReport(actorPersonId, input): Promise<IncidentReport>` creates one `IncidentReportSubject` per deduped subject (strike-flagged ones at `strikeDecision = "PENDING"`).

- [ ] **Step 1: Write the failing tests**

In `report.test.ts`, replace the `submitReport` subject/strike tests (the "persists the optional fields", "rejects requestStrike without a subjectPersonId", "rejects requestStrike when the actor does not manage the subject", and "allows requestStrike ... PENDING" tests) with these. Keep the concernTypes/description/occurredAt validation tests and the attachment test unchanged.

```ts
it("persists multiple linked people as IncidentReportSubject rows", async () => {
  const reporter = await createPerson("Reporter", "rep002");
  const a = await createPerson("Alex", "sub-a");
  const b = await createPerson("Bri", "sub-b");

  const report = await submitReport(reporter.id, {
    concernTypes: ["PATIENT_SAFETY"],
    description: "Both were involved in the handoff error.",
    subjectDescription: "two volunteers",
    subjects: [{ personId: a.id }, { personId: b.id }],
  });

  const rows = await prisma.incidentReportSubject.findMany({
    where: { reportId: report.id },
    orderBy: { createdAt: "asc" },
  });
  expect(rows.map((r) => r.personId).sort()).toEqual([a.id, b.id].sort());
  expect(rows.every((r) => r.strikeDecision === null)).toBe(true);
  expect(report.subjectDescription).toBe("two volunteers");
});

it("dedupes a repeated personId into a single link", async () => {
  const reporter = await createPerson("Reporter", "rep002b");
  const a = await createPerson("Alex", "sub-a2");

  const report = await submitReport(reporter.id, {
    concernTypes: ["OTHER"],
    description: "x",
    subjects: [{ personId: a.id }, { personId: a.id, requestStrike: false }],
  });

  const rows = await prisma.incidentReportSubject.findMany({ where: { reportId: report.id } });
  expect(rows).toHaveLength(1);
});

it("rejects a linked person that does not exist -> IncidentNotFoundError", async () => {
  const reporter = await createPerson("Reporter", "rep002c");
  await expect(
    submitReport(reporter.id, {
      concernTypes: ["OTHER"],
      description: "x",
      subjects: [{ personId: "nonexistent-person-id" }],
    })
  ).rejects.toBeInstanceOf(IncidentNotFoundError);
});

it("rejects requestStrike against a person the actor does not manage -> IncidentValidationError", async () => {
  const reporter = await createPerson("Reporter", "rep009");
  const subject = await createPerson("Subject", "sub002");
  await expect(
    submitReport(reporter.id, {
      concernTypes: ["ATTENDANCE_RELIABILITY"],
      description: "no-show",
      subjects: [{ personId: subject.id, requestStrike: true }],
    })
  ).rejects.toBeInstanceOf(IncidentValidationError);
});

it("sets strikeDecision PENDING only for the managed volunteer, null for the rest", async () => {
  const term = await createTerm();
  const dept = await createDepartment("ITCM");
  const director = await createPerson("Director", "dir001");
  const managed = await createPerson("Managed Volunteer", "vol001");
  const other = await createPerson("Unmanaged Person", "oth001");
  await createMembership(director.id, term.id, dept.id, "DIRECTOR");
  await createMembership(managed.id, term.id, dept.id, "VOLUNTEER");

  const report = await submitReport(director.id, {
    concernTypes: ["ATTENDANCE_RELIABILITY"],
    description: "No-call/no-show for a scheduled shift.",
    subjects: [{ personId: managed.id, requestStrike: true }, { personId: other.id }],
  });

  const rows = await prisma.incidentReportSubject.findMany({ where: { reportId: report.id } });
  const byPerson = new Map(rows.map((r) => [r.personId, r.strikeDecision]));
  expect(byPerson.get(managed.id)).toBe("PENDING");
  expect(byPerson.get(other.id)).toBeNull();
});
```

Also update the first test ("creates a SUBMITTED report ...") to drop the `expect(report.strikeDecision).toBeNull();` line (the field no longer exists on the report). And update the audit test's `strikeRequested` expectation to remain `false` (no subjects requested) — it already passes no subjects.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" npx vitest run src/modules/incidents/services/report.test.ts -t "submitReport"`
Expected: FAIL (type errors on `subjects`, and `report.strikeDecision` gone).

- [ ] **Step 3: Update `SubmitReportInput` and `submitReport`**

In `report.ts`, in `SubmitReportInput` replace:
```ts
  subjectPersonId?: string | null;
  ...
  requestStrike?: boolean;
```
with (keeping `subjectDescription?` and `files?`):
```ts
  subjects?: Array<{ personId: string; requestStrike?: boolean }>;
```

Replace the subject/strike section of `submitReport` (the block from `if (input.subjectPersonId) {...}` through the `prisma.incidentReport.create({...})` call) with:
```ts
  // Dedupe subjects by personId; a person requests a strike if any duplicate did.
  const subjectMap = new Map<string, boolean>();
  for (const s of input.subjects ?? []) {
    subjectMap.set(s.personId, (subjectMap.get(s.personId) ?? false) || Boolean(s.requestStrike));
  }
  const subjects = [...subjectMap.entries()].map(([personId, requestStrike]) => ({ personId, requestStrike }));

  // Every linked person must exist.
  for (const s of subjects) {
    const person = await prisma.person.findUnique({ where: { id: s.personId } });
    if (!person) throw new IncidentNotFoundError(`Subject ${s.personId} not found.`);
  }

  // A strike may only be requested against a volunteer in a department the actor
  // manages. The UI only offers the checkbox for eligible people; this is the
  // server-side tamper guard.
  for (const s of subjects) {
    if (s.requestStrike && !(await canRequestStrikeAgainst(actorPersonId, s.personId))) {
      throw new IncidentValidationError("You can only request a strike for a volunteer in a department you manage.");
    }
  }
  const strikeRequested = subjects.some((s) => s.requestStrike);

  const report = await prisma.incidentReport.create({
    data: {
      reporterId: actorPersonId,
      anonymous: input.anonymous ?? false,
      concernTypes,
      description: input.description,
      occurredAt: input.occurredAt ?? null,
      setting: input.setting ?? null,
      subjectDescription: input.subjectDescription ?? null,
      patientImpact: input.patientImpact ?? null,
      patientImpactDetail: input.patientImpactDetail ?? null,
      immediateRisk: input.immediateRisk ?? false,
      issueNature: input.issueNature ?? null,
      priorOccurrence: input.priorOccurrence ?? null,
      priorOccurrenceDetail: input.priorOccurrenceDetail ?? null,
      subjects: {
        create: subjects.map((s) => ({
          personId: s.personId,
          strikeDecision: s.requestStrike ? ("PENDING" as const) : null,
        })),
      },
    },
  });
```

Update the audit `after` to use `strikeRequested`:
```ts
    after: { number: report.number, concernTypes, immediateRisk: report.immediateRisk, strikeRequested },
```

For the notifications call, gather the pending subject names and pass them (the notify function is rewritten in Task 5; for now change the call to compute names). Just before `await notifyReviewersOfSubmission(...)`, add:
```ts
  const pendingSubjectNames =
    subjects.length === 0
      ? []
      : (
          await prisma.person.findMany({
            where: { id: { in: subjects.filter((s) => s.requestStrike).map((s) => s.personId) } },
            select: { name: true },
          })
        ).map((p) => p.name);
```
and change the call to `await notifyReviewersOfSubmission(report, pendingSubjectNames, actorPersonId);` (its new signature lands in Task 5; if implementing Task 2 alone, temporarily keep the old call and revisit — but prefer implementing Task 5's notify signature change together to keep the file compiling).

> Note: Tasks 2 and 5 both touch `report.ts` notification wiring. If executing task-by-task with a compiling checkpoint after each, land the Task 5 `notifyReviewersOfSubmission` signature change in the same commit as this step. Otherwise sequence Task 2 then Task 5 back-to-back before running the full suite.

- [ ] **Step 4: Run the submitReport tests to verify they pass**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" npx vitest run src/modules/incidents/services/report.test.ts -t "submitReport"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/incidents/services/report.ts src/modules/incidents/services/report.test.ts
git commit -m "feat(incidents): submitReport links multiple people with per-person strike requests"
```

---

### Task 3: `decideStrike` decides one subject's strike by join-row id

**Files:**
- Modify: `src/modules/incidents/services/report.ts` (`decideStrike`)
- Test: `src/modules/incidents/services/report.test.ts`

**Interfaces:**
- Consumes: `issueAction(actorPersonId, { personId, reportId, ... }): Promise<DisciplinaryAction>` (unchanged); `isUniqueConstraintError` (existing import).
- Produces: `decideStrike(actorPersonId, reportSubjectId, input): Promise<IncidentReportSubject>` — approves/declines the strike on one `IncidentReportSubject` row. Requires `incidents.manage`; the row's `strikeDecision` must be `PENDING`.

- [ ] **Step 1: Write the failing tests**

Replace the existing `decideStrike` describe block's tests with ones keyed on the join row. Add a helper to fetch the pending subject row after submitting:

```ts
describe("decideStrike (per subject)", () => {
  async function seedPendingStrike() {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "ds-dir");
    const managed = await createPerson("Managed", "ds-vol");
    const bystander = await createPerson("Bystander", "ds-by");
    const manager = await createPerson("Manager", "ds-mgr");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(managed.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(manager.id, "incidents.manage");

    const report = await submitReport(director.id, {
      concernTypes: ["ATTENDANCE_RELIABILITY"],
      description: "No-call/no-show.",
      anonymous: true,
      subjects: [{ personId: managed.id, requestStrike: true }, { personId: bystander.id }],
    });
    const pending = await prisma.incidentReportSubject.findFirstOrThrow({
      where: { reportId: report.id, strikeDecision: "PENDING" },
    });
    return { report, pending, managed, bystander, manager, director };
  }

  it("non-manager -> IncidentForbiddenError", async () => {
    const { pending, director } = await seedPendingStrike();
    await expect(
      decideStrike(director.id, pending.id, { approve: false })
    ).rejects.toBeInstanceOf(IncidentForbiddenError);
  });

  it("missing subject row -> IncidentNotFoundError", async () => {
    const { manager } = await seedPendingStrike();
    await expect(
      decideStrike(manager.id, "no-such-row", { approve: false })
    ).rejects.toBeInstanceOf(IncidentNotFoundError);
  });

  it("approve issues one DisciplinaryAction for that person, mirrors anonymous->confidential, sets APPROVED", async () => {
    const { pending, managed, manager } = await seedPendingStrike();

    const row = await decideStrike(manager.id, pending.id, {
      approve: true,
      category: DISCIPLINARY_CATEGORIES[0],
    });
    expect(row.strikeDecision).toBe("APPROVED");
    expect(row.strikeDecidedById).toBe(manager.id);

    const actions = await prisma.disciplinaryAction.findMany({ where: { personId: managed.id } });
    expect(actions).toHaveLength(1);
    expect(actions[0].reportId).toBe(pending.reportId);
    expect(actions[0].confidential).toBe(true);
  });

  it("approving one subject leaves another subject's request untouched", async () => {
    const { report, pending, manager } = await seedPendingStrike();
    await decideStrike(manager.id, pending.id, { approve: true, category: DISCIPLINARY_CATEGORIES[0] });
    const others = await prisma.incidentReportSubject.findMany({
      where: { reportId: report.id, id: { not: pending.id } },
    });
    expect(others.every((r) => r.strikeDecision === null)).toBe(true);
  });

  it("decline sets DECLINED with no DisciplinaryAction", async () => {
    const { pending, managed, manager } = await seedPendingStrike();
    const row = await decideStrike(manager.id, pending.id, { approve: false });
    expect(row.strikeDecision).toBe("DECLINED");
    expect(await prisma.disciplinaryAction.count({ where: { personId: managed.id } })).toBe(0);
  });

  it("row not PENDING -> IncidentValidationError", async () => {
    const { pending, manager } = await seedPendingStrike();
    await decideStrike(manager.id, pending.id, { approve: false });
    await expect(
      decideStrike(manager.id, pending.id, { approve: true, category: DISCIPLINARY_CATEGORIES[0] })
    ).rejects.toBeInstanceOf(IncidentValidationError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" npx vitest run src/modules/incidents/services/report.test.ts -t "decideStrike"`
Expected: FAIL (decideStrike signature mismatch, `IncidentReportSubject` unknown).

- [ ] **Step 3: Rewrite `decideStrike`**

Add `IncidentReportSubject` to the `@prisma/client` type import at the top of `report.ts`. Replace the whole `decideStrike` function with:
```ts
export async function decideStrike(
  actorPersonId: string,
  reportSubjectId: string,
  input: DecideStrikeInput
): Promise<IncidentReportSubject> {
  if (!(await can(actorPersonId, "incidents.manage"))) throw new IncidentForbiddenError();

  const subject = await prisma.incidentReportSubject.findUnique({
    where: { id: reportSubjectId },
    include: { report: true },
  });
  if (!subject) throw new IncidentNotFoundError();
  if (subject.strikeDecision !== "PENDING") {
    throw new IncidentValidationError("This linked person has no pending strike request.");
  }
  const report = subject.report;

  if (!input.approve) {
    const declined = await prisma.incidentReportSubject.update({
      where: { id: reportSubjectId },
      data: { strikeDecision: "DECLINED", strikeDecidedById: actorPersonId, strikeDecidedAt: new Date() },
    });

    await recordAudit({
      actorPersonId,
      action: "incident.strike_decided",
      entityType: "IncidentReport",
      entityId: report.id,
      after: { decision: "DECLINED", reportSubjectId, personId: subject.personId },
    });

    await notifyReporterOfStrikeDecision(report, actorPersonId, false);
    return declined;
  }

  const category = input.category ?? "";
  if (!(DISCIPLINARY_CATEGORIES as readonly string[]).includes(category)) {
    throw new IncidentValidationError(`Choose a strike category. One of: ${DISCIPLINARY_CATEGORIES.join(", ")}.`);
  }

  // issueAction enforces its own permission (incidents.manage -> central bypass).
  let strikeAction: DisciplinaryAction;
  try {
    strikeAction = await issueAction(actorPersonId, {
      personId: subject.personId,
      occurredAt: input.occurredAt ?? report.occurredAt ?? new Date(),
      category,
      description: report.description,
      followUpActions: input.followUpActions ?? null,
      policyReference: input.policyReference ?? null,
      notes: input.notes ?? null,
      confidential: report.anonymous, // anonymous report -> strike hidden from directors
      patientInvolved: report.patientImpact === "YES",
      reportId: report.id,
    });
  } catch (err) {
    // DisciplinaryAction is now unique per (reportId, personId). A concurrent
    // double-approve of the same subject races two issueAction calls; the loser
    // hits the composite unique here rather than surfacing as a raw 500.
    if (isUniqueConstraintError(err)) {
      throw new IncidentValidationError("A strike has already been issued for this person on this report.");
    }
    throw err;
  }

  const approved = await prisma.incidentReportSubject.update({
    where: { id: reportSubjectId },
    data: { strikeDecision: "APPROVED", strikeDecidedById: actorPersonId, strikeDecidedAt: new Date() },
  });

  await recordAudit({
    actorPersonId,
    action: "incident.strike_decided",
    entityType: "IncidentReport",
    entityId: report.id,
    after: { decision: "APPROVED", strikeActionId: strikeAction.id, reportSubjectId, personId: subject.personId },
  });

  await notifyReporterOfStrikeDecision(report, actorPersonId, true);
  return approved;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" npx vitest run src/modules/incidents/services/report.test.ts -t "decideStrike"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/incidents/services/report.ts src/modules/incidents/services/report.test.ts
git commit -m "feat(incidents): decideStrike decides one linked person's strike by join-row id"
```

---

### Task 4: Reads — subjects on getReport, and names + strike summary on the lists

**Files:**
- Modify: `src/modules/incidents/services/report.ts` (`getReport`, `ReportListRow`, `listMyReports`, `ReviewQueueRow`, `listReviewQueue`, plus a `summarizeSubjects` helper)
- Test: `src/modules/incidents/services/report.test.ts`

**Interfaces:**
- Produces:
  - `getReport(...).report.subjects: Array<{ id: string; personId: string; strikeDecision: StrikeDecision | null; person: { name: string } }>` (replaces `report.subject`).
  - `ReportListRow = { report: IncidentReport; subjectNames: string[]; strikePendingCount: number; strikeIssuedCount: number }`.
  - `ReviewQueueRow = { report: IncidentReport; reporterName: string; subjectNames: string[]; strikePendingCount: number; strikeIssuedCount: number }`.
  - `listReviewQueue` `q` matches any linked subject's name; `strikePending` filter matches any PENDING subject.

- [ ] **Step 1: Write the failing tests**

Update the `getReport` and `listReviewQueue` tests. Replace any `report.subject?.name` assertion with the subjects array, and add queue-search coverage:
```ts
it("getReport returns the linked subjects with names", async () => {
  const owner = await createPerson("Owner", "gr-own");
  const a = await createPerson("Alex", "gr-a");
  const report = await submitReport(owner.id, {
    concernTypes: ["OTHER"],
    description: "x",
    subjects: [{ personId: a.id }],
  });
  const { report: got } = await getReport(owner.id, report.id);
  expect(got.subjects.map((s) => s.person.name)).toEqual(["Alex"]);
});

it("listReviewQueue q matches a report by any linked subject's name", async () => {
  const reporter = await createPerson("Reporter", "lq-rep");
  const manager = await createPerson("Manager", "lq-mgr");
  const zoe = await createPerson("Zoe Zephyr", "lq-zoe");
  await grantPermission(manager.id, "incidents.manage");
  const report = await submitReport(reporter.id, {
    concernTypes: ["OTHER"],
    description: "x",
    subjects: [{ personId: zoe.id }],
  });
  const { rows } = await listReviewQueue(manager.id, { q: "Zephyr" });
  expect(rows.map((r) => r.report.id)).toContain(report.id);
  expect(rows.find((r) => r.report.id === report.id)?.subjectNames).toContain("Zoe Zephyr");
});

it("listReviewQueue strikePending matches a report with any PENDING subject", async () => {
  const term = await createTerm();
  const dept = await createDepartment("ITCM");
  const director = await createPerson("Director", "lq-dir");
  const managed = await createPerson("Managed", "lq-vol");
  const manager = await createPerson("Manager", "lq-mgr2");
  await createMembership(director.id, term.id, dept.id, "DIRECTOR");
  await createMembership(managed.id, term.id, dept.id, "VOLUNTEER");
  await grantPermission(manager.id, "incidents.manage");
  const report = await submitReport(director.id, {
    concernTypes: ["ATTENDANCE_RELIABILITY"],
    description: "x",
    subjects: [{ personId: managed.id, requestStrike: true }],
  });
  const { rows } = await listReviewQueue(manager.id, { strikePending: true });
  expect(rows.map((r) => r.report.id)).toContain(report.id);
  expect(rows.find((r) => r.report.id === report.id)?.strikePendingCount).toBe(1);
});
```
Also update the existing `listMyReports` newest-first test to read `subjectNames` instead of `subjectName` where it asserts on the subject (if it does).

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" npx vitest run src/modules/incidents/services/report.test.ts -t "getReport|listReviewQueue|listMyReports"`
Expected: FAIL.

- [ ] **Step 3: Add the `summarizeSubjects` helper and update the reads**

Add near the top of the read section of `report.ts`:
```ts
type SubjectWithName = { strikeDecision: StrikeDecision | null; person: { name: string } };

/** Derive display names + strike counts from a report's linked subjects. */
function summarizeSubjects(subjects: SubjectWithName[]): {
  subjectNames: string[];
  strikePendingCount: number;
  strikeIssuedCount: number;
} {
  return {
    subjectNames: subjects.map((s) => s.person.name),
    strikePendingCount: subjects.filter((s) => s.strikeDecision === "PENDING").length,
    strikeIssuedCount: subjects.filter((s) => s.strikeDecision === "APPROVED").length,
  };
}
```
Add `StrikeDecision` to the `@prisma/client` type import if not already present.

Change `ReportListRow`:
```ts
export type ReportListRow = {
  report: IncidentReport;
  subjectNames: string[];
  strikePendingCount: number;
  strikeIssuedCount: number;
};
```
Rewrite `listMyReports`:
```ts
export async function listMyReports(actorPersonId: string): Promise<ReportListRow[]> {
  const reports = await prisma.incidentReport.findMany({
    where: { reporterId: actorPersonId },
    include: { subjects: { include: { person: { select: { name: true } } } } },
    orderBy: [{ createdAt: "desc" }, { number: "desc" }],
  });
  return reports.map((r) => ({ report: r, ...summarizeSubjects(r.subjects) }));
}
```

Rewrite `getReport`'s query `include` and return type. Change the include from `subject: { select: { name: true } }` to `subjects: { include: { person: { select: { name: true } } }, orderBy: { createdAt: "asc" } }`, and update the declared return type's `report` intersection from `subject: { name: string } | null` to:
```ts
    subjects: Array<{ id: string; personId: string; strikeDecision: StrikeDecision | null; person: { name: string } }>;
```

Change `ReviewQueueRow`:
```ts
export type ReviewQueueRow = {
  report: IncidentReport;
  reporterName: string;
  subjectNames: string[];
  strikePendingCount: number;
  strikeIssuedCount: number;
};
```
In `listReviewQueue`, update the filters and mapping:
- Replace `if (filters.strikePending) where.strikeDecision = "PENDING";` with `if (filters.strikePending) where.subjects = { some: { strikeDecision: "PENDING" } };`
- In the `filters.q` block, replace the subject clause `{ subject: { name: { contains: q, mode: "insensitive" } } }` with `{ subjects: { some: { person: { name: { contains: q, mode: "insensitive" } } } } }`.
- Change the query `include` from `subject: { select: { name: true } }, reporter: {...}` to `subjects: { include: { person: { select: { name: true } } } }, reporter: { select: { name: true } }`.
- Change the return mapping to:
```ts
    rows: reports.map((r) => ({ report: r, reporterName: r.reporter.name, ...summarizeSubjects(r.subjects) })),
```

- [ ] **Step 4: Run to verify passing**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" npx vitest run src/modules/incidents/services/report.test.ts -t "getReport|listReviewQueue|listMyReports"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/incidents/services/report.ts src/modules/incidents/services/report.test.ts
git commit -m "feat(incidents): reads expose linked subject names and per-report strike counts"
```

---

### Task 5: Notifications name all pending subjects; email template pluralised

**Files:**
- Modify: `src/modules/incidents/services/report.ts` (`notifyReviewersOfSubmission`)
- Modify: `src/platform/email/templates/incidents.ts` (`StrikeRequestedParams`, `strikeRequestedContext`, descriptor)
- Test: `src/modules/incidents/services/report.test.ts`

**Interfaces:**
- Consumes: `strikeRequestedContext({ reviewerName, reportNumber, subjectNames, reviewLink })` (renamed param).
- Produces: `notifyReviewersOfSubmission(report, pendingSubjectNames: string[], actorPersonId): Promise<void>` — fires `incidents.strike_requested` once when `pendingSubjectNames.length > 0`, naming them.

- [ ] **Step 1: Write the failing test**

Update the notification test "also sends a strike_requested alert ..." to link a managed volunteer with a per-person strike and assert the name appears, and add a second subject that is not struck:
```ts
it("sends one strike_requested alert naming the flagged people when a strike is requested", async () => {
  const term = await createTerm();
  const dept = await createDepartment("ITCM");
  const director = await createPerson("Director", "notif-dir001");
  const managed = await createPerson("Managed Vol", "notif-vol001");
  const bystander = await createPerson("Bystander", "notif-by001");
  const manager = await createPerson("Manager", "notif-mgr002");
  await createMembership(director.id, term.id, dept.id, "DIRECTOR");
  await createMembership(managed.id, term.id, dept.id, "VOLUNTEER");
  await grantPermission(manager.id, "incidents.manage");

  await submitReport(director.id, {
    concernTypes: ["ATTENDANCE_RELIABILITY"],
    description: "No-call/no-show.",
    subjects: [{ personId: managed.id, requestStrike: true }, { personId: bystander.id }],
  });

  const strikeNotes = await prisma.notification.findMany({
    where: { personId: manager.id, type: "incidents.strike_requested" },
  });
  expect(strikeNotes).toHaveLength(1);
  expect(strikeNotes[0].body).toContain("Managed Vol");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" npx vitest run src/modules/incidents/services/report.test.ts -t "strike_requested|notifications"`
Expected: FAIL.

- [ ] **Step 3: Update the email template**

In `src/platform/email/templates/incidents.ts`:
- In `StrikeRequestedParams`, rename `subjectName` to `subjectNames` and update the doc comment to "Comma-separated names of the people a strike is being requested against."
- In `strikeRequestedContext`, return `subjectNames: p.subjectNames` instead of `subjectName`.
- In the `incidents.strike_requested` descriptor, change the variable entry to `{ name: "subjectNames", label: "Names the strike is requested against (comma-separated)", sampleValue: "Jane Doe, John Roe" }` and the `defaultBody` line to:
```
<p>Incident report #{{ reportNumber }} includes a request to issue a disciplinary strike against {{ subjectNames }}.</p>
```

- [ ] **Step 4: Update `notifyReviewersOfSubmission`**

Change its signature and the strike branch. Replace the function's parameter list and the `subjectName` derivation with `pendingSubjectNames`:
```ts
async function notifyReviewersOfSubmission(
  report: IncidentReport,
  pendingSubjectNames: string[],
  actorPersonId: string
): Promise<void> {
  try {
    const reviewers = await peopleWithAnyPermission(["incidents.manage"]);
    if (reviewers.length === 0) return;

    const baseUrl = await getSetting<string>("app.baseUrl");
    const reviewLink = `${baseUrl}/incidents/review`;
    const concernSummary = report.concernTypes.map((c) => CONCERN_LABELS[c] ?? c).join(", ");
    const hasStrikeRequest = pendingSubjectNames.length > 0;
    const subjectNames = pendingSubjectNames.join(", ");
```
Then in the reviewer loop, replace the `if (report.strikeDecision === "PENDING" && subjectName) {` guard with `if (hasStrikeRequest) {`, and in the `strikeRequestedContext({ ... })` call pass `subjectNames` instead of `subjectName`. Update the Teams `summary` string to `` `Incident report #${report.number} includes a request to issue a disciplinary strike against ${subjectNames}.` ``. Remove the now-unused report-level `subjectPersonId` lookup block at the top of the old function.

(The call site in `submitReport` already passes `pendingSubjectNames` from Task 2 Step 3.)

- [ ] **Step 5: Run to verify passing**

Run: `TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" npx vitest run src/modules/incidents/services/report.test.ts`
Expected: PASS (the whole incidents report suite).

- [ ] **Step 6: Typecheck the service + email surface and commit**

Run: `npx tsc --noEmit`
Expected: no errors in `report.ts` / `incidents.ts` (UI files still reference old shapes and are fixed in later tasks; if executing strictly task-by-task, expect UI errors here and clear them by Task 10 — verify the service files specifically compile).
```bash
git add src/modules/incidents/services/report.ts src/modules/incidents/services/report.test.ts src/platform/email/templates/incidents.ts
git commit -m "feat(incidents): strike_requested notification and email name all flagged people"
```

---

### Task 6: Server actions parse multiple subjects and per-subject strike decisions

**Files:**
- Modify: `src/app/(app)/incidents/actions.ts` (`submitReportAction`, `decideStrikeAction`)

**Interfaces:**
- Consumes: `submitReport(actor, { subjects, ... })` (Task 2); `decideStrike(actor, reportSubjectId, input)` (Task 3).
- Produces: form contract — `submitReportAction` reads repeated `subjectPersonIds` + `strikePersonIds`; `decideStrikeAction` reads `reportId` (for redirect) + `reportSubjectId` (for the decision).

- [ ] **Step 1: Update `submitReportAction`**

In `actions.ts`, replace the two lines:
```ts
      subjectPersonId: (String(formData.get("subjectPersonId") ?? "").trim() || null),
```
and the `requestStrike: formData.get("requestStrike") === "on",` line, with a `subjects` array built before the `submitReport` call:
```ts
  const strikeIds = new Set(formData.getAll("strikePersonIds").map(String));
  const subjects = formData
    .getAll("subjectPersonIds")
    .map(String)
    .filter(Boolean)
    .map((personId) => ({ personId, requestStrike: strikeIds.has(personId) }));
```
and pass `subjects,` into the `submitReport(actor.personId, { ... })` input (keep `subjectDescription` as-is).

- [ ] **Step 2: Update `decideStrikeAction`**

Replace its body's id read and call:
```ts
export async function decideStrikeAction(formData: FormData): Promise<void> {
  const actor = await requirePermission("incidents.manage");
  const reportId = String(formData.get("reportId"));
  const reportSubjectId = String(formData.get("reportSubjectId"));
  try {
    await decideStrike(actor.personId, reportSubjectId, {
      approve: formData.get("approve") === "yes",
      category: (String(formData.get("category") ?? "").trim() || undefined),
      occurredAt: null,
      notes: (String(formData.get("notes") ?? "").trim() || null),
    });
  } catch (err) {
    if (err instanceof IncidentValidationError) redirect(`/incidents/${reportId}?error=validation&message=${encodeURIComponent(err.message)}`);
    if (err instanceof IncidentForbiddenError) redirect(`/incidents/${reportId}?error=forbidden`);
    if (err instanceof IncidentNotFoundError) redirect(`/incidents/review?error=not-found`);
    throw err;
  }
  revalidatePath(`/incidents/${reportId}`);
  revalidatePath("/incidents/review");
  redirect(`/incidents/${reportId}`);
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: `actions.ts` compiles (UI page files still pending; verify no new `actions.ts` errors).

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/incidents/actions.ts
git commit -m "feat(incidents): actions parse multiple linked subjects and per-subject strike decisions"
```

---

### Task 7: Multi-person subject picker (client component)

**Files:**
- Rewrite: `src/app/(app)/incidents/subject-picker.tsx`

**Interfaces:**
- Consumes: `SubjectOption = { id: string; name: string; hint: string | null }` (from `report.ts`), `strikeEligibleIds: string[]`.
- Produces: a form fragment that submits repeated hidden `subjectPersonIds` inputs and, per strike-eligible added person, a `strikePersonIds` checkbox valued with the person id.

- [ ] **Step 1: Rewrite the component**

Replace the entire file with:
```tsx
"use client";

import { useState } from "react";
import { Combobox } from "@/platform/ui/combobox";
import { Checkbox } from "@/platform/ui/checkbox";
import { Button } from "@/platform/ui/button";
import { Field } from "@/platform/ui/input";
import type { SubjectOption } from "@/modules/incidents/services/report";

/**
 * Section 4 people picker for the incident report form.
 *
 * A searchable person picker adds people one at a time to an on-page list; each
 * added person rides in a hidden `subjectPersonIds` input, so the parent
 * server-action form receives the full set. A person who is a volunteer the
 * reporter manages (`strikeEligibleIds`) gets a per-row "Request a strike"
 * checkbox valued with their id (`strikePersonIds`); submitReport re-checks
 * eligibility server-side, so this gating is UX only.
 */
export function SubjectPicker({
  people,
  strikeEligibleIds,
}: {
  people: SubjectOption[];
  strikeEligibleIds: string[];
}) {
  const [added, setAdded] = useState<SubjectOption[]>([]);
  const [picked, setPicked] = useState("");
  const [comboKey, setComboKey] = useState(0);

  const eligible = new Set(strikeEligibleIds);
  const byId = new Map(people.map((p) => [p.id, p]));
  const addedIds = new Set(added.map((p) => p.id));

  function add() {
    if (!picked || addedIds.has(picked)) return;
    const person = byId.get(picked);
    if (!person) return;
    setAdded((prev) => [...prev, person]);
    setPicked("");
    setComboKey((k) => k + 1); // remount Combobox to clear its text + value
  }

  function remove(id: string) {
    setAdded((prev) => prev.filter((p) => p.id !== id));
  }

  return (
    <div className="space-y-3">
      <Field
        label="Link the people involved (optional)"
        hint="Search anyone in the system, a volunteer, director, or staff member. Add as many as apply. Use the box above for anyone not listed."
      >
        <div className="flex gap-2">
          <div className="flex-1">
            <Combobox
              key={comboKey}
              name="subjectSearch"
              ariaLabel="Search people to link to this report"
              placeholder="Search by name..."
              options={people
                .filter((p) => !addedIds.has(p.id))
                .map((p) => ({ value: p.id, label: p.hint ? `${p.name} (${p.hint})` : p.name }))}
              onValueChange={setPicked}
            />
          </div>
          <Button type="button" variant="outline" onClick={add} disabled={!picked}>
            Add
          </Button>
        </div>
      </Field>

      {added.length > 0 && (
        <ul className="space-y-2">
          {added.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-subtle px-3 py-2 text-sm"
            >
              <input type="hidden" name="subjectPersonIds" value={p.id} />
              <span className="font-medium text-foreground">{p.name}</span>
              {p.hint && <span className="text-subtle-foreground">{p.hint}</span>}
              {eligible.has(p.id) && (
                <label className="flex items-center gap-2 text-sm text-foreground-soft">
                  <Checkbox name="strikePersonIds" value={p.id} /> Request a strike
                </label>
              )}
              <button
                type="button"
                onClick={() => remove(p.id)}
                className="ml-auto text-xs text-subtle-foreground underline hover:text-foreground"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors in `subject-picker.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/incidents/subject-picker.tsx
git commit -m "feat(incidents): multi-person subject picker with per-person strike checkbox"
```

---

### Task 8: Report form wires the multi-person picker

**Files:**
- Modify: `src/app/(app)/incidents/page.tsx`

**Interfaces:**
- Consumes: `SubjectPicker` (Task 7), unchanged `listSubjectOptions`.

- [ ] **Step 1: Relabel the free-text box (plural) and confirm the picker call**

In `page.tsx`, the Section 4 block already renders `<SubjectPicker people={subject.people} strikeEligibleIds={subject.strikeEligibleIds} />` (unchanged API, so no change needed there). Update only the free-text field label so both controls read as plural:
```tsx
          {/* Section 4: subjects */}
          <Field label="4. Name, role, or department of the individual(s) of concern">
            <Textarea name="subjectDescription" rows={2} placeholder="If unknown, describe as observed" />
          </Field>
          <SubjectPicker people={subject.people} strikeEligibleIds={subject.strikeEligibleIds} />
```
(No functional change beyond confirming the picker still receives `subject.people` / `subject.strikeEligibleIds`; `listSubjectOptions` is unchanged.)

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: `page.tsx` compiles.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/incidents/page.tsx
git commit -m "feat(incidents): report form uses the multi-person subject picker"
```

---

### Task 9: Detail page renders linked people and per-subject strike controls

**Files:**
- Modify: `src/app/(app)/incidents/[id]/page.tsx`

**Interfaces:**
- Consumes: `getReport(...).report.subjects` (Task 4); `decideStrikeAction` reading `reportId` + `reportSubjectId` (Task 6).

- [ ] **Step 1: Add a strike-tone map**

Below the existing `STRIKE_LABELS` constant, add:
```tsx
const STRIKE_TONES: Record<StrikeDecision, BadgeTone> = {
  PENDING: "warning",
  APPROVED: "success",
  DECLINED: "default",
};
```

- [ ] **Step 2: Replace the "Individual(s) of concern" card**

Replace the existing card (the `<Card>` whose `SectionHeader` is "Individual(s) of concern") with:
```tsx
      <Card>
        <SectionHeader>Individual(s) of concern</SectionHeader>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="text-xs text-subtle-foreground">Linked people</dt>
            <dd className="mt-0.5 text-sm text-foreground">
              {report.subjects.length > 0 ? (
                <ul className="space-y-1">
                  {report.subjects.map((s) => (
                    <li key={s.id} className="flex items-center gap-2">
                      <span>{s.person.name}</span>
                      {s.strikeDecision && (
                        <Badge tone={STRIKE_TONES[s.strikeDecision]}>{STRIKE_LABELS[s.strikeDecision]}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                "(none linked)"
              )}
            </dd>
          </div>
          {report.subjectDescription && (
            <div className="sm:col-span-2">
              <dt className="text-xs text-subtle-foreground">As described</dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{report.subjectDescription}</dd>
            </div>
          )}
        </dl>
      </Card>
```

- [ ] **Step 3: Replace the report-level "Strike request" field in the Reporting details card**

In the "Reporting details" card, replace the `<div>` whose `dt` is "Strike request" (it read `report.strikeDecision`) with a subject-derived summary:
```tsx
          <div>
            <dt className="text-xs text-subtle-foreground">Strike requests</dt>
            <dd className="mt-0.5 text-sm text-foreground">
              {(() => {
                const pending = report.subjects.filter((s) => s.strikeDecision === "PENDING").length;
                const issued = report.subjects.filter((s) => s.strikeDecision === "APPROVED").length;
                const declined = report.subjects.filter((s) => s.strikeDecision === "DECLINED").length;
                const parts = [
                  pending ? `${pending} pending` : "",
                  issued ? `${issued} issued` : "",
                  declined ? `${declined} declined` : "",
                ].filter(Boolean);
                return parts.length ? parts.join(", ") : "No strike requested";
              })()}
            </dd>
          </div>
```

- [ ] **Step 4: Replace the reviewer strike controls with a per-pending-subject loop**

Replace the reviewer strike block (the `{report.strikeDecision === "PENDING" && ( ... )}` section AND the `{report.strikeDecision === "APPROVED" && ( ... )}` paragraph) with a loop over pending subjects:
```tsx
          {report.subjects.filter((s) => s.strikeDecision === "PENDING").length > 0 && (
            <div className="mt-6 space-y-6 border-t border-border-subtle pt-6">
              <SectionHeader level="title">Strike requests</SectionHeader>
              {report.subjects
                .filter((s) => s.strikeDecision === "PENDING")
                .map((s) => (
                  <div key={s.id} className="rounded-lg border border-border-subtle p-4">
                    <p className="text-sm text-foreground-soft">
                      Pending strike request against <span className="font-medium">{s.person.name}</span>.
                    </p>
                    <div className="mt-4 grid gap-6 sm:grid-cols-2">
                      <form action={decideStrikeAction} className="space-y-3">
                        <input type="hidden" name="reportId" value={report.id} />
                        <input type="hidden" name="reportSubjectId" value={s.id} />
                        <input type="hidden" name="approve" value="yes" />
                        <Field label="Strike category" required>
                          <Select name="category" required defaultValue="">
                            <option value="">Select category...</option>
                            {DISCIPLINARY_CATEGORIES.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Notes">
                          <Textarea name="notes" rows={2} placeholder="Optional notes on this decision..." />
                        </Field>
                        <FormActions>
                          <Button type="submit" variant="primary" size="sm">
                            Approve strike
                          </Button>
                        </FormActions>
                      </form>

                      <form action={decideStrikeAction} className="space-y-3">
                        <input type="hidden" name="reportId" value={report.id} />
                        <input type="hidden" name="reportSubjectId" value={s.id} />
                        <input type="hidden" name="approve" value="no" />
                        <Field label="Notes">
                          <Textarea name="notes" rows={2} placeholder="Optional reason for declining..." />
                        </Field>
                        <FormActions>
                          <Button type="submit" variant="outline" size="sm">
                            Decline strike
                          </Button>
                        </FormActions>
                      </form>
                    </div>
                  </div>
                ))}
            </div>
          )}

          {report.subjects.filter((s) => s.strikeDecision === "APPROVED").length > 0 && (
            <p className="mt-4 text-sm text-foreground-soft">
              {report.subjects.filter((s) => s.strikeDecision === "APPROVED").length} strike(s) issued from this report.
              View them on the{" "}
              <Link href="/incidents/strikes" className="text-brand-fg hover:underline">
                strikes ledger
              </Link>
              .
            </p>
          )}
```
Remove the now-unused `fmtDate(report.strikeDecidedAt)` reference. Keep the `reviewReportAction` status/notes form above unchanged.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: `[id]/page.tsx` compiles; no em-dash lint failures.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/incidents/\[id\]/page.tsx
git commit -m "feat(incidents): detail page lists linked people and decides each strike separately"
```

---

### Task 10: My-reports and Review tables show names + aggregate strike

**Files:**
- Modify: `src/app/(app)/incidents/mine/page.tsx`
- Modify: `src/app/(app)/incidents/review/page.tsx`

**Interfaces:**
- Consumes: `ReportListRow` / `ReviewQueueRow` with `subjectNames`, `strikePendingCount`, `strikeIssuedCount` (Task 4).

- [ ] **Step 1: Add shared display helpers to `mine/page.tsx`**

After the imports/labels in `mine/page.tsx`, add:
```tsx
function formatSubjectNames(names: string[]): string {
  if (names.length === 0) return "(described in report)";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
}

function aggregateStrikeLabel(pending: number, issued: number): string {
  if (pending > 0) return "Strike pending";
  if (issued > 0) return "Strike issued";
  return "";
}
```
Update the row map destructure and the Subject/Strike cells:
```tsx
              {rows.map(({ report, subjectNames, strikePendingCount, strikeIssuedCount }) => (
                <TR key={report.id}>
                  ...
                  <TD className="text-sm text-foreground-soft">{formatSubjectNames(subjectNames)}</TD>
                  ...
                  <TD className="text-sm text-foreground-soft">
                    {aggregateStrikeLabel(strikePendingCount, strikeIssuedCount)}
                  </TD>
```
Remove the now-invalid `report.strikeDecision ? STRIKE_LABELS[...] : ""` expression and the now-unused `STRIKE_LABELS` / `StrikeDecision` import if nothing else uses them.

- [ ] **Step 2: Apply the same to `review/page.tsx`**

Add the same two helper functions to `review/page.tsx`. Update the row map destructure to `{ report, reporterName, subjectNames, strikePendingCount, strikeIssuedCount }`, change the Subject cell to `{formatSubjectNames(subjectNames)}`, and replace the Strike cell:
```tsx
                    <TD>
                      {strikePendingCount > 0 && <Badge tone="warning">Strike pending</Badge>}
                    </TD>
```
(Keep the header cells unchanged.)

- [ ] **Step 3: Typecheck, lint, and full test run**

Run:
```bash
npx tsc --noEmit && npm run lint
TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" npm test
```
Expected: typecheck clean across the whole app, lint clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/incidents/mine/page.tsx src/app/\(app\)/incidents/review/page.tsx
git commit -m "feat(incidents): report lists show linked names and aggregate strike status"
```

---

### Task 11: End-to-end coverage and final verification

**Files:**
- Modify: the existing incidents Playwright spec (search `e2e/` for the incidents spec; e.g. `e2e/incidents.spec.ts`)

**Interfaces:**
- Consumes: the full running app.

- [ ] **Step 1: Add a multi-person + per-person strike e2e**

Extend the incidents spec so a director files a report linking two people, requests a strike against the managed volunteer only, submits, and then a reviewer opens the report, sees both linked people, approves the single strike, and confirms the second person carries no strike. Follow the spec file's existing auth/fixture helpers (do not invent new ones). Use role-based selectors and the plural copy added in Tasks 7 to 10 (for example the "Add" button, the "Request a strike" checkbox, and the "Approve strike" button).

- [ ] **Step 2: Run the incidents e2e locally if the harness is available**

Run: `npx playwright test e2e/incidents.spec.ts`
Expected: PASS. (If Playwright browsers/DB are not provisioned locally, rely on CI, which runs the full Playwright suite per the repo's e2e-in-CI setup.)

- [ ] **Step 3: Final full verification**

Run:
```bash
npm run lint
npx tsc --noEmit
TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" npm test
DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_incidents_multi" npx prisma migrate status
```
Expected: lint clean, types clean, tests green, migrations up to date.

- [ ] **Step 4: Commit and push for CI**

```bash
git add e2e
git commit -m "test(incidents): e2e for multi-person linking and per-person strikes"
git push -u origin feat/incidents-multi-subject
```

---

## Self-Review

**Spec coverage:**
- Decision 1 (multiple linked people, `@@unique([reportId, personId])`) — Task 1 (schema) + Task 2 (dedupe/create).
- Decision 2 (per-person strikes) — Task 2 (per-person PENDING) + Task 3 (decide one row).
- Decision 3 (strike state on join row) — Task 1 (columns) + Tasks 2/3.
- Decision 4 (DisciplinaryAction composite unique + race guard) — Task 1 (index) + Task 3 (`isUniqueConstraintError`).
- Decision 5 (per-person eligibility re-check) — Task 2 Step 3.
- Decision 6 (person Cascade) — Task 1 Step 2.
- Decision 7 (no permission/registry/nav changes) — no task touches registry; confirmed.
- Migration + backfill (spec 5) — Task 1 Step 7.
- Service changes (spec 6) — Tasks 2, 3, 4, 5.
- UI changes (spec 7) — Tasks 6 (actions), 7 (picker), 8 (form), 9 (detail), 10 (lists).
- Testing (spec 8) — Tasks 2 to 5 (unit), Task 11 (e2e).
- Open question defaults (truncate at 2 + "+N more"; "pending" while any open) — Task 10 helpers.

**Placeholder scan:** No TBD/TODO. Every code step shows full code. The only conditional guidance is the Task 2/5 co-dependency note (both edit the notify wiring), which is explicit, not a placeholder.

**Type consistency:** `SubmitReportInput.subjects: Array<{ personId; requestStrike? }>` (Task 2) is what `submitReportAction` builds (Task 6) and the picker submits as `subjectPersonIds`/`strikePersonIds` (Task 7). `decideStrike(actor, reportSubjectId, input)` (Task 3) matches `decideStrikeAction`'s `reportSubjectId` read (Task 6) and the detail form's hidden `reportSubjectId` (Task 9). `summarizeSubjects` -> `{ subjectNames, strikePendingCount, strikeIssuedCount }` (Task 4) is exactly what Tasks 9 and 10 destructure. `STRIKE_TONES` (Task 9) keys on the same `StrikeDecision` union as `STRIKE_LABELS`.

**Cross-task compile note:** executing strictly one task at a time leaves the app non-compiling between Task 5 and Task 10 (UI still references removed fields). This is expected; the per-task `tsc` checks verify the task's own files, and Task 10 Step 3 restores a fully-green typecheck. Reviewers gate on tests (service tasks) and typecheck-of-touched-files (UI tasks).
