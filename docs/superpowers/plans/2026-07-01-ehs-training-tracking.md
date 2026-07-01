# EHS Training Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track EHS (Environmental Health and Safety) training completion for all active HAVEN staff (volunteers and directors) as an admin-managed, department-scoped checklist, surfaced on a dashboard and My Info, and folded into the existing weekly compliance reminder emails.

**Architecture:** Mirror the Learning module's catalog/assignment pattern (`Course` / `CourseDepartment` / `CourseProgress` and the pure `coursesForMember` engine) with three new Prisma models and a pure applicability engine. Admin surfaces live under the Volunteers module (gated by the existing `volunteers.manage_compliance`). EHS gaps extend the existing `runComplianceReminders` state machine rather than adding a new engine or cron. A one-time read-only Airtable backfill seeds day-one state.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma/PostgreSQL, Vitest, existing platform helpers (`requirePermission`, `getActiveTerm`, `recordAudit`, `notify`, `runAction`).

## Global Constraints

- Prose/UI product name is "HAVEN Hub" (two words); identifiers stay `havenhub`.
- No em-dashes anywhere (code, comments, copy). Use commas, parentheses, colons, or periods.
- Prisma conventions, verbatim: `id String @id @default(cuid())`, `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`.
- Reuse the existing permission `volunteers.manage_compliance` for all EHS admin surfaces. Do NOT add a new RBAC permission (that would require a `SYSTEM_ROLES` change plus a grant backfill migration).
- Do NOT run `prisma migrate dev`, `prisma migrate deploy`, `prisma db push`, or DB-backed `vitest` against the shared Neon database from this worktree. The repo `.env` points all DB URLs at shared Neon; those commands would mutate or wipe it. Author migration SQL by hand. CI (preview DB) is the gate for migrations and DB-backed tests.
- Pure-function tests (no Prisma client, no DB) DO run locally in the worktree with `npx vitest run <file>`. Keep all decision logic in pure modules so it is testable here.
- `prisma validate` (schema syntax only, no DB connection) is safe to run locally and is the local check for schema tasks.
- Migrations must contain only the intended statements (no pre-existing drift). Seed the catalog with an idempotent `INSERT ... ON CONFLICT DO NOTHING` inside the migration SQL, because production build runs `prisma migrate deploy` (not `seed.ts`).
- Catalog training `name` values must EXACTLY match the Airtable Compliance-table field labels so the one-time import can map by name: `Added to EHS?`, `Chemical - Hazard Communication`, `Biological - TB Awareness`, `BBP Clinical`, `BBP Student`, `TB Baseline Screening`, `Physical Safety - Respiration`.

---

## File Structure

- `prisma/schema.prisma` — add 3 models + 1 enum + relations (Task 1).
- `prisma/migrations/<ts>_ehs_training_tracking/migration.sql` — hand-authored DDL + seed (Task 1).
- `src/modules/ehs/engine/applicability.ts` + `applicability.test.ts` — pure engine (Task 2).
- `src/modules/ehs/services/errors.ts` — domain errors (Task 3).
- `src/modules/ehs/services/trainings.ts` — catalog CRUD + department assignment (Task 3).
- `src/modules/ehs/services/completion.ts` — mark/unmark completion with audit (Task 4).
- `src/modules/ehs/services/status.ts` — dashboard rows + roster missing-map (Task 5).
- `src/app/(app)/volunteers/ehs/page.tsx` + `actions.ts` — admin dashboard (Task 6).
- `src/platform/modules/registry.ts` — nav entries (Task 6).
- `src/app/(app)/volunteers/ehs/manage/page.tsx` + `actions.ts` + `[trainingId]/page.tsx` — catalog management (Task 7).
- `src/modules/ehs/services/my-ehs.ts` + `src/modules/my-info/components/ehs-panel.tsx` + `src/app/(app)/my-info/page.tsx` — self view (Task 8).
- `src/platform/email/reminders.ts` + `src/platform/email/templates/compliance.ts` + `src/platform/notifications/registry.ts` — reminder integration (Task 9).
- `src/platform/airtable/fields.ts` + `src/platform/airtable/import/ehs.ts` + `scripts/import-ehs.ts` — one-time seed import (Task 10).

---

## Task 1: Prisma models, migration, and seed

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_ehs_training_tracking/migration.sql`

**Interfaces:**
- Produces: models `EhsTraining { id, name, description?, isActive, requiredForAll, position }`, `EhsTrainingDepartment { id, trainingId, departmentId }`, `EhsCompletion { id, personId, trainingId, completedAt?, source, markedById?, markedAt }`; enum `EhsCompletionSource { MANUAL, IMPORT }`. Seven seeded `EhsTraining` rows with fixed ids (`ehs_added_to_ehs`, `ehs_hazard_comm`, `ehs_tb_awareness`, `ehs_bbp_clinical`, `ehs_bbp_student`, `ehs_tb_baseline`, `ehs_respiration`).

- [ ] **Step 1: Add the models and enum to `prisma/schema.prisma`**

Add near the Learning models:

```prisma
enum EhsCompletionSource {
  MANUAL
  IMPORT
}

model EhsTraining {
  id             String                  @id @default(cuid())
  name           String                  @unique
  description    String?
  isActive       Boolean                 @default(true)
  /// When true, required for every active person regardless of department.
  requiredForAll Boolean                 @default(false)
  /// Ordering in the catalog and dashboard columns.
  position       Int                     @default(0)
  createdAt      DateTime                @default(now())
  updatedAt      DateTime                @updatedAt
  departments    EhsTrainingDepartment[]
  completions    EhsCompletion[]
}

model EhsTrainingDepartment {
  id           String      @id @default(cuid())
  trainingId   String
  departmentId String
  training     EhsTraining @relation(fields: [trainingId], references: [id], onDelete: Cascade)
  department   Department  @relation(fields: [departmentId], references: [id], onDelete: Cascade)

  @@unique([trainingId, departmentId])
  @@index([departmentId])
}

model EhsCompletion {
  id          String              @id @default(cuid())
  personId    String
  trainingId  String
  /// Real completion date when known; null for imported rows (date unknown).
  completedAt DateTime?
  source      EhsCompletionSource @default(MANUAL)
  /// Who marked it complete; null for import rows (no person actor).
  markedById  String?
  markedAt    DateTime            @default(now())
  createdAt   DateTime            @default(now())
  updatedAt   DateTime            @updatedAt
  person      Person              @relation("ehsCompletionPerson", fields: [personId], references: [id], onDelete: Cascade)
  markedBy    Person?             @relation("ehsCompletionMarkedBy", fields: [markedById], references: [id], onDelete: SetNull)
  training    EhsTraining         @relation(fields: [trainingId], references: [id], onDelete: Cascade)

  @@unique([personId, trainingId])
  @@index([trainingId])
}
```

- [ ] **Step 2: Add the back-relations to `Person` and `Department`**

In `model Person`, add:

```prisma
  ehsCompletions       EhsCompletion[] @relation("ehsCompletionPerson")
  ehsCompletionsMarked EhsCompletion[] @relation("ehsCompletionMarkedBy")
```

In `model Department`, add:

```prisma
  ehsTrainingDepartments EhsTrainingDepartment[]
```

- [ ] **Step 3: Validate the schema (no DB connection)**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid` (no errors).

- [ ] **Step 4: Hand-author the migration SQL**

Create `prisma/migrations/<timestamp>_ehs_training_tracking/migration.sql` (use a timestamp later than the latest existing migration directory) with EXACTLY:

```sql
-- CreateEnum
CREATE TYPE "EhsCompletionSource" AS ENUM ('MANUAL', 'IMPORT');

-- CreateTable
CREATE TABLE "EhsTraining" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "requiredForAll" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EhsTraining_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EhsTrainingDepartment" (
    "id" TEXT NOT NULL,
    "trainingId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    CONSTRAINT "EhsTrainingDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EhsCompletion" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "trainingId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "source" "EhsCompletionSource" NOT NULL DEFAULT 'MANUAL',
    "markedById" TEXT,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EhsCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EhsTraining_name_key" ON "EhsTraining"("name");

-- CreateIndex
CREATE UNIQUE INDEX "EhsTrainingDepartment_trainingId_departmentId_key" ON "EhsTrainingDepartment"("trainingId", "departmentId");

-- CreateIndex
CREATE INDEX "EhsTrainingDepartment_departmentId_idx" ON "EhsTrainingDepartment"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "EhsCompletion_personId_trainingId_key" ON "EhsCompletion"("personId", "trainingId");

-- CreateIndex
CREATE INDEX "EhsCompletion_trainingId_idx" ON "EhsCompletion"("trainingId");

-- AddForeignKey
ALTER TABLE "EhsTrainingDepartment" ADD CONSTRAINT "EhsTrainingDepartment_trainingId_fkey" FOREIGN KEY ("trainingId") REFERENCES "EhsTraining"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EhsTrainingDepartment" ADD CONSTRAINT "EhsTrainingDepartment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EhsCompletion" ADD CONSTRAINT "EhsCompletion_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EhsCompletion" ADD CONSTRAINT "EhsCompletion_markedById_fkey" FOREIGN KEY ("markedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EhsCompletion" ADD CONSTRAINT "EhsCompletion_trainingId_fkey" FOREIGN KEY ("trainingId") REFERENCES "EhsTraining"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the catalog (idempotent). "everyone" items required for all; level-specific
-- items start unassigned (required for nobody) until an admin maps them to departments.
INSERT INTO "EhsTraining" ("id", "name", "description", "isActive", "requiredForAll", "position", "createdAt", "updatedAt") VALUES
  ('ehs_added_to_ehs', 'Added to EHS?', NULL, true, true, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ehs_hazard_comm', 'Chemical - Hazard Communication', NULL, true, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ehs_tb_awareness', 'Biological - TB Awareness', NULL, true, true, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ehs_bbp_clinical', 'BBP Clinical', NULL, true, false, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ehs_bbp_student', 'BBP Student', NULL, true, false, 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ehs_tb_baseline', 'TB Baseline Screening', NULL, true, false, 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ehs_respiration', 'Physical Safety - Respiration', NULL, true, false, 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
```

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(ehs): add EhsTraining, EhsTrainingDepartment, EhsCompletion models + seed"
```

Note: the migration applies in CI/preview and production deploy (`prisma migrate deploy`), not locally. Do not run migrate against Neon from the worktree.

---

## Task 2: Pure applicability engine

**Files:**
- Create: `src/modules/ehs/engine/applicability.ts`
- Test: `src/modules/ehs/engine/applicability.test.ts`

**Interfaces:**
- Produces:
  - `type RequirableTraining = { id: string; name: string; isActive: boolean; requiredForAll: boolean; departmentIds: string[] }`
  - `requiredTrainingsForMember(params: { trainings: RequirableTraining[]; memberDepartmentIds: string[] }): RequirableTraining[]`
  - `missingTrainings(params: { trainings: RequirableTraining[]; memberDepartmentIds: string[]; completedTrainingIds: Iterable<string> }): { id: string; name: string }[]`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import {
  missingTrainings,
  requiredTrainingsForMember,
  type RequirableTraining,
} from "./applicability";

function t(over: Partial<RequirableTraining> & { id: string }): RequirableTraining {
  return {
    name: over.id,
    isActive: true,
    requiredForAll: false,
    departmentIds: [],
    ...over,
  };
}

describe("requiredTrainingsForMember", () => {
  it("includes requiredForAll active trainings for any member", () => {
    const trainings = [t({ id: "a", requiredForAll: true })];
    const out = requiredTrainingsForMember({ trainings, memberDepartmentIds: ["d1"] });
    expect(out.map((x) => x.id)).toEqual(["a"]);
  });

  it("includes a training when a member department overlaps its departments", () => {
    const trainings = [t({ id: "bbp", departmentIds: ["sctp", "jctp"] })];
    expect(
      requiredTrainingsForMember({ trainings, memberDepartmentIds: ["jctp"] }).map((x) => x.id)
    ).toEqual(["bbp"]);
  });

  it("excludes a training when no department overlaps and not requiredForAll", () => {
    const trainings = [t({ id: "bbp", departmentIds: ["sctp"] })];
    expect(
      requiredTrainingsForMember({ trainings, memberDepartmentIds: ["orhi"] })
    ).toEqual([]);
  });

  it("excludes inactive trainings even when requiredForAll", () => {
    const trainings = [t({ id: "a", requiredForAll: true, isActive: false })];
    expect(requiredTrainingsForMember({ trainings, memberDepartmentIds: ["d1"] })).toEqual([]);
  });
});

describe("missingTrainings", () => {
  it("returns required trainings the member has not completed", () => {
    const trainings = [
      t({ id: "a", name: "A", requiredForAll: true }),
      t({ id: "b", name: "B", requiredForAll: true }),
    ];
    const out = missingTrainings({
      trainings,
      memberDepartmentIds: ["d1"],
      completedTrainingIds: ["a"],
    });
    expect(out).toEqual([{ id: "b", name: "B" }]);
  });

  it("returns empty when all required trainings are completed", () => {
    const trainings = [t({ id: "a", name: "A", requiredForAll: true })];
    expect(
      missingTrainings({ trainings, memberDepartmentIds: ["d1"], completedTrainingIds: ["a"] })
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/ehs/engine/applicability.test.ts`
Expected: FAIL (cannot find module `./applicability`).

- [ ] **Step 3: Write the implementation**

```typescript
/** Pure applicability resolution for EHS trainings. No DB. A training is required
 *  for a member when it is active and either requiredForAll or one of the member's
 *  departments is in the training's department list. Mirrors the Learning module's
 *  coursesForMember, minus the SCORM package and audience-by-kind logic. */

export type RequirableTraining = {
  id: string;
  name: string;
  isActive: boolean;
  requiredForAll: boolean;
  departmentIds: string[];
};

export function requiredTrainingsForMember(params: {
  trainings: RequirableTraining[];
  memberDepartmentIds: string[];
}): RequirableTraining[] {
  const memberDepts = new Set(params.memberDepartmentIds);
  return params.trainings.filter(
    (training) =>
      training.isActive &&
      (training.requiredForAll ||
        training.departmentIds.some((d) => memberDepts.has(d)))
  );
}

export function missingTrainings(params: {
  trainings: RequirableTraining[];
  memberDepartmentIds: string[];
  completedTrainingIds: Iterable<string>;
}): { id: string; name: string }[] {
  const completed = new Set(params.completedTrainingIds);
  return requiredTrainingsForMember({
    trainings: params.trainings,
    memberDepartmentIds: params.memberDepartmentIds,
  })
    .filter((training) => !completed.has(training.id))
    .map((training) => ({ id: training.id, name: training.name }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/ehs/engine/applicability.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ehs/engine
git commit -m "feat(ehs): pure applicability engine (required + missing trainings)"
```

---

## Task 3: Catalog service and errors

**Files:**
- Create: `src/modules/ehs/services/errors.ts`
- Create: `src/modules/ehs/services/trainings.ts`
- Test: `src/modules/ehs/services/trainings.test.ts` (authored now; runs in CI)

**Interfaces:**
- Consumes: `prisma` from `@/platform/db`, `recordAudit` from `@/platform/audit`.
- Produces:
  - `class EhsValidationError extends Error`
  - `type EhsTrainingInput = { name: string; description?: string | null; isActive?: boolean; requiredForAll?: boolean }`
  - `createTraining(input: EhsTrainingInput, actorId: string): Promise<EhsTraining>`
  - `updateTraining(id: string, input: EhsTrainingInput, actorId: string): Promise<EhsTraining>`
  - `setTrainingDepartments(trainingId: string, departmentIds: string[], actorId: string): Promise<void>`
  - `type EhsTrainingListRow = { id: string; name: string; isActive: boolean; requiredForAll: boolean; departmentCount: number }`
  - `listTrainings(): Promise<EhsTrainingListRow[]>`
  - `getTrainingForEdit(id: string): Promise<EhsTraining & { departments: { departmentId: string }[] }>`

- [ ] **Step 1: Write `errors.ts`**

```typescript
export class EhsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EhsValidationError";
  }
}
```

- [ ] **Step 2: Write the failing test** (mirrors the Learning `courses` service; runs in CI, not locally against Neon)

```typescript
import { describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { createTraining, listTrainings, setTrainingDepartments } from "./trainings";
import { EhsValidationError } from "./errors";

describe("ehs trainings service", () => {
  it("rejects an empty name", async () => {
    await expect(createTraining({ name: "  " }, "actor1")).rejects.toBeInstanceOf(
      EhsValidationError
    );
  });

  it("creates a training with an auto-incremented position", async () => {
    const created = await createTraining({ name: "Test EHS item" }, "actor1");
    expect(created.position).toBeGreaterThanOrEqual(0);
    const rows = await listTrainings();
    expect(rows.some((r) => r.id === created.id)).toBe(true);
  });

  it("replaces department assignment transactionally", async () => {
    const t = await createTraining({ name: "Scoped item", requiredForAll: false }, "actor1");
    const dept = await prisma.department.findFirstOrThrow();
    await setTrainingDepartments(t.id, [dept.id], "actor1");
    const after = await prisma.ehsTrainingDepartment.findMany({ where: { trainingId: t.id } });
    expect(after.map((d) => d.departmentId)).toEqual([dept.id]);
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `npx vitest run src/modules/ehs/services/trainings.test.ts`
Expected: FAIL (module not found). If it errors on a DB connection instead, that is expected in the worktree; the real run is in CI.

- [ ] **Step 4: Implement `trainings.ts`** (mirror `src/modules/learning/services/courses.ts`)

```typescript
import type { EhsTraining } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { EhsValidationError } from "./errors";

export type EhsTrainingInput = {
  name: string;
  description?: string | null;
  isActive?: boolean;
  requiredForAll?: boolean;
};

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new EhsValidationError("Training name is required.");
  return trimmed;
}

export async function createTraining(
  input: EhsTrainingInput,
  actorId: string
): Promise<EhsTraining> {
  const name = normalizeName(input.name);
  const max = await prisma.ehsTraining.aggregate({ _max: { position: true } });
  const training = await prisma.ehsTraining.create({
    data: {
      name,
      description: input.description ?? null,
      isActive: input.isActive ?? true,
      requiredForAll: input.requiredForAll ?? false,
      position: (max._max.position ?? -1) + 1,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.training_create",
    entityType: "EhsTraining",
    entityId: training.id,
    after: { name: training.name, requiredForAll: training.requiredForAll },
  });
  return training;
}

export async function updateTraining(
  id: string,
  input: EhsTrainingInput,
  actorId: string
): Promise<EhsTraining> {
  const name = normalizeName(input.name);
  const training = await prisma.ehsTraining.update({
    where: { id },
    data: {
      name,
      description: input.description ?? null,
      isActive: input.isActive ?? true,
      requiredForAll: input.requiredForAll ?? false,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.training_update",
    entityType: "EhsTraining",
    entityId: training.id,
    after: {
      name: training.name,
      isActive: training.isActive,
      requiredForAll: training.requiredForAll,
    },
  });
  return training;
}

export async function setTrainingDepartments(
  trainingId: string,
  departmentIds: string[],
  actorId: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.ehsTrainingDepartment.deleteMany({ where: { trainingId } });
    if (departmentIds.length > 0) {
      await tx.ehsTrainingDepartment.createMany({
        data: departmentIds.map((departmentId) => ({ trainingId, departmentId })),
        skipDuplicates: true,
      });
    }
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.training_set_departments",
    entityType: "EhsTraining",
    entityId: trainingId,
    after: { departmentIds },
  });
}

export type EhsTrainingListRow = {
  id: string;
  name: string;
  isActive: boolean;
  requiredForAll: boolean;
  departmentCount: number;
};

export async function listTrainings(): Promise<EhsTrainingListRow[]> {
  const rows = await prisma.ehsTraining.findMany({
    orderBy: { position: "asc" },
    include: { _count: { select: { departments: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isActive: r.isActive,
    requiredForAll: r.requiredForAll,
    departmentCount: r._count.departments,
  }));
}

export async function getTrainingForEdit(id: string) {
  return prisma.ehsTraining.findUniqueOrThrow({
    where: { id },
    include: { departments: { select: { departmentId: true } } },
  });
}
```

- [ ] **Step 5: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors from `src/modules/ehs/**`. Note: if `tsc` reports that `prisma.ehsTraining` does not exist, the shared node_modules Prisma client is stale for this branch (a known worktree hazard); the types are correct against this branch's schema and CI regenerates the client. Confirm the code matches the schema and proceed.

- [ ] **Step 6: Commit**

```bash
git add src/modules/ehs/services/errors.ts src/modules/ehs/services/trainings.ts src/modules/ehs/services/trainings.test.ts
git commit -m "feat(ehs): catalog service (create/update/list/set-departments)"
```

---

## Task 4: Completion service

**Files:**
- Create: `src/modules/ehs/services/completion.ts`
- Test: `src/modules/ehs/services/completion.test.ts` (authored now; runs in CI)

**Interfaces:**
- Consumes: `prisma`, `recordAudit`.
- Produces:
  - `markEhsComplete(personId: string, trainingId: string, actorId: string, completedAt?: Date | null): Promise<void>`
  - `unmarkEhsComplete(personId: string, trainingId: string, actorId: string): Promise<void>`

Row-present means complete. `markEhsComplete` upserts (idempotent), preserving an existing `completedAt` unless a new one is passed. `unmarkEhsComplete` deletes the row. Both record audit.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { markEhsComplete, unmarkEhsComplete } from "./completion";
import { createTraining } from "./trainings";

describe("ehs completion service", () => {
  it("marks and then unmarks completion", async () => {
    const person = await prisma.person.findFirstOrThrow();
    const training = await createTraining({ name: "Completion test item" }, "actor1");

    await markEhsComplete(person.id, training.id, "actor1", new Date("2026-03-01"));
    const row = await prisma.ehsCompletion.findUnique({
      where: { personId_trainingId: { personId: person.id, trainingId: training.id } },
    });
    expect(row?.source).toBe("MANUAL");
    expect(row?.markedById).toBe("actor1");

    await unmarkEhsComplete(person.id, training.id, "actor1");
    const gone = await prisma.ehsCompletion.findUnique({
      where: { personId_trainingId: { personId: person.id, trainingId: training.id } },
    });
    expect(gone).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/modules/ehs/services/completion.test.ts`
Expected: FAIL (module not found). DB-connection failure in the worktree is expected; CI is the gate.

- [ ] **Step 3: Implement `completion.ts`**

```typescript
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";

export async function markEhsComplete(
  personId: string,
  trainingId: string,
  actorId: string,
  completedAt?: Date | null
): Promise<void> {
  await prisma.ehsCompletion.upsert({
    where: { personId_trainingId: { personId, trainingId } },
    create: {
      personId,
      trainingId,
      source: "MANUAL",
      markedById: actorId,
      completedAt: completedAt ?? new Date(),
    },
    update: {
      markedById: actorId,
      markedAt: new Date(),
      ...(completedAt !== undefined ? { completedAt } : {}),
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.completion_mark",
    entityType: "EhsCompletion",
    entityId: `${personId}:${trainingId}`,
    after: { personId, trainingId, completedAt: completedAt ?? null },
  });
}

export async function unmarkEhsComplete(
  personId: string,
  trainingId: string,
  actorId: string
): Promise<void> {
  await prisma.ehsCompletion.deleteMany({ where: { personId, trainingId } });
  await recordAudit({
    actorPersonId: actorId,
    action: "ehs.completion_unmark",
    entityType: "EhsCompletion",
    entityId: `${personId}:${trainingId}`,
    before: { personId, trainingId },
  });
}
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no new errors (see the stale-Prisma-client note in Task 3 Step 5).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ehs/services/completion.ts src/modules/ehs/services/completion.test.ts
git commit -m "feat(ehs): mark/unmark completion with audit"
```

---

## Task 5: Status service (dashboard rows + roster missing-map)

**Files:**
- Create: `src/modules/ehs/services/status.ts`
- Test: `src/modules/ehs/services/status.test.ts` (authored now; runs in CI)

**Interfaces:**
- Consumes: `prisma`, `getActiveTerm` from `@/platform/terms/active-term`, `manageableDepartmentIds` from `@/modules/volunteers/services/compliance`, engine functions from `@/modules/ehs/engine/applicability`.
- Produces:
  - `type EhsCellState = "COMPLETE" | "MISSING" | "NA"`
  - `type EhsDashboardCell = { trainingId: string; state: EhsCellState; completedAt: Date | null }`
  - `type EhsDashboardRow = { personId: string; name: string; departmentCodes: string[]; cells: EhsDashboardCell[] }`
  - `type EhsDashboard = { trainings: { id: string; name: string }[]; rows: EhsDashboardRow[] }`
  - `getEhsDashboard(viewerPersonId: string): Promise<EhsDashboard>`
  - `loadEhsMissingMap(activeTermId: string): Promise<Map<string, string[]>>` (personId -> missing training names; used by the reminder engine)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { getEhsDashboard } from "./status";

describe("getEhsDashboard", () => {
  it("returns active trainings and one row per active-term roster member", async () => {
    const admin = await prisma.person.findFirstOrThrow({
      where: { roleAssignments: { some: {} } },
    });
    const dash = await getEhsDashboard(admin.id);
    expect(Array.isArray(dash.trainings)).toBe(true);
    expect(Array.isArray(dash.rows)).toBe(true);
    for (const row of dash.rows) {
      expect(row.cells.length).toBe(dash.trainings.length);
    }
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/modules/ehs/services/status.test.ts`
Expected: FAIL (module not found). DB-connection failure in the worktree is expected; CI is the gate.

- [ ] **Step 3: Implement `status.ts`**

```typescript
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { manageableDepartmentIds } from "@/modules/volunteers/services/compliance";
import {
  missingTrainings,
  requiredTrainingsForMember,
  type RequirableTraining,
} from "@/modules/ehs/engine/applicability";

export type EhsCellState = "COMPLETE" | "MISSING" | "NA";
export type EhsDashboardCell = {
  trainingId: string;
  state: EhsCellState;
  completedAt: Date | null;
};
export type EhsDashboardRow = {
  personId: string;
  name: string;
  departmentCodes: string[];
  cells: EhsDashboardCell[];
};
export type EhsDashboard = {
  trainings: { id: string; name: string }[];
  rows: EhsDashboardRow[];
};

/** Load the active EHS catalog as RequirableTraining[] (name + department scoping). */
async function loadCatalog(): Promise<RequirableTraining[]> {
  const rows = await prisma.ehsTraining.findMany({
    where: { isActive: true },
    orderBy: { position: "asc" },
    include: { departments: { select: { departmentId: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isActive: r.isActive,
    requiredForAll: r.requiredForAll,
    departmentIds: r.departments.map((d) => d.departmentId),
  }));
}

export async function getEhsDashboard(viewerPersonId: string): Promise<EhsDashboard> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return { trainings: [], rows: [] };

  const deptIds = await manageableDepartmentIds(viewerPersonId);
  if (deptIds.length === 0) return { trainings: [], rows: [] };

  const catalog = await loadCatalog();

  const memberships = await prisma.termMembership.findMany({
    where: { termId: activeTerm.id, departmentId: { in: deptIds }, status: "ACTIVE" },
    include: {
      person: {
        include: {
          ehsCompletions: { select: { trainingId: true, completedAt: true } },
        },
      },
      department: { select: { code: true } },
    },
  });

  // Collapse multi-department memberships to one row per person, unioning departments.
  const byPerson = new Map<
    string,
    { name: string; departmentIds: Set<string>; departmentCodes: Set<string> }
  >();
  const completionByPerson = new Map<string, Map<string, Date | null>>();

  for (const m of memberships) {
    let agg = byPerson.get(m.personId);
    if (!agg) {
      agg = { name: m.person.name, departmentIds: new Set(), departmentCodes: new Set() };
      byPerson.set(m.personId, agg);
    }
    agg.departmentIds.add(m.departmentId);
    agg.departmentCodes.add(m.department.code);
    if (!completionByPerson.has(m.personId)) {
      completionByPerson.set(
        m.personId,
        new Map(m.person.ehsCompletions.map((c) => [c.trainingId, c.completedAt]))
      );
    }
  }

  const rows: EhsDashboardRow[] = [...byPerson.entries()]
    .map(([personId, agg]) => {
      const memberDepartmentIds = [...agg.departmentIds];
      const required = new Set(
        requiredTrainingsForMember({ trainings: catalog, memberDepartmentIds }).map((t) => t.id)
      );
      const completions = completionByPerson.get(personId) ?? new Map();
      const cells: EhsDashboardCell[] = catalog.map((t) => {
        if (!required.has(t.id)) return { trainingId: t.id, state: "NA", completedAt: null };
        const done = completions.has(t.id);
        return {
          trainingId: t.id,
          state: done ? "COMPLETE" : "MISSING",
          completedAt: done ? completions.get(t.id) ?? null : null,
        };
      });
      return {
        personId,
        name: agg.name,
        departmentCodes: [...agg.departmentCodes].sort(),
        cells,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { trainings: catalog.map((t) => ({ id: t.id, name: t.name })), rows };
}

export async function loadEhsMissingMap(activeTermId: string): Promise<Map<string, string[]>> {
  const catalog = await loadCatalog();
  const memberships = await prisma.termMembership.findMany({
    where: { termId: activeTermId, status: "ACTIVE" },
    select: {
      personId: true,
      departmentId: true,
      person: { select: { ehsCompletions: { select: { trainingId: true } } } },
    },
  });

  const deptsByPerson = new Map<string, Set<string>>();
  const completedByPerson = new Map<string, Set<string>>();
  for (const m of memberships) {
    if (!deptsByPerson.has(m.personId)) deptsByPerson.set(m.personId, new Set());
    deptsByPerson.get(m.personId)!.add(m.departmentId);
    if (!completedByPerson.has(m.personId)) {
      completedByPerson.set(
        m.personId,
        new Set(m.person.ehsCompletions.map((c) => c.trainingId))
      );
    }
  }

  const out = new Map<string, string[]>();
  for (const [personId, deptSet] of deptsByPerson) {
    const missing = missingTrainings({
      trainings: catalog,
      memberDepartmentIds: [...deptSet],
      completedTrainingIds: completedByPerson.get(personId) ?? new Set(),
    });
    out.set(personId, missing.map((m) => m.name));
  }
  return out;
}
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no new errors (see the stale-Prisma-client note in Task 3 Step 5). Confirm `manageableDepartmentIds` is exported from `@/modules/volunteers/services/compliance`; if it is not exported, export it there (it is used internally by `departmentCompliance`).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ehs/services/status.ts src/modules/ehs/services/status.test.ts
git commit -m "feat(ehs): status service (dashboard matrix + roster missing-map)"
```

---

## Task 6: Admin dashboard page, toggle actions, and nav

**Files:**
- Create: `src/app/(app)/volunteers/ehs/page.tsx`
- Create: `src/app/(app)/volunteers/ehs/actions.ts`
- Modify: `src/platform/modules/registry.ts` (add nav entries to the `volunteers` module)

**Interfaces:**
- Consumes: `getEhsDashboard` (Task 5), `markEhsComplete` / `unmarkEhsComplete` (Task 4), `requirePermission`.

- [ ] **Step 1: Add nav entries to the `volunteers` module manifest**

In `src/platform/modules/registry.ts`, inside the `volunteers` module's `nav` array, add after the `Master view` entry:

```typescript
    { label: "EHS training", href: "/volunteers/ehs", permission: "volunteers.manage_compliance" },
```

- [ ] **Step 2: Write the toggle actions**

`src/app/(app)/volunteers/ehs/actions.ts`:

```typescript
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { markEhsComplete, unmarkEhsComplete } from "@/modules/ehs/services/completion";

export async function toggleEhsCompletionAction(formData: FormData): Promise<void> {
  const person = await requirePermission("volunteers.manage_compliance");
  const personId = String(formData.get("personId"));
  const trainingId = String(formData.get("trainingId"));
  const nowComplete = formData.get("complete") === "1";
  if (nowComplete) {
    await markEhsComplete(personId, trainingId, person.personId);
  } else {
    await unmarkEhsComplete(personId, trainingId, person.personId);
  }
  revalidatePath("/volunteers/ehs");
}
```

- [ ] **Step 3: Write the dashboard page** (mirror the Learning dashboard table + the volunteers page header)

`src/app/(app)/volunteers/ehs/page.tsx`:

```typescript
import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Table, THead, TH, TR, TD } from "@/components/ui/table";
import { getEhsDashboard } from "@/modules/ehs/services/status";
import { toggleEhsCompletionAction } from "./actions";

export default async function EhsDashboardPage() {
  const viewer = await requirePermission("volunteers.manage_compliance");
  const { trainings, rows } = await getEhsDashboard(viewer.personId);

  return (
    <div>
      <PageHeader
        title="EHS training"
        description="Environmental Health and Safety training completion for your departments."
      />
      <div className="mb-4">
        <Link href="/volunteers/ehs/manage">
          <Button variant="outline" size="sm">Manage trainings</Button>
        </Link>
      </div>

      {trainings.length === 0 ? (
        <p className="text-sm text-subtle-foreground">No active EHS trainings configured.</p>
      ) : (
        <Table>
          <THead>
            <TH>Name</TH>
            <TH>Dept</TH>
            {trainings.map((t) => (
              <TH key={t.id}>{t.name}</TH>
            ))}
          </THead>
          <tbody>
            {rows.map((row) => (
              <TR key={row.personId}>
                <TD>{row.name}</TD>
                <TD>{row.departmentCodes.join(", ")}</TD>
                {row.cells.map((cell) => (
                  <TD key={cell.trainingId} className="text-center">
                    {cell.state === "NA" ? (
                      <span className="text-xs text-subtle-foreground">n/a</span>
                    ) : (
                      <form action={toggleEhsCompletionAction} className="inline">
                        <input type="hidden" name="personId" value={row.personId} />
                        <input type="hidden" name="trainingId" value={cell.trainingId} />
                        <input
                          type="hidden"
                          name="complete"
                          value={cell.state === "COMPLETE" ? "0" : "1"}
                        />
                        <Button
                          type="submit"
                          size="sm"
                          variant={cell.state === "COMPLETE" ? "default" : "outline"}
                        >
                          {cell.state === "COMPLETE" ? "Complete" : "Mark"}
                        </Button>
                      </form>
                    )}
                  </TD>
                ))}
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
```

Note: confirm the exact import paths for `PageHeader`, `Button`, and the `Table` primitives by matching an existing volunteers/learning page (e.g. `src/app/(app)/learning/dashboard/page.tsx` and `src/app/(app)/volunteers/page.tsx`). Use whatever those files import; the names above follow the extracted patterns.

- [ ] **Step 4: Verify build/types**

Run: `npx tsc --noEmit`
Expected: no new errors. Fix any import-path mismatches against the reference pages named in Step 3.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/volunteers/ehs/page.tsx src/app/\(app\)/volunteers/ehs/actions.ts src/platform/modules/registry.ts
git commit -m "feat(ehs): admin dashboard with per-cell toggle + nav entry"
```

---

## Task 7: Catalog management pages

**Files:**
- Create: `src/app/(app)/volunteers/ehs/manage/page.tsx`
- Create: `src/app/(app)/volunteers/ehs/manage/actions.ts`
- Create: `src/app/(app)/volunteers/ehs/manage/[trainingId]/page.tsx`

**Interfaces:**
- Consumes: `listTrainings`, `createTraining`, `updateTraining`, `setTrainingDepartments`, `getTrainingForEdit` (Task 3), `EhsValidationError`, `runAction` from `@/platform/actions`, `requirePermission`, `prisma`.

- [ ] **Step 1: Write the management actions** (use the shared `runAction` wrapper for the create path so `EhsValidationError` becomes an error redirect)

`src/app/(app)/volunteers/ehs/manage/actions.ts`:

```typescript
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { runAction } from "@/platform/actions";
import {
  createTraining,
  updateTraining,
  setTrainingDepartments,
} from "@/modules/ehs/services/trainings";
import { EhsValidationError } from "@/modules/ehs/services/errors";

export async function createTrainingAction(formData: FormData): Promise<void> {
  const person = await requirePermission("volunteers.manage_compliance");
  await runAction({
    work: () => createTraining({ name: String(formData.get("name") ?? "") }, person.personId),
    domainErrors: [EhsValidationError],
    errorRedirect: (msg) => `/volunteers/ehs/manage?error=${encodeURIComponent(msg)}`,
    revalidate: "/volunteers/ehs/manage",
    successRedirect: "/volunteers/ehs/manage",
  });
}

export async function updateTrainingAction(formData: FormData): Promise<void> {
  const person = await requirePermission("volunteers.manage_compliance");
  const id = String(formData.get("trainingId"));
  await runAction({
    work: () =>
      updateTraining(
        id,
        {
          name: String(formData.get("name") ?? ""),
          description: String(formData.get("description") ?? ""),
          isActive: formData.get("isActive") === "on",
          requiredForAll: formData.get("requiredForAll") === "on",
        },
        person.personId
      ),
    domainErrors: [EhsValidationError],
    errorRedirect: (msg) => `/volunteers/ehs/manage/${id}?error=${encodeURIComponent(msg)}`,
    revalidate: `/volunteers/ehs/manage/${id}`,
  });
}

export async function setTrainingDepartmentsAction(formData: FormData): Promise<void> {
  const person = await requirePermission("volunteers.manage_compliance");
  const trainingId = String(formData.get("trainingId"));
  const departmentIds = formData.getAll("departmentIds").map(String);
  await setTrainingDepartments(trainingId, departmentIds, person.personId);
  revalidatePath(`/volunteers/ehs/manage/${trainingId}`);
}
```

- [ ] **Step 2: Write the catalog list page** (mirror `learning/manage/page.tsx`)

`src/app/(app)/volunteers/ehs/manage/page.tsx`:

```typescript
import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { listTrainings } from "@/modules/ehs/services/trainings";
import { createTrainingAction } from "./actions";

export default async function ManageEhsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requirePermission("volunteers.manage_compliance");
  const trainings = await listTrainings();
  const sp = await searchParams;

  return (
    <div>
      <PageHeader title="Manage EHS trainings" description="Add, edit, and scope EHS training requirements." />
      {sp.error && <p className="mb-3 text-sm text-danger-foreground">{decodeURIComponent(sp.error)}</p>}
      <Card className="mb-4">
        <form action={createTrainingAction} className="flex gap-2">
          <Input name="name" placeholder="New EHS training name" required />
          <Button type="submit">Create</Button>
        </form>
      </Card>
      <ul className="space-y-2">
        {trainings.map((t) => (
          <li key={t.id}>
            <Link href={`/volunteers/ehs/manage/${t.id}`}>
              <Card className="flex items-center justify-between">
                <span>{t.name}</span>
                <span className="text-xs text-subtle-foreground">
                  {t.isActive ? "" : "inactive · "}
                  {t.requiredForAll ? "all departments" : `${t.departmentCount} dept(s)`}
                </span>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Write the edit page** (mirror `learning/manage/[courseId]/page.tsx`, minus SCORM upload)

`src/app/(app)/volunteers/ehs/manage/[trainingId]/page.tsx`:

```typescript
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { getTrainingForEdit } from "@/modules/ehs/services/trainings";
import { updateTrainingAction, setTrainingDepartmentsAction } from "../actions";

export default async function EditEhsTrainingPage({
  params,
}: {
  params: Promise<{ trainingId: string }>;
}) {
  await requirePermission("volunteers.manage_compliance");
  const { trainingId } = await params;
  const training = await getTrainingForEdit(trainingId);
  const departments = await prisma.department.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });
  const assigned = new Set(training.departments.map((d) => d.departmentId));

  return (
    <div className="space-y-6">
      <PageHeader title={training.name} description="Edit this EHS training requirement." />

      <form action={updateTrainingAction} className="space-y-3">
        <input type="hidden" name="trainingId" value={training.id} />
        <label className="block text-sm">Name<Input name="name" defaultValue={training.name} required /></label>
        <label className="block text-sm">Description<Textarea name="description" defaultValue={training.description ?? ""} /></label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="isActive" defaultChecked={training.isActive} /> Active
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="requiredForAll" defaultChecked={training.requiredForAll} /> Required for all departments
        </label>
        <Button type="submit">Save training</Button>
      </form>

      <form action={setTrainingDepartmentsAction} className="space-y-3">
        <input type="hidden" name="trainingId" value={training.id} />
        <p className="text-sm text-subtle-foreground">
          When not required for all, choose the departments this training applies to.
        </p>
        <div className="grid grid-cols-2 gap-1">
          {departments.map((d) => (
            <label key={d.id} className="flex items-center gap-2 text-sm">
              <Checkbox name="departmentIds" value={d.id} defaultChecked={assigned.has(d.id)} /> {d.name}
            </label>
          ))}
        </div>
        <Button type="submit">Save departments</Button>
      </form>
    </div>
  );
}
```

Note: confirm primitive import paths (`Textarea`, `Checkbox`, `Card`, danger text class `text-danger-foreground`) against the learning edit page; adopt whatever it uses.

- [ ] **Step 4: Verify build/types**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/volunteers/ehs/manage
git commit -m "feat(ehs): catalog management pages (list, create, edit, scope)"
```

---

## Task 8: My Info read-only EHS panel

**Files:**
- Create: `src/modules/ehs/services/my-ehs.ts`
- Create: `src/modules/my-info/components/ehs-panel.tsx`
- Modify: `src/app/(app)/my-info/page.tsx`

**Interfaces:**
- Consumes: `prisma`, `getActiveTerm`, engine functions.
- Produces:
  - `type MyEhsItem = { id: string; name: string; complete: boolean; completedAt: Date | null }`
  - `getMyEhsStatus(personId: string): Promise<MyEhsItem[]>` (only the person's REQUIRED items, ordered by catalog position)

- [ ] **Step 1: Implement `my-ehs.ts`**

```typescript
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import {
  requiredTrainingsForMember,
  type RequirableTraining,
} from "@/modules/ehs/engine/applicability";

export type MyEhsItem = {
  id: string;
  name: string;
  complete: boolean;
  completedAt: Date | null;
};

export async function getMyEhsStatus(personId: string): Promise<MyEhsItem[]> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return [];

  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId: activeTerm.id, status: "ACTIVE" },
    select: { departmentId: true },
  });
  const memberDepartmentIds = memberships.map((m) => m.departmentId);
  if (memberDepartmentIds.length === 0) return [];

  const catalogRows = await prisma.ehsTraining.findMany({
    where: { isActive: true },
    orderBy: { position: "asc" },
    include: { departments: { select: { departmentId: true } } },
  });
  const catalog: RequirableTraining[] = catalogRows.map((r) => ({
    id: r.id,
    name: r.name,
    isActive: r.isActive,
    requiredForAll: r.requiredForAll,
    departmentIds: r.departments.map((d) => d.departmentId),
  }));

  const required = requiredTrainingsForMember({ trainings: catalog, memberDepartmentIds });
  const completions = new Map(
    (
      await prisma.ehsCompletion.findMany({
        where: { personId, trainingId: { in: required.map((t) => t.id) } },
        select: { trainingId: true, completedAt: true },
      })
    ).map((c) => [c.trainingId, c.completedAt])
  );

  return required.map((t) => ({
    id: t.id,
    name: t.name,
    complete: completions.has(t.id),
    completedAt: completions.get(t.id) ?? null,
  }));
}
```

- [ ] **Step 2: Write the panel component** (mirror `hipaa-panel.tsx` styling)

`src/modules/my-info/components/ehs-panel.tsx`:

```typescript
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/section-header";
import type { MyEhsItem } from "@/modules/ehs/services/my-ehs";

function formatDate(d: Date): string {
  return d.toLocaleDateString();
}

export function EhsPanel({ items }: { items: MyEhsItem[] }) {
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-sm text-subtle-foreground">No EHS trainings are required for you.</p>
      </Card>
    );
  }
  return (
    <Card className="space-y-2">
      <SectionHeader as="h3" className="mb-2">EHS training</SectionHeader>
      <ul className="space-y-1 text-sm">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between">
            <span>
              {item.complete ? "✓ " : "○ "}
              {item.name}
            </span>
            <span className="text-xs text-subtle-foreground">
              {item.complete
                ? item.completedAt
                  ? `completed ${formatDate(item.completedAt)}`
                  : "complete"
                : "still needed"}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
```

- [ ] **Step 3: Wire the panel into My Info**

In `src/app/(app)/my-info/page.tsx`, import the service and component and render a section next to the HIPAA section (around lines 195-204):

```typescript
import { getMyEhsStatus } from "@/modules/ehs/services/my-ehs";
import { EhsPanel } from "@/modules/my-info/components/ehs-panel";

// within the component, alongside the certificates load:
const ehsItems = await getMyEhsStatus(person.personId);

// in the JSX, after the HIPAA Certificate section:
<section>
  <SectionHeader className="mb-4">EHS Training</SectionHeader>
  <EhsPanel items={ehsItems} />
</section>
```

Match the exact `person`/session variable name already used in that file for the signed-in person id.

- [ ] **Step 4: Verify build/types**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/modules/ehs/services/my-ehs.ts src/modules/my-info/components/ehs-panel.tsx src/app/\(app\)/my-info/page.tsx
git commit -m "feat(ehs): read-only EHS panel on My Info"
```

---

## Task 9: Fold EHS gaps into the compliance reminder engine

**Files:**
- Modify: `src/platform/email/reminders.ts`
- Modify: `src/platform/email/templates/compliance.ts`
- Modify: `src/platform/notifications/registry.ts`

**Interfaces:**
- Consumes: `loadEhsMissingMap` (Task 5).
- Behavior change: a person is compliant only when HIPAA is `COMPLIANT` AND they have no missing required EHS items. The existing `ComplianceReminder` state machine, dedup, escalation, and reset are reused unchanged. Reminder and escalation emails enumerate missing EHS items.

- [ ] **Step 1: Read the current engine and template to locate the edit points**

Read `src/platform/email/reminders.ts` (focus lines ~55-247: the per-person compliance branch, the `notify()` call, and `sendEscalations`) and `src/platform/email/templates/compliance.ts` (the `complianceReminderContext` and `complianceEscalationContext` builders and their default bodies). Identify:
- where per-person HIPAA `status` is computed and where the code decides "compliant vs not",
- the active-term id already resolved in the engine (reuse it; do not re-query),
- the object passed to the reminder template context builder.

- [ ] **Step 2: Load the EHS missing-map once per run and combine with HIPAA**

In `runComplianceReminders`, after the active term is resolved and before the per-person loop, add:

```typescript
import { loadEhsMissingMap } from "@/modules/ehs/services/status";

// after activeTerm is known (guard already returns early when null):
const ehsMissingByPerson = await loadEhsMissingMap(activeTerm.id);
```

Then, in the per-person body, replace the single HIPAA compliant check with a combined one:

```typescript
const ehsMissing = ehsMissingByPerson.get(person.id) ?? [];
const isCompliant = status === "COMPLIANT" && ehsMissing.length === 0;
```

Use `isCompliant` wherever the code currently branches on the HIPAA status being compliant (the reset path and the "should we remind" path). Keep `lastStatus` recording the HIPAA `status` string as today; the EHS gap does not need a separate persisted status field.

- [ ] **Step 3: Pass `ehsMissing` into the reminder context**

Where the engine builds the reminder email (via the `compliance-reminder` template context), pass `ehsMissing` through to `complianceReminderContext`. In `src/platform/email/templates/compliance.ts`, extend `ComplianceReminderParams` and `complianceReminderContext`:

```typescript
// add to ComplianceReminderParams:
ehsMissing?: string[];

// in complianceReminderContext(...), add to the returned context:
ehsMissing: params.ehsMissing ?? [],
hasEhsGap: (params.ehsMissing ?? []).length > 0,
```

Keep the existing `showCta`/`statusLine` logic. When HIPAA is COMPLIANT but there is an EHS gap, `statusLine` should read that HIPAA is on file and no HIPAA action is needed (reuse the existing "cert on file, no action" branch). The EHS block below carries the actionable list.

- [ ] **Step 4: Update the reminder email body**

In the `compliance-reminder` default body (Handlebars), add an EHS section after the HIPAA status paragraph:

```handlebars
{{#if hasEhsGap}}
<p>Your EHS training is incomplete. The following item(s) still need to be completed:</p>
<ul>
{{#each ehsMissing}}
  <li>{{this}}</li>
{{/each}}
</ul>
<p>Please complete these through Yale EHS. Reach out to your director if you are unsure how.</p>
{{/if}}
```

Broaden the default subject from HIPAA-specific to cover both, for example: `"[HAVEN] Compliance reminder"`. (DB subject overrides, if any, are preserved by `renderEmail`.)

- [ ] **Step 5: Update the escalation context and body**

In `complianceEscalationContext`, add an EHS summary the directors can act on:

```typescript
// add to ComplianceEscalationParams:
ehsMissing?: string[];

// in the returned context add:
ehsMissing: params.ehsMissing ?? [],
hasEhsGap: (params.ehsMissing ?? []).length > 0,
```

In the engine's `sendEscalations`, pass the volunteer's `ehsMissing` list through. In the `compliance-escalation` default body, add:

```handlebars
{{#if hasEhsGap}}
<p>Outstanding EHS training: {{#each ehsMissing}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}.</p>
{{/if}}
```

Broaden the escalation subject to `"[HAVEN] Volunteer compliance needs attention"`.

- [ ] **Step 6: Update the notification registry labels**

In `src/platform/notifications/registry.ts`, update the two labels so they are no longer HIPAA-specific:

```typescript
{ key: "compliance-reminder", label: "Compliance reminder", defaultChannel: "email" },
{ key: "compliance-escalation", label: "Compliance escalation (directors)", defaultChannel: "email" },
```

Do not change the keys (existing settings/overrides key on them).

- [ ] **Step 7: Add a pure test for the combined-compliance decision**

Because the engine itself is DB-backed, extract the tiny decision into a pure helper and test it locally. Add to `src/modules/ehs/engine/applicability.ts`:

```typescript
/** A person is fully compliant only when HIPAA is COMPLIANT and no required EHS item is missing. */
export function isFullyCompliant(params: {
  hipaaStatus: string;
  ehsMissingCount: number;
}): boolean {
  return params.hipaaStatus === "COMPLIANT" && params.ehsMissingCount === 0;
}
```

Add to `src/modules/ehs/engine/applicability.test.ts`:

```typescript
import { isFullyCompliant } from "./applicability";

describe("isFullyCompliant", () => {
  it("is true only when HIPAA compliant and no EHS gap", () => {
    expect(isFullyCompliant({ hipaaStatus: "COMPLIANT", ehsMissingCount: 0 })).toBe(true);
    expect(isFullyCompliant({ hipaaStatus: "COMPLIANT", ehsMissingCount: 2 })).toBe(false);
    expect(isFullyCompliant({ hipaaStatus: "EXPIRED", ehsMissingCount: 0 })).toBe(false);
  });
});
```

Use `isFullyCompliant({ hipaaStatus: status, ehsMissingCount: ehsMissing.length })` in the engine (Step 2) instead of the inline boolean, so the decision is the tested helper.

- [ ] **Step 8: Run the pure test**

Run: `npx vitest run src/modules/ehs/engine/applicability.test.ts`
Expected: PASS (now includes the `isFullyCompliant` cases).

- [ ] **Step 9: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 10: Commit**

```bash
git add src/platform/email/reminders.ts src/platform/email/templates/compliance.ts src/platform/notifications/registry.ts src/modules/ehs/engine/applicability.ts src/modules/ehs/engine/applicability.test.ts
git commit -m "feat(ehs): fold EHS gaps into compliance reminders + escalation"
```

---

## Task 10: One-time read-only Airtable seed import

**Files:**
- Modify: `src/platform/airtable/fields.ts` (add EHS field ids + Compliance table id)
- Create: `src/platform/airtable/import/ehs.ts`
- Create: `scripts/import-ehs.ts`
- Test: `src/platform/airtable/import/ehs.test.ts` (authored now; runs in CI)

**Interfaces:**
- Consumes: `AirtableReader` (`listAll(baseId, tableId)`) from `@/platform/airtable/import/importer`, `prisma`, `recordAudit`.
- Produces: `backfillEhsCompletions(reader, options: { baseId: string; complianceTableId: string; dryRun: boolean }): Promise<EhsBackfillReport>` where `EhsBackfillReport = { imported: number; skippedExisting: number; unmatchedPeople: number; unknownTrainings: string[] }`.

The Compliance table (`tblxmEYGZ1ZKqSeK4`) holds the 7 EHS checkboxes. Each row links to an All People record via the "Names" field (`fldcaF7NQu6JObuq6`), and that linked record id equals `Person.airtableRecordId`. The Compliance table lives in the same base as the People import (`config.HAVEN_MGMT_BASE_ID`); confirm this equals `appkxTQ19GmaHgW1O` and use that base id.

- [ ] **Step 1: Add field constants**

In `src/platform/airtable/fields.ts`, add:

```typescript
/** Compliance table (tblxmEYGZ1ZKqSeK4) EHS checkbox fields, keyed by field id,
 *  mapped to the seeded EhsTraining.name they correspond to. */
export const COMPLIANCE_TABLE_ID = "tblxmEYGZ1ZKqSeK4";
export const COMPLIANCE_NAMES_LINK_FIELD = "fldcaF7NQu6JObuq6";
export const EHS_CHECKBOX_FIELDS: { fieldId: string; trainingName: string }[] = [
  { fieldId: "fld3gfbuD5rASyD8Z", trainingName: "Added to EHS?" },
  { fieldId: "fldQgdujeCMk5dVVH", trainingName: "Chemical - Hazard Communication" },
  { fieldId: "fldWwugy9nikSiLtZ", trainingName: "Biological - TB Awareness" },
  { fieldId: "fldZ3NCYwqVTCXBs7", trainingName: "BBP Clinical" },
  { fieldId: "fldm7ZbNyYVf07VSp", trainingName: "BBP Student" },
  { fieldId: "fld8KiByAuWEUKnoj", trainingName: "TB Baseline Screening" },
  { fieldId: "fld56ALUQbZUfCpWi", trainingName: "Physical Safety - Respiration" },
];
```

- [ ] **Step 2: Write the failing test** (uses a fake reader; the DB parts run in CI)

```typescript
import { describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { backfillEhsCompletions } from "./ehs";
import { COMPLIANCE_TABLE_ID } from "@/platform/airtable/fields";

const fakeReader = {
  async listAll() {
    return [
      {
        id: "recCompliance1",
        fields: {
          fldcaF7NQu6JObuq6: ["recPersonAirtable1"],
          fld3gfbuD5rASyD8Z: true, // Added to EHS?
          fldQgdujeCMk5dVVH: false,
        },
      },
    ];
  },
};

describe("backfillEhsCompletions", () => {
  it("dry-run reports without writing", async () => {
    const report = await backfillEhsCompletions(fakeReader, {
      baseId: "appkxTQ19GmaHgW1O",
      complianceTableId: COMPLIANCE_TABLE_ID,
      dryRun: true,
    });
    expect(report.imported + report.unmatchedPeople).toBeGreaterThanOrEqual(0);
    const wrote = await prisma.ehsCompletion.count({ where: { source: "IMPORT" } });
    expect(wrote).toBe(0);
  });
});
```

- [ ] **Step 3: Run to confirm it fails**

Run: `npx vitest run src/platform/airtable/import/ehs.test.ts`
Expected: FAIL (module not found). DB errors in the worktree are expected; CI is the gate.

- [ ] **Step 4: Implement `ehs.ts`** (mirror `backfillCertificates` matching + dry-run)

```typescript
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import type { AirtableReader } from "./importer";
import {
  COMPLIANCE_NAMES_LINK_FIELD,
  EHS_CHECKBOX_FIELDS,
} from "@/platform/airtable/fields";

export type EhsBackfillReport = {
  imported: number;
  skippedExisting: number;
  unmatchedPeople: number;
  unknownTrainings: string[];
};

export async function backfillEhsCompletions(
  reader: AirtableReader,
  options: { baseId: string; complianceTableId: string; dryRun: boolean }
): Promise<EhsBackfillReport> {
  const report: EhsBackfillReport = {
    imported: 0,
    skippedExisting: 0,
    unmatchedPeople: 0,
    unknownTrainings: [],
  };

  // Resolve training names -> ids once.
  const trainings = await prisma.ehsTraining.findMany({ select: { id: true, name: true } });
  const idByName = new Map(trainings.map((t) => [t.name, t.id]));
  for (const f of EHS_CHECKBOX_FIELDS) {
    if (!idByName.has(f.trainingName)) report.unknownTrainings.push(f.trainingName);
  }

  const records = await reader.listAll(options.baseId, options.complianceTableId);

  for (const record of records) {
    const link = record.fields[COMPLIANCE_NAMES_LINK_FIELD];
    const linkedId = Array.isArray(link) && link.length > 0 ? String(link[0]) : null;
    if (!linkedId) {
      report.unmatchedPeople++;
      continue;
    }
    const person = await prisma.person.findUnique({
      where: { airtableRecordId: linkedId },
      select: { id: true },
    });
    if (!person) {
      report.unmatchedPeople++;
      continue;
    }

    for (const field of EHS_CHECKBOX_FIELDS) {
      if (record.fields[field.fieldId] !== true) continue;
      const trainingId = idByName.get(field.trainingName);
      if (!trainingId) continue;

      const existing = await prisma.ehsCompletion.findUnique({
        where: { personId_trainingId: { personId: person.id, trainingId } },
        select: { id: true },
      });
      if (existing) {
        report.skippedExisting++;
        continue;
      }
      if (options.dryRun) {
        report.imported++;
        continue;
      }
      const created = await prisma.ehsCompletion.create({
        data: {
          personId: person.id,
          trainingId,
          source: "IMPORT",
          completedAt: null,
          markedById: null,
        },
      });
      await recordAudit({
        actorPersonId: null,
        action: "ehs.completion_import",
        entityType: "EhsCompletion",
        entityId: created.id,
        after: { personId: person.id, trainingId, source: "IMPORT" },
      });
      report.imported++;
    }
  }

  return report;
}
```

- [ ] **Step 5: Write the runner script** (mirror `scripts/import-airtable.ts`, dry-run by default)

`scripts/import-ehs.ts`:

```typescript
// One-time read-only backfill of EHS completion from the Airtable Compliance table.
//   npx tsx --env-file=.env scripts/import-ehs.ts          (dry run)
//   npx tsx --env-file=.env scripts/import-ehs.ts --apply  (write)

import { config } from "@/platform/config";
import { AirtableClient } from "@/platform/airtable/client";
import { backfillEhsCompletions } from "@/platform/airtable/import/ehs";
import { COMPLIANCE_TABLE_ID } from "@/platform/airtable/fields";

async function main() {
  if (!config.AIRTABLE_PAT) {
    console.error("AIRTABLE_PAT is not set in .env; the importer needs read access.");
    process.exit(1);
  }
  const dryRun = !process.argv.includes("--apply");
  const client = new AirtableClient(config.AIRTABLE_PAT);
  const report = await backfillEhsCompletions(client, {
    baseId: config.HAVEN_MGMT_BASE_ID,
    complianceTableId: COMPLIANCE_TABLE_ID,
    dryRun,
  });
  console.log(JSON.stringify(report, null, 2));
  if (dryRun) console.log("\nDry run only. Re-run with --apply to write.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 6: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no new errors. Confirm `config.HAVEN_MGMT_BASE_ID` resolves to base `appkxTQ19GmaHgW1O`; if the Compliance table lives in a different base than `HAVEN_MGMT_BASE_ID`, add a dedicated config value for it instead.

- [ ] **Step 7: Commit**

```bash
git add src/platform/airtable/fields.ts src/platform/airtable/import/ehs.ts src/platform/airtable/import/ehs.test.ts scripts/import-ehs.ts
git commit -m "feat(ehs): one-time read-only Airtable seed import for EHS completion"
```

---

## Final verification (in CI / after merge)

- [ ] CI runs the migration on the preview DB and the full DB-backed vitest + Playwright suites.
- [ ] Dry-run the seed import (`npx tsx --env-file=.env scripts/import-ehs.ts`) against production credentials, review the report, then `--apply` once.
- [ ] Configure department scoping for BBP Clinical / BBP Student / TB Baseline / Respiration on `/volunteers/ehs/manage` (they ship unassigned).

---

## Self-review

- **Spec coverage:** Data model (Task 1), applicability engine (Task 2), admin dashboard + manage (Tasks 3-7), My Info panel (Task 8), reminder integration (Task 9), Airtable seed import (Task 10), testing split pure-local vs CI (throughout). All spec sections map to a task.
- **Type consistency:** `RequirableTraining` / `requiredTrainingsForMember` / `missingTrainings` (Task 2) are consumed identically in Tasks 5, 8, 9. `getEhsDashboard` / `loadEhsMissingMap` (Task 5) are consumed in Tasks 6 and 9. `markEhsComplete` / `unmarkEhsComplete` (Task 4) are consumed in Task 6. Catalog service signatures (Task 3) are consumed in Task 7. `EhsCompletionSource` values `MANUAL`/`IMPORT` used consistently (Tasks 1, 4, 10).
- **Placeholder scan:** No TBD/TODO. Where an exact import path or template body could not be captured verbatim, the step names the reference file to match and gives the exact code to add.
