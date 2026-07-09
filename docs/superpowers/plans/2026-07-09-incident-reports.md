# Incident Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move disciplinary handling out of the Volunteers module into a new open **Incident Reports** module where anyone can file a Professional Standards Incident Report about anyone, reviewers (renamed central permission) triage reports, and a director filing about a volunteer can request a strike that a reviewer approves or declines.

**Architecture:** A new `IncidentReport` model captures the 10-section form and feeds a reviewer queue. The existing `DisciplinaryAction` (strikes) model is kept unchanged except for a nullable `reportId` back-link; strike-count semantics are untouched. The strikes ledger page and service move verbatim from `volunteers` into `incidents` with only permission-string and URL changes. The single bridge: an approved strike request creates and links a `DisciplinaryAction`; an anonymous report yields a `confidential` strike so directors cannot see it.

**Tech Stack:** Next.js App Router (server components, server actions), Prisma + Postgres (Neon in prod), TypeScript, Vercel Blob for attachments, the in-house `notify()` dispatcher + editable email-template engine, Vitest (DB-backed, CI-gated) and Playwright.

## Global Constraints

Every task's requirements implicitly include this section.

- **No em-dashes** anywhere in copy, comments, or docs. Use hyphens, commas, or parentheses.
- **"HAVEN Hub" is two words** in prose and UI; identifiers stay `havenhub` / `incidents`.
- **Never run vitest or `prisma migrate` against the repo `.env`** - it points every DB URL (including `TEST_DATABASE_URL`) at the shared Neon prod DB, and a stray `resetDb`/`migrate` would wipe it. DB-backed vitest also cannot run reliably in a worktree (shared stale Prisma client). **CI is the DB-test gate.** Locally, only typecheck/lint and reason about tests; do not execute DB-backed suites here.
- **Scalar list `String[] @default([])`** must emit `DEFAULT ARRAY[]::TEXT[]` in the migration, and every new migration must be hand-trimmed to only the intended statements (Prisma folds pre-existing repo drift such as `subcommitteeRanking DROP DEFAULT` and `VolunteerTraining -> Training` renames into new migrations).
- **Run `prisma migrate status` before any Neon deploy.** Vercel previews share the prod DB, so a branch behind a migration crashes P2021 at runtime.
- **Grant/role changes need an explicit backfill migration** - production runs `migrate deploy`, not the seed, so `SYSTEM_ROLES` edits do not reach prod without a data migration.
- **The module registry (`src/platform/modules/registry.ts`) is the single wiring point**: the RBAC editor's valid-permission set is built from `MODULES[*].permissions`, so every new permission string must appear there or it is unassignable and throws `UnknownPermissionError`.
- **`ModuleNav` sub-tabs are filtered by each item's `permission`**, which must mirror the destination page's `requirePermission`, or a visible tab dead-ends at `/no-access`.
- **`notify()` email templates use the subset engine only**: `{{#if}}`, `{{var}}`, `{{{raw}}}`. No `{{#each}}` (it renders empty silently); precompute any lists into strings.
- **Use neutral status styling** (the `Badge` chip + status dot, `Alert` with icon + neutral text); no pastel tinted fills. Reuse existing primitives (Card, Badge, Alert, Modal, PageHeader, Table, Field/Input/Textarea/Select/Checkbox, Pagination, ConfirmButton, FormActions).
- **Worktree paths:** this plan executes in the worktree at `/Users/jcarney/Documents/Code-Projects/HAVENHub/.claude/worktrees/feat+incident-reports`. All Read/Edit/Write use worktree-rooted absolute paths.

## File Structure

**Create:**
- `prisma/migrations/<timestamp>_incident_reports/migration.sql` - additive tables/enums + `DisciplinaryAction.reportId`.
- `prisma/migrations/<timestamp>_incidents_permission_backfill/migration.sql` - rename `volunteers.issue_disciplinary` grants to `incidents.manage`, add `incidents.view_strikes`.
- `src/modules/incidents/services/report.ts` - report lifecycle service + `CONCERN_TYPES`, typed errors, submit/list/get/review/decideStrike.
- `src/modules/incidents/services/report.test.ts` - DB-backed unit tests.
- `src/modules/incidents/services/disciplinary.ts` - MOVED from `src/modules/volunteers/services/disciplinary.ts`, permission strings updated.
- `src/modules/incidents/services/disciplinary.test.ts` - MOVED alongside.
- `src/app/(app)/incidents/layout.tsx` - module shell (nav).
- `src/app/(app)/incidents/page.tsx` - "Report a concern" form.
- `src/app/(app)/incidents/actions.ts` - server actions (submit, review, decide strike).
- `src/app/(app)/incidents/mine/page.tsx` - "My reports".
- `src/app/(app)/incidents/[id]/page.tsx` - report detail (owner or reviewer).
- `src/app/(app)/incidents/review/page.tsx` - reviewer queue + triage.
- `src/app/(app)/incidents/strikes/page.tsx` - MOVED strikes ledger, gates/URLs updated.
- `src/app/api/incidents/attachments/[id]/route.ts` - authorized attachment download.
- `e2e/incidents.spec.ts` - e2e for report -> review -> resolve and strike request -> approve.

**Modify:**
- `prisma/schema.prisma` - new models/enums, `DisciplinaryAction.reportId`, `Person` back-relations.
- `src/platform/modules/registry.ts` - add the `incidents` module; remove the Disciplinary nav item and `volunteers.issue_disciplinary` from `volunteers`; update the `volunteers` description.
- `src/platform/rbac/system-roles.ts` - rename the disciplinary grant to `incidents.manage`, add `incidents.view_strikes` to Director + Volunteer Operations Manager.
- `src/platform/notifications/registry.ts` - add four `incidents.*` notification types.
- `e2e/volunteers.spec.ts` - remove the disciplinary test blocks.
- Email-template seed/defaults - add default templates for the four new notification descriptors (location confirmed in Task list below).

**Delete:**
- `src/app/(app)/volunteers/disciplinary/page.tsx` (moved to `incidents/strikes`).
- `src/modules/volunteers/services/disciplinary.ts` and `disciplinary.test.ts` (moved to `incidents`).

---

## Testing note (applies to every task)

DB-backed vitest **cannot run against the repo `.env`** (shared Neon) and is unreliable in a worktree (stale shared Prisma client). For each service task: write the test file, then verify locally with `npm run typecheck` and `npm run lint`; the DB-backed `npm test` run is the **CI gate** (or run it against a throwaway local Postgres via `TEST_DATABASE_URL`, never the repo `.env`). Do **not** run `npm run db:migrate` against the repo `.env`; hand-author migration SQL and let CI/deploy apply it (or apply against a throwaway local Postgres). "Expected: FAIL/PASS" below describes the CI/local-Postgres outcome.

**Prisma client regeneration:** after Task 1 edits `schema.prisma`, the new types (`IncidentReport`, `PatientImpact`, `IncidentReportStatus`, `DisciplinaryAction.reportId`, etc.) do not exist on the generated client until `npx prisma generate` runs, so `npm run typecheck` will fail on the new symbols until then. Run `npx prisma generate` after Task 1 (it only reads `schema.prisma` and rewrites the TS client - it does not touch any database). Be aware this mutates the **shared** `node_modules` Prisma client used by other worktrees on older branches (per the stale-client constraint); CI regenerates cleanly from this branch's schema, so treat any cross-worktree type noise as environmental, not a regression.

---

# Phase 1 - Data model and migration

### Task 1: Add the Prisma models, enums, and the DisciplinaryAction link

**Files:**
- Modify: `prisma/schema.prisma` (add enums, `IncidentReport`, `IncidentReportAttachment`; add `reportId` to `DisciplinaryAction`; add five `Person` back-relations).

**Interfaces:**
- Produces: models `IncidentReport`, `IncidentReportAttachment`; enums `PatientImpact`, `IssueNature`, `PriorOccurrence`, `IncidentReportStatus`, `StrikeDecision`; `DisciplinaryAction.reportId` (unique) + relation `incidentReportStrikeAction`.

- [ ] **Step 1: Add the five enums** near the existing enum blocks (after `CertificateSource`, matching the `enum Name { VALUE ... }` style):

```prisma
enum PatientImpact {
  YES
  NO
  UNSURE
}

enum IssueNature {
  SYSTEM
  INDIVIDUAL
  BOTH_UNSURE
}

enum PriorOccurrence {
  YES
  NO
  UNSURE
}

enum IncidentReportStatus {
  SUBMITTED
  UNDER_REVIEW
  RESOLVED
  DISMISSED
}

enum StrikeDecision {
  PENDING
  APPROVED
  DECLINED
}
```

- [ ] **Step 2: Add the two models** (place beside `DisciplinaryAction`):

```prisma
/// A Professional Standards Incident Report. Any signed-in person may file one
/// about anyone; reviewers (incidents.manage) triage them. A director filing
/// about a volunteer they manage may request a strike, which a reviewer approves
/// (issuing a linked DisciplinaryAction) or declines.
model IncidentReport {
  id                    String               @id @default(cuid())
  number                Int                  @unique @default(autoincrement())
  reporterId            String
  anonymous             Boolean              @default(false)
  concernTypes          String[]             @default([])
  description           String               @db.Text
  occurredAt            DateTime?
  setting               String?
  subjectPersonId       String?
  subjectDescription    String?
  patientImpact         PatientImpact?
  patientImpactDetail   String?
  immediateRisk         Boolean              @default(false)
  issueNature           IssueNature?
  priorOccurrence       PriorOccurrence?
  priorOccurrenceDetail String?
  status                IncidentReportStatus @default(SUBMITTED)
  reviewNotes           String?              @db.Text
  resolvedById          String?
  resolvedAt            DateTime?
  strikeDecision        StrikeDecision?
  strikeDecidedById     String?
  strikeDecidedAt       DateTime?
  createdAt             DateTime             @default(now())
  updatedAt             DateTime             @updatedAt
  /// The person who filed the report. Restrict: the reporter is load-bearing for the record.
  reporter              Person               @relation("incidentReportReporter", fields: [reporterId], references: [id], onDelete: Restrict)
  /// The individual of concern, when a specific person is identified. SetNull: a report survives its subject being deleted (subjectDescription remains).
  subject               Person?              @relation("incidentReportSubject", fields: [subjectPersonId], references: [id], onDelete: SetNull)
  /// The reviewer who resolved or dismissed the report.
  resolvedBy            Person?              @relation("incidentReportResolvedBy", fields: [resolvedById], references: [id], onDelete: Restrict)
  /// The reviewer who decided the strike request.
  strikeDecidedBy       Person?              @relation("incidentReportStrikeDecidedBy", fields: [strikeDecidedById], references: [id], onDelete: Restrict)
  /// The strike created when a strike request is approved (FK lives on DisciplinaryAction.reportId).
  strikeAction          DisciplinaryAction?  @relation("incidentReportStrikeAction")
  attachments           IncidentReportAttachment[]

  @@index([status])
  @@index([reporterId])
  @@index([subjectPersonId])
}

/// A file attached to an incident report. Bytes live in storage under storedName
/// (src/platform/storage.ts putObject/getObject); this row is the metadata +
/// ownership record. Mirrors the HipaaCertificate storage-key convention.
model IncidentReportAttachment {
  id           String         @id @default(cuid())
  reportId     String
  fileName     String
  storedName   String
  size         Int
  mimeType     String
  uploadedById String
  createdAt    DateTime       @default(now())
  report       IncidentReport @relation(fields: [reportId], references: [id], onDelete: Cascade)
  uploadedBy   Person         @relation("incidentAttachmentUploadedBy", fields: [uploadedById], references: [id], onDelete: Restrict)

  @@index([reportId])
}
```

- [ ] **Step 3: Add the back-link on `DisciplinaryAction`** (inside the existing model, after `createdAt`, before the `person`/`issuedBy` relation lines). This single FK is the ONLY link between the two records (no `strikeActionId` column on `IncidentReport`):

```prisma
  /// When this strike was issued by approving an incident report's strike request.
  reportId        String?  @unique
  report          IncidentReport? @relation("incidentReportStrikeAction", fields: [reportId], references: [id], onDelete: SetNull)
```

- [ ] **Step 4: Add the five back-relations on `Person`** (beside `disciplinaryActionsIssued`):

```prisma
  /// Incident reports this person filed.
  incidentReportsFiled        IncidentReport[]           @relation("incidentReportReporter")
  /// Incident reports naming this person as the subject.
  incidentReportsAbout        IncidentReport[]           @relation("incidentReportSubject")
  /// Incident reports this person resolved or dismissed.
  incidentReportsResolved     IncidentReport[]           @relation("incidentReportResolvedBy")
  /// Incident-report strike decisions this person made.
  incidentStrikeDecisions     IncidentReport[]           @relation("incidentReportStrikeDecidedBy")
  /// Incident-report attachments this person uploaded.
  incidentAttachmentsUploaded IncidentReportAttachment[] @relation("incidentAttachmentUploadedBy")
```

- [ ] **Step 5: Validate the schema**

Run: `npx prisma validate`
Expected: "The schema at prisma/schema.prisma is valid."

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(incidents): add IncidentReport schema + DisciplinaryAction link"
```

---

### Task 2: Author the additive schema migration

**Files:**
- Create: `prisma/migrations/20260709120000_incident_reports/migration.sql`

**Interfaces:**
- Consumes: Task 1 schema.
- Produces: the tables/enums/columns in a deploy-safe migration. (Hand-authored, NOT generated against the repo `.env`; if you generate it against a throwaway local Postgres, hand-trim any pre-existing drift such as `subcommitteeRanking DROP DEFAULT` or `Training` renames so only the statements below remain.)

- [ ] **Step 1: Write the migration SQL** (note `concernTypes` uses `DEFAULT ARRAY[]::TEXT[]`):

```sql
-- CreateEnum
CREATE TYPE "PatientImpact" AS ENUM ('YES', 'NO', 'UNSURE');
CREATE TYPE "IssueNature" AS ENUM ('SYSTEM', 'INDIVIDUAL', 'BOTH_UNSURE');
CREATE TYPE "PriorOccurrence" AS ENUM ('YES', 'NO', 'UNSURE');
CREATE TYPE "IncidentReportStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED');
CREATE TYPE "StrikeDecision" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

-- CreateTable
CREATE TABLE "IncidentReport" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "reporterId" TEXT NOT NULL,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "concernTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "description" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "setting" TEXT,
    "subjectPersonId" TEXT,
    "subjectDescription" TEXT,
    "patientImpact" "PatientImpact",
    "patientImpactDetail" TEXT,
    "immediateRisk" BOOLEAN NOT NULL DEFAULT false,
    "issueNature" "IssueNature",
    "priorOccurrence" "PriorOccurrence",
    "priorOccurrenceDetail" TEXT,
    "status" "IncidentReportStatus" NOT NULL DEFAULT 'SUBMITTED',
    "reviewNotes" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "strikeDecision" "StrikeDecision",
    "strikeDecidedById" TEXT,
    "strikeDecidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IncidentReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentReportAttachment" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IncidentReportAttachment_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "DisciplinaryAction" ADD COLUMN "reportId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "IncidentReport_number_key" ON "IncidentReport"("number");
CREATE INDEX "IncidentReport_status_idx" ON "IncidentReport"("status");
CREATE INDEX "IncidentReport_reporterId_idx" ON "IncidentReport"("reporterId");
CREATE INDEX "IncidentReport_subjectPersonId_idx" ON "IncidentReport"("subjectPersonId");
CREATE INDEX "IncidentReportAttachment_reportId_idx" ON "IncidentReportAttachment"("reportId");
CREATE UNIQUE INDEX "DisciplinaryAction_reportId_key" ON "DisciplinaryAction"("reportId");

-- AddForeignKey
ALTER TABLE "IncidentReport" ADD CONSTRAINT "IncidentReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IncidentReport" ADD CONSTRAINT "IncidentReport_subjectPersonId_fkey" FOREIGN KEY ("subjectPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IncidentReport" ADD CONSTRAINT "IncidentReport_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IncidentReport" ADD CONSTRAINT "IncidentReport_strikeDecidedById_fkey" FOREIGN KEY ("strikeDecidedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IncidentReportAttachment" ADD CONSTRAINT "IncidentReportAttachment_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "IncidentReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncidentReportAttachment" ADD CONSTRAINT "IncidentReportAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DisciplinaryAction" ADD CONSTRAINT "DisciplinaryAction_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "IncidentReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 2: Sanity-check migration status** (against a throwaway local Postgres only, or defer to CI)

Run: `npx prisma migrate status` (throwaway DB) OR skip locally.
Expected: the new migration is listed as pending/applied without drift.

- [ ] **Step 3: Commit**

```bash
git add prisma/migrations/20260709120000_incident_reports/migration.sql
git commit -m "feat(incidents): additive migration for IncidentReport tables"
```

---

# Phase 2 - Module registration, roles, and RBAC backfill

### Task 3: Register the incidents module and strip disciplinary from volunteers

**Files:**
- Modify: `src/platform/modules/registry.ts`

**Interfaces:**
- Produces: module id `incidents` with permissions `incidents.manage`, `incidents.view_strikes`; removes `volunteers.issue_disciplinary` and the Disciplinary nav item from `volunteers`.

- [ ] **Step 1: Add an icon import.** Change the lucide import to include `ShieldAlert`:

```ts
import {
  CalendarDays,
  ClipboardList,
  GraduationCap,
  HeartHandshake,
  MessagesSquare,
  Send,
  Settings,
  ShieldAlert,
  Stethoscope,
  UserRoundPen,
  Users,
} from "lucide-react";
```

- [ ] **Step 2: Edit the `volunteers` manifest** - update the description, remove `"volunteers.issue_disciplinary"` from `permissions`, and remove the `{ label: "Disciplinary", ... }` nav item:

```ts
  {
    id: "volunteers",
    title: "Volunteer Management",
    description: "Compliance, rosters, offboarding, Epic requests",
    icon: Users,
    accessPermission: "volunteers.view",
    permissions: [
      "volunteers.view",
      "volunteers.manage_compliance",
      "volunteers.manage_offboarding",
      "volunteers.manage_epic",
      "volunteers.verify_spanish",
    ],
    status: "active",
    nav: [
      { label: "Compliance", href: "/volunteers" },
      { label: "Master view", href: "/volunteers/master", permission: "volunteers.manage_compliance" },
      { label: "EHS training", href: "/volunteers/ehs", permission: "volunteers.manage_compliance" },
      { label: "Spanish review", href: "/volunteers/spanish-review", permission: "volunteers.verify_spanish" },
      { label: "Offboarding", href: "/volunteers/offboarding" },
      { label: "Epic requests", href: "/volunteers/epic", permission: "volunteers.manage_epic" },
    ],
  },
```

- [ ] **Step 3: Add the `incidents` manifest** to the `MODULES` array (place it after `volunteers`):

```ts
  {
    id: "incidents",
    title: "Incident Reports",
    description: "Report a professional-standards concern; review reports and manage strikes",
    icon: ShieldAlert,
    // No accessPermission: open to any signed-in matched person so anyone can file a report.
    permissions: ["incidents.manage", "incidents.view_strikes"],
    status: "active",
    nav: [
      { label: "Report a concern", href: "/incidents" },
      { label: "My reports", href: "/incidents/mine" },
      { label: "Review", href: "/incidents/review", permission: "incidents.manage" },
      { label: "Strikes", href: "/incidents/strikes", permission: "incidents.view_strikes" },
    ],
  },
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 5: Commit**

```bash
git add src/platform/modules/registry.ts
git commit -m "feat(incidents): register module, remove disciplinary from volunteers"
```

---

### Task 4: Update system roles

**Files:**
- Modify: `src/platform/rbac/system-roles.ts`

**Interfaces:**
- Produces: `Director` role grants `incidents.view_strikes`; `Volunteer Operations Manager` grants `incidents.manage` + `incidents.view_strikes` in place of `volunteers.issue_disciplinary`.

- [ ] **Step 1: Edit the Director role** to add `incidents.view_strikes`:

```ts
  {
    name: "Director",
    description: "Baseline access for current-term directors",
    grants: ["schedule.view", "volunteers.view", "my-info.access", "learning.access", "incidents.view_strikes"],
  },
```

- [ ] **Step 2: Edit the Volunteer Operations Manager role** (rename the grant, add the read grant, update the description):

```ts
  {
    name: "Volunteer Operations Manager",
    description: "Offboarding, Epic requests, and incident reports across the clinic",
    grants: ["volunteers.view", "volunteers.manage_offboarding", "volunteers.manage_epic", "incidents.manage", "incidents.view_strikes", "admin.manage_roster"],
  },
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/platform/rbac/system-roles.ts
git commit -m "feat(incidents): system roles grant incidents.manage + view_strikes"
```

---

### Task 5: RBAC backfill migration (production grant rename)

**Files:**
- Create: `prisma/migrations/20260709120500_incidents_permission_backfill/migration.sql`

**Interfaces:**
- Consumes: existing `RoleGrant` rows for `volunteers.issue_disciplinary`.
- Produces: those rows renamed to `incidents.manage`; `incidents.view_strikes` added to every role holding `incidents.manage` and to the `Director` system role. (Prod runs `migrate deploy`, not the seed, so this is required; Task 4 keeps fresh-seed DBs in sync.)

- [ ] **Step 1: Write the migration SQL:**

```sql
-- Incident Reports: disciplinary moves out of Volunteer Management. The central
-- "volunteers.issue_disciplinary" permission becomes "incidents.manage" (review
-- reports + issue/approve/delete strikes), and a new read-only
-- "incidents.view_strikes" is granted to reviewers and to directors so directors
-- keep their department strikes view. Mirrors src/platform/rbac/system-roles.ts,
-- which provisions the same grants for fresh databases via the seed.

-- 1. Rename the central grant in place. No role holds incidents.manage yet, so a
--    plain UPDATE cannot violate the (roleId, permission) unique index.
UPDATE "RoleGrant"
SET "permission" = 'incidents.manage'
WHERE "permission" = 'volunteers.issue_disciplinary';

-- 2. Every role that now has incidents.manage also gets incidents.view_strikes.
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, rg."roleId", 'incidents.view_strikes'
FROM "RoleGrant" rg
WHERE rg."permission" = 'incidents.manage'
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 3. The Director system role gets incidents.view_strikes so directors keep the
--    read-only department strikes view they had via the disciplinary page.
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, r."id", 'incidents.view_strikes'
FROM "Role" r
WHERE r."name" = 'Director' AND r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;
```

- [ ] **Step 2: Commit**

```bash
git add prisma/migrations/20260709120500_incidents_permission_backfill/migration.sql
git commit -m "feat(incidents): backfill migration renaming disciplinary grant"
```

---

# Phase 3 - Relocate the strikes ledger (no behavior change beyond the rename)

### Task 6: Move the disciplinary service into incidents and rename the permission

**Files:**
- Create (via git mv): `src/modules/incidents/services/disciplinary.ts`, `src/modules/incidents/services/disciplinary.test.ts`
- Delete: `src/modules/volunteers/services/disciplinary.ts`, `src/modules/volunteers/services/disciplinary.test.ts`

**Interfaces:**
- Produces: same exports (`issueAction`, `deleteAction`, `listActions`, `issuablePeople`, `strikeCount`, `DISCIPLINARY_CATEGORIES`, `DisciplinaryInput`, `ActionRow`, the three error classes) from the new path, gated on `incidents.manage`.

- [ ] **Step 1: Move the files with git** (preserves history):

```bash
mkdir -p src/modules/incidents/services
git mv src/modules/volunteers/services/disciplinary.ts src/modules/incidents/services/disciplinary.ts
git mv src/modules/volunteers/services/disciplinary.test.ts src/modules/incidents/services/disciplinary.test.ts
```

- [ ] **Step 2: Replace every `volunteers.issue_disciplinary` string with `incidents.manage`** in `src/modules/incidents/services/disciplinary.ts`. There are exactly five call sites plus the file header comment: `actorCanManageTarget` (the `can(...)` guard), `issueAction` (the `isCentral` check), `deleteAction` (the permission gate + its error message), `listActions` (the `isCentral` check), and `issuablePeople` (the `all: true` check). Also update the file's top doc-comment. Example - the delete gate becomes:

```ts
export async function deleteAction(actorPersonId: string, id: string): Promise<void> {
  if (!(await can(actorPersonId, "incidents.manage"))) {
    throw new DisciplinaryForbiddenError(
      "incidents.manage is required to delete disciplinary actions."
    );
  }
```

- [ ] **Step 3: Update any import of the moved test/service.** Grep to confirm the only importer is the page (moved in Task 7):

Run: `grep -rn "modules/volunteers/services/disciplinary" src/`
Expected: only `src/app/(app)/volunteers/disciplinary/page.tsx` (handled next). If anything else appears, repoint it to `@/modules/incidents/services/disciplinary`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: PASS (the page still imports the old path until Task 7; if typecheck fails only on that page import, proceed to Task 7 and re-run).

- [ ] **Step 5: Commit**

```bash
git add -A src/modules/incidents/services src/modules/volunteers/services
git commit -m "refactor(incidents): move disciplinary service, gate on incidents.manage"
```

---

### Task 7: Move the strikes page to /incidents/strikes

**Files:**
- Create (via git mv): `src/app/(app)/incidents/strikes/page.tsx`
- Delete: `src/app/(app)/volunteers/disciplinary/page.tsx`

**Interfaces:**
- Consumes: `@/modules/incidents/services/disciplinary`.
- Produces: the strikes ledger at `/incidents/strikes`, gated `incidents.view_strikes`, delete gated `incidents.manage`.

- [ ] **Step 1: Move the page:**

```bash
mkdir -p "src/app/(app)/incidents/strikes"
git mv "src/app/(app)/volunteers/disciplinary/page.tsx" "src/app/(app)/incidents/strikes/page.tsx"
```

- [ ] **Step 2: Update the import path** at the top of the moved page: `@/modules/volunteers/services/disciplinary` -> `@/modules/incidents/services/disciplinary`.

- [ ] **Step 3: Change the page gate.** The page-level `requirePermission("volunteers.view")` becomes `requirePermission("incidents.view_strikes")` (both the top-of-page call and the `issueActionForm` re-check). The `deleteActionForm` re-check `requirePermission("volunteers.issue_disciplinary")` becomes `requirePermission("incidents.manage")`.

Note: directors hold `incidents.view_strikes` but not `incidents.manage`, so `issueActionForm` must additionally reject a non-manager before calling `issueAction`. Since `issueAction` itself enforces scope (central OR manage-target) and directors are no longer manage-target under the new model, add an explicit guard at the top of `issueActionForm`:

```ts
  async function issueActionForm(formData: FormData) {
    "use server";
    const actor = await requirePermission("incidents.view_strikes");
    if (!(await can(actor.personId, "incidents.manage"))) {
      redirect("/incidents/strikes?error=forbidden");
    }
    // ...unchanged body...
  }
```

Add `import { can } from "@/platform/rbac/engine";` to the page. (Directors issue strikes via a report request, not here.)

- [ ] **Step 4: Replace every hardcoded `/volunteers/disciplinary` URL with `/incidents/strikes`.** These appear in: `ERROR_MESSAGES` (none), `issueActionForm` redirects (7 occurrences), `deleteActionForm` redirects (3), `buildHref` (1), the filter `<form action=...>` (1), and the `Clear` `<Link href=...>` (1). Also update the `PageHeader` copy if desired (keep "Strikes" as the title):

```tsx
      <PageHeader
        title="Strikes"
        description="Issued disciplinary strikes. Directors see their departments; reviewers see all and can issue or delete."
      />
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A "src/app/(app)/incidents/strikes" "src/app/(app)/volunteers/disciplinary"
git commit -m "refactor(incidents): move strikes ledger to /incidents/strikes"
```

---

### Task 8: Add the incidents module layout

**Files:**
- Create: `src/app/(app)/incidents/layout.tsx`

**Interfaces:**
- Consumes: module id `incidents`.
- Produces: the module shell (nav) for all `/incidents/*` routes.

- [ ] **Step 1: Write the layout** (mirrors `learning/layout.tsx`):

```tsx
import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { getModule } from "@/platform/modules/registry";
import { filterNavItems } from "@/platform/modules/access";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function IncidentsLayout({ children }: { children: ReactNode }) {
  const { personId } = await requireModuleAccess("incidents");
  const mod = getModule("incidents")!;
  const perms = await getEffectivePermissions(personId);
  return (
    <>
      <ModuleNav items={filterNavItems(mod.nav, perms)} />
      <div className="mt-8">{children}</div>
    </>
  );
}
```

- [ ] **Step 2: Verify the strikes ledger renders under the new shell.**

Run: `npm run build`
Expected: PASS; `/incidents/strikes` compiles as a route.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/incidents/layout.tsx"
git commit -m "feat(incidents): module layout with nav"
```

---

# Phase 4 - Report service

### Task 9: Report constants, errors, and submitReport

**Files:**
- Create: `src/modules/incidents/services/report.ts`
- Test: `src/modules/incidents/services/report.test.ts`

**Interfaces:**
- Produces:
  - `CONCERN_TYPES: ReadonlyArray<{ value: string; label: string; help: string }>`, `CONCERN_TYPE_VALUES: string[]`.
  - `class IncidentValidationError`, `class IncidentForbiddenError`, `class IncidentNotFoundError`.
  - `type SubmitReportInput` and `submitReport(actorPersonId: string, input: SubmitReportInput): Promise<IncidentReport>`.
  - `canRequestStrikeAgainst(actorPersonId: string, subjectPersonId: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb, makePerson, makeActiveTermWithDept, addMembership } from "@/test/factories";
import { submitReport, IncidentValidationError } from "./report";

describe("submitReport", () => {
  beforeEach(async () => { await resetDb(); });

  it("creates a SUBMITTED report with the reporter set", async () => {
    const reporter = await makePerson({ name: "Reporter" });
    const report = await submitReport(reporter.id, {
      concernTypes: ["PROFESSIONAL_CONDUCT"],
      description: "On 2/14 the volunteer raised their voice at a patient.",
      subjectDescription: "SCTM volunteer",
    });
    expect(report.status).toBe("SUBMITTED");
    expect(report.reporterId).toBe(reporter.id);
    expect(report.strikeDecision).toBeNull();
  });

  it("rejects an empty concernTypes list", async () => {
    const reporter = await makePerson({ name: "Reporter" });
    await expect(
      submitReport(reporter.id, { concernTypes: [], description: "x" })
    ).rejects.toBeInstanceOf(IncidentValidationError);
  });

  it("rejects requestStrike when the actor does not manage the subject", async () => {
    const reporter = await makePerson({ name: "Reporter" });
    const subject = await makePerson({ name: "Subject" });
    await expect(
      submitReport(reporter.id, {
        concernTypes: ["ATTENDANCE_RELIABILITY"],
        description: "no-show",
        subjectPersonId: subject.id,
        requestStrike: true,
      })
    ).rejects.toBeInstanceOf(IncidentValidationError);
  });
});
```

(Use the repo's existing test factories/helpers; if `@/test/factories` names differ, mirror the helpers used in `disciplinary.test.ts`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test src/modules/incidents/services/report.test.ts` (CI or throwaway local Postgres)
Expected: FAIL ("submitReport is not a function").

- [ ] **Step 3: Implement `report.ts`:**

```ts
/**
 * Incident Reports service: intake (submitReport) plus the reviewer and strike
 * flows (see report-review.ts additions in later tasks). A report is filed by
 * any signed-in person about anyone. A director filing about a volunteer they
 * manage may request a strike (strikeDecision = PENDING), which a reviewer later
 * approves or declines.
 */

import type { IncidentReport, PatientImpact, IssueNature, PriorOccurrence } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { manageableDepartmentIds } from "@/platform/departments";
import { getActiveTerm } from "@/platform/terms/active-term";

export const CONCERN_TYPES = [
  { value: "PATIENT_SAFETY", label: "Patient Safety", help: "failure to escalate, scope violations, medication errors, unsafe handoffs" },
  { value: "PRIVACY_HIPAA", label: "Privacy / HIPAA", help: "unauthorized chart access, unsecured sharing, unlocked screens" },
  { value: "PROFESSIONAL_CONDUCT", label: "Professional Conduct", help: "disrespect, intimidation, discriminatory behavior, bullying" },
  { value: "ROLE_SCOPE", label: "Role Scope Violation", help: "bypassing chain of command, unauthorized patient contact or referrals" },
  { value: "DOCUMENTATION_WORKFLOW", label: "Documentation / Workflow", help: "incomplete notes, unsigned tasks, referral mishandling" },
  { value: "ATTENDANCE_RELIABILITY", label: "Attendance / Reliability", help: "no-call/no-show, chronic late arrival, uncovered departures" },
  { value: "SYSTEM_ADVERSE_EVENT", label: "System / Adverse Event", help: "workflow gap, near miss, delayed referral" },
  { value: "OTHER", label: "Other / Unsure", help: "describe in the narrative" },
] as const;

export const CONCERN_TYPE_VALUES: string[] = CONCERN_TYPES.map((t) => t.value);

export class IncidentValidationError extends Error {
  constructor(message: string) { super(message); this.name = "IncidentValidationError"; }
}
export class IncidentForbiddenError extends Error {
  constructor(message = "You do not have permission for that action.") { super(message); this.name = "IncidentForbiddenError"; }
}
export class IncidentNotFoundError extends Error {
  constructor(message = "Incident report not found.") { super(message); this.name = "IncidentNotFoundError"; }
}

export type SubmitReportInput = {
  concernTypes: string[];
  description: string;
  occurredAt?: Date | null;
  setting?: string | null;
  subjectPersonId?: string | null;
  subjectDescription?: string | null;
  patientImpact?: PatientImpact | null;
  patientImpactDetail?: string | null;
  immediateRisk?: boolean;
  issueNature?: IssueNature | null;
  priorOccurrence?: PriorOccurrence | null;
  priorOccurrenceDetail?: string | null;
  anonymous?: boolean;
  requestStrike?: boolean;
};

/**
 * True if the actor may request a strike against the subject: the subject has an
 * ACTIVE VOLUNTEER-kind membership in one of the actor's manageable departments
 * in the active term. Reviewers are not special-cased here; they issue strikes
 * directly on the ledger.
 */
export async function canRequestStrikeAgainst(actorPersonId: string, subjectPersonId: string): Promise<boolean> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return false;
  const deptIds = await manageableDepartmentIds(actorPersonId);
  if (deptIds.length === 0) return false;
  const membership = await prisma.termMembership.findFirst({
    where: {
      personId: subjectPersonId,
      termId: activeTerm.id,
      departmentId: { in: deptIds },
      status: "ACTIVE",
      kind: "VOLUNTEER",
    },
  });
  return membership !== null;
}

export async function submitReport(actorPersonId: string, input: SubmitReportInput): Promise<IncidentReport> {
  const concernTypes = input.concernTypes ?? [];
  if (concernTypes.length === 0) {
    throw new IncidentValidationError("Select at least one type of concern.");
  }
  const invalid = concernTypes.filter((c) => !CONCERN_TYPE_VALUES.includes(c));
  if (invalid.length > 0) {
    throw new IncidentValidationError(`Unknown concern type(s): ${invalid.join(", ")}.`);
  }
  if (!input.description.trim()) {
    throw new IncidentValidationError("Describe what happened.");
  }
  if (input.occurredAt && input.occurredAt > new Date()) {
    throw new IncidentValidationError("The date of the incident must not be in the future.");
  }
  if (input.subjectPersonId) {
    const subject = await prisma.person.findUnique({ where: { id: input.subjectPersonId } });
    if (!subject) throw new IncidentNotFoundError(`Subject ${input.subjectPersonId} not found.`);
  }

  let strikeDecision: "PENDING" | null = null;
  if (input.requestStrike) {
    if (!input.subjectPersonId) {
      throw new IncidentValidationError("A strike can only be requested against a specific person.");
    }
    const allowed = await canRequestStrikeAgainst(actorPersonId, input.subjectPersonId);
    if (!allowed) {
      throw new IncidentValidationError("You can only request a strike for a volunteer in a department you manage.");
    }
    strikeDecision = "PENDING";
  }

  const report = await prisma.incidentReport.create({
    data: {
      reporterId: actorPersonId,
      anonymous: input.anonymous ?? false,
      concernTypes,
      description: input.description,
      occurredAt: input.occurredAt ?? null,
      setting: input.setting ?? null,
      subjectPersonId: input.subjectPersonId ?? null,
      subjectDescription: input.subjectDescription ?? null,
      patientImpact: input.patientImpact ?? null,
      patientImpactDetail: input.patientImpactDetail ?? null,
      immediateRisk: input.immediateRisk ?? false,
      issueNature: input.issueNature ?? null,
      priorOccurrence: input.priorOccurrence ?? null,
      priorOccurrenceDetail: input.priorOccurrenceDetail ?? null,
      strikeDecision,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "incident.submit",
    entityType: "IncidentReport",
    entityId: report.id,
    after: { number: report.number, concernTypes, immediateRisk: report.immediateRisk, strikeRequested: strikeDecision !== null },
  });

  return report;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test src/modules/incidents/services/report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/incidents/services/report.ts src/modules/incidents/services/report.test.ts
git commit -m "feat(incidents): submitReport + concern types + strike-request guard"
```

---

### Task 10: My-reports listing and per-report read with visibility

**Files:**
- Modify: `src/modules/incidents/services/report.ts`
- Modify: `src/modules/incidents/services/report.test.ts`

**Interfaces:**
- Produces:
  - `type ReportListRow = { report: IncidentReport; subjectName: string | null }`.
  - `listMyReports(actorPersonId: string): Promise<ReportListRow[]>`.
  - `getReport(actorPersonId: string, id: string): Promise<{ report: IncidentReport & { subject: { name: string } | null; reporter: { name: string }; attachments: IncidentReportAttachment[] }; canManage: boolean }>` - throws `IncidentForbiddenError` unless the actor is the reporter or holds `incidents.manage`; `reviewNotes` is stripped for non-managers.

- [ ] **Step 1: Add failing tests** (owner can read own; a stranger cannot; a manager can):

```ts
import { can } from "@/platform/rbac/engine"; // (already available via engine)
import { listMyReports, getReport, IncidentForbiddenError } from "./report";

it("listMyReports returns only the actor's reports, newest first", async () => {
  const a = await makePerson({ name: "A" });
  const b = await makePerson({ name: "B" });
  await submitReport(a.id, { concernTypes: ["OTHER"], description: "first" });
  await submitReport(b.id, { concernTypes: ["OTHER"], description: "other-person" });
  const rows = await listMyReports(a.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].report.description).toBe("first");
});

it("getReport forbids a non-owner without incidents.manage", async () => {
  const a = await makePerson({ name: "A" });
  const stranger = await makePerson({ name: "S" });
  const r = await submitReport(a.id, { concernTypes: ["OTHER"], description: "secret" });
  await expect(getReport(stranger.id, r.id)).rejects.toBeInstanceOf(IncidentForbiddenError);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test src/modules/incidents/services/report.test.ts`
Expected: FAIL (functions undefined).

- [ ] **Step 3: Implement** (add to `report.ts`; import `can`):

```ts
import { can } from "@/platform/rbac/engine";
import type { IncidentReportAttachment } from "@prisma/client";

export type ReportListRow = { report: IncidentReport; subjectName: string | null };

export async function listMyReports(actorPersonId: string): Promise<ReportListRow[]> {
  const reports = await prisma.incidentReport.findMany({
    where: { reporterId: actorPersonId },
    include: { subject: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return reports.map((r) => ({ report: r, subjectName: r.subject?.name ?? null }));
}

export async function getReport(actorPersonId: string, id: string) {
  const report = await prisma.incidentReport.findUnique({
    where: { id },
    include: {
      subject: { select: { name: true } },
      reporter: { select: { name: true } },
      attachments: true,
    },
  });
  if (!report) throw new IncidentNotFoundError();

  const canManage = await can(actorPersonId, "incidents.manage");
  const isOwner = report.reporterId === actorPersonId;
  if (!canManage && !isOwner) throw new IncidentForbiddenError();

  // Reviewer-internal notes are never returned to a non-manager owner.
  const safe = canManage ? report : { ...report, reviewNotes: null };
  return { report: safe, canManage };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test src/modules/incidents/services/report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/incidents/services/report.ts src/modules/incidents/services/report.test.ts
git commit -m "feat(incidents): listMyReports + getReport with owner/manager visibility"
```

---

### Task 11: Review queue and reviewReport

**Files:**
- Modify: `src/modules/incidents/services/report.ts`
- Modify: `src/modules/incidents/services/report.test.ts`

**Interfaces:**
- Produces:
  - `type ReviewFilters = { status?: string; concernType?: string; immediateRisk?: boolean; strikePending?: boolean; q?: string; page?: number }`.
  - `listReviewQueue(actorPersonId, filters): Promise<{ rows: Array<{ report: IncidentReport; reporterName: string; subjectName: string | null }>; total: number }>` - requires `incidents.manage`, else `IncidentForbiddenError`.
  - `reviewReport(actorPersonId, id, input: { status: IncidentReportStatus; reviewNotes?: string | null }): Promise<IncidentReport>` - requires `incidents.manage`; sets `resolvedBy`/`resolvedAt` when status is RESOLVED or DISMISSED.

- [ ] **Step 1: Add failing tests** (manager sees all; non-manager forbidden; resolve stamps resolvedBy):

```ts
import { listReviewQueue, reviewReport } from "./report";

it("listReviewQueue forbids a non-manager", async () => {
  const a = await makePerson({ name: "A" });
  await expect(listReviewQueue(a.id, {})).rejects.toBeInstanceOf(IncidentForbiddenError);
});
```

(For the manager-path tests, seed a person holding `incidents.manage` the way `disciplinary.test.ts` seeds central permission - reuse that helper.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test src/modules/incidents/services/report.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement:**

```ts
import type { IncidentReportStatus, Prisma } from "@prisma/client";

export type ReviewFilters = {
  status?: string;
  concernType?: string;
  immediateRisk?: boolean;
  strikePending?: boolean;
  q?: string;
  page?: number;
};

const REVIEW_PAGE_SIZE = 25;

export async function listReviewQueue(actorPersonId: string, filters: ReviewFilters) {
  if (!(await can(actorPersonId, "incidents.manage"))) throw new IncidentForbiddenError();

  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.IncidentReportWhereInput = {};
  if (filters.status) where.status = filters.status as IncidentReportStatus;
  if (filters.concernType) where.concernTypes = { has: filters.concernType };
  if (filters.immediateRisk) where.immediateRisk = true;
  if (filters.strikePending) where.strikeDecision = "PENDING";
  if (filters.q) {
    const q = filters.q.trim();
    const asNumber = Number.parseInt(q, 10);
    where.OR = [
      { subject: { name: { contains: q, mode: "insensitive" } } },
      { reporter: { name: { contains: q, mode: "insensitive" } } },
      ...(Number.isNaN(asNumber) ? [] : [{ number: asNumber }]),
    ];
  }

  const [reports, total] = await Promise.all([
    prisma.incidentReport.findMany({
      where,
      include: { subject: { select: { name: true } }, reporter: { select: { name: true } } },
      orderBy: [{ immediateRisk: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * REVIEW_PAGE_SIZE,
      take: REVIEW_PAGE_SIZE,
    }),
    prisma.incidentReport.count({ where }),
  ]);

  return {
    rows: reports.map((r) => ({ report: r, reporterName: r.reporter.name, subjectName: r.subject?.name ?? null })),
    total,
  };
}

export async function reviewReport(
  actorPersonId: string,
  id: string,
  input: { status: IncidentReportStatus; reviewNotes?: string | null }
): Promise<IncidentReport> {
  if (!(await can(actorPersonId, "incidents.manage"))) throw new IncidentForbiddenError();
  const existing = await prisma.incidentReport.findUnique({ where: { id } });
  if (!existing) throw new IncidentNotFoundError();

  const terminal = input.status === "RESOLVED" || input.status === "DISMISSED";
  const updated = await prisma.incidentReport.update({
    where: { id },
    data: {
      status: input.status,
      reviewNotes: input.reviewNotes ?? existing.reviewNotes,
      resolvedById: terminal ? actorPersonId : null,
      resolvedAt: terminal ? new Date() : null,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "incident.review",
    entityType: "IncidentReport",
    entityId: id,
    after: { status: updated.status },
  });

  return updated;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test src/modules/incidents/services/report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/incidents/services/report.ts src/modules/incidents/services/report.test.ts
git commit -m "feat(incidents): review queue + reviewReport"
```

---

### Task 12: decideStrike (the report -> strike bridge)

**Files:**
- Modify: `src/modules/incidents/services/report.ts`
- Modify: `src/modules/incidents/services/disciplinary.ts` (add `reportId` to `DisciplinaryInput` + the create `data`)
- Modify: `src/modules/incidents/services/report.test.ts`

**Interfaces:**
- Consumes: `issueAction` from `./disciplinary` (extended to accept `reportId`).
- Produces: `decideStrike(actorPersonId, reportId, input: { approve: boolean; category?: string; occurredAt?: Date | null; followUpActions?: string | null; policyReference?: string | null; notes?: string | null }): Promise<IncidentReport>` - requires `incidents.manage`; the report's `strikeDecision` must be `PENDING`.

- [ ] **Step 1: Extend `DisciplinaryInput` + create data in `disciplinary.ts`.** Add `reportId?: string | null;` to the `DisciplinaryInput` type and `reportId: input.reportId ?? null,` to the `prisma.disciplinaryAction.create({ data: { ... } })` call in `issueAction`.

- [ ] **Step 2: Add failing tests** (approve creates a linked counted strike; anonymous -> confidential; decline records DECLINED with no action):

```ts
import { decideStrike } from "./report";

it("decideStrike approve creates a linked confidential strike for an anonymous report", async () => {
  // seed: manager with incidents.manage; director who manages dept D; volunteer subject in D (active term)
  // director submits an anonymous report with requestStrike -> strikeDecision PENDING
  // manager approves with a valid category
  // expect: report.strikeDecision === "APPROVED", a DisciplinaryAction exists with reportId === report.id and confidential === true
});
```

(Fill in the seeding using the same term/dept/membership helpers as `disciplinary.test.ts`; assert on `prisma.disciplinaryAction.findUnique({ where: { reportId: report.id } })`.)

- [ ] **Step 3: Run to verify failure**

Run: `npm test src/modules/incidents/services/report.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `decideStrike`:**

```ts
import { issueAction, DISCIPLINARY_CATEGORIES } from "./disciplinary";

export async function decideStrike(
  actorPersonId: string,
  reportId: string,
  input: { approve: boolean; category?: string; occurredAt?: Date | null; followUpActions?: string | null; policyReference?: string | null; notes?: string | null }
): Promise<IncidentReport> {
  if (!(await can(actorPersonId, "incidents.manage"))) throw new IncidentForbiddenError();

  const report = await prisma.incidentReport.findUnique({ where: { id: reportId } });
  if (!report) throw new IncidentNotFoundError();
  if (report.strikeDecision !== "PENDING") {
    throw new IncidentValidationError("This report has no pending strike request.");
  }

  if (!input.approve) {
    return prisma.incidentReport.update({
      where: { id: reportId },
      data: { strikeDecision: "DECLINED", strikeDecidedById: actorPersonId, strikeDecidedAt: new Date() },
    });
  }

  if (!report.subjectPersonId) {
    throw new IncidentValidationError("Cannot issue a strike: the report has no linked subject.");
  }
  const category = input.category ?? "";
  if (!(DISCIPLINARY_CATEGORIES as readonly string[]).includes(category)) {
    throw new IncidentValidationError(`Choose a strike category. One of: ${DISCIPLINARY_CATEGORIES.join(", ")}.`);
  }

  // issueAction enforces its own permission (incidents.manage -> central bypass).
  await issueAction(actorPersonId, {
    personId: report.subjectPersonId,
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

  return prisma.incidentReport.update({
    where: { id: reportId },
    data: { strikeDecision: "APPROVED", strikeDecidedById: actorPersonId, strikeDecidedAt: new Date() },
  });
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npm test src/modules/incidents/services/report.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/incidents/services/report.ts src/modules/incidents/services/disciplinary.ts src/modules/incidents/services/report.test.ts
git commit -m "feat(incidents): decideStrike bridges an approved request to a linked strike"
```

---

# Phase 5 - Report UI

> UI tasks are verified with `npm run typecheck`, `npm run lint`, and `npm run build`; behavior is covered by the e2e task (Task 19). All server actions follow the disciplinary page pattern: `requirePermission(...)` -> service call -> `catch` typed errors -> `redirect("...?error=code")` -> `revalidatePath` -> `redirect` to the clean path.

### Task 13: Report-a-concern form (`/incidents`) + submit action

**Files:**
- Create: `src/app/(app)/incidents/page.tsx`
- Create: `src/app/(app)/incidents/actions.ts`

**Interfaces:**
- Consumes: `submitReport`, `CONCERN_TYPES`, `canRequestStrikeAgainst`, the error classes.
- Produces: `submitReportAction(formData): Promise<void>`.

- [ ] **Step 1: Write `actions.ts`** with the submit action (mirrors `issueActionForm`):

```ts
"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { submitReport, IncidentValidationError, IncidentNotFoundError, IncidentForbiddenError } from "@/modules/incidents/services/report";
import type { PatientImpact, IssueNature, PriorOccurrence } from "@prisma/client";

function optEnum<T extends string>(v: FormDataEntryValue | null, allowed: readonly string[]): T | null {
  const s = typeof v === "string" ? v : "";
  return (s && allowed.includes(s) ? (s as T) : null);
}

export async function submitReportAction(formData: FormData): Promise<void> {
  const actor = await requirePersonSession();

  const occurredAtStr = String(formData.get("occurredAt") ?? "");
  const occurredAt = occurredAtStr ? new Date(occurredAtStr) : null;

  let number: number;
  try {
    const report = await submitReport(actor.personId, {
      concernTypes: formData.getAll("concernTypes").map(String),
      description: String(formData.get("description") ?? "").trim(),
      occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null,
      setting: (String(formData.get("setting") ?? "").trim() || null),
      subjectPersonId: (String(formData.get("subjectPersonId") ?? "").trim() || null),
      subjectDescription: (String(formData.get("subjectDescription") ?? "").trim() || null),
      patientImpact: optEnum<PatientImpact>(formData.get("patientImpact"), ["YES", "NO", "UNSURE"]),
      patientImpactDetail: (String(formData.get("patientImpactDetail") ?? "").trim() || null),
      immediateRisk: formData.get("immediateRisk") === "yes",
      issueNature: optEnum<IssueNature>(formData.get("issueNature"), ["SYSTEM", "INDIVIDUAL", "BOTH_UNSURE"]),
      priorOccurrence: optEnum<PriorOccurrence>(formData.get("priorOccurrence"), ["YES", "NO", "UNSURE"]),
      priorOccurrenceDetail: (String(formData.get("priorOccurrenceDetail") ?? "").trim() || null),
      anonymous: formData.get("anonymous") === "on",
      requestStrike: formData.get("requestStrike") === "on",
    });
    number = report.number;
  } catch (err) {
    if (err instanceof IncidentValidationError) {
      redirect(`/incidents?error=validation&message=${encodeURIComponent(err.message)}`);
    }
    if (err instanceof IncidentNotFoundError) redirect("/incidents?error=subject-not-found");
    if (err instanceof IncidentForbiddenError) redirect("/incidents?error=forbidden");
    throw err;
  }
  // Success redirect lives OUTSIDE the try: redirect() throws NEXT_REDIRECT, which
  // must not be caught by the error handler above. This mirrors the disciplinary page.
  revalidatePath("/incidents/mine");
  redirect(`/incidents/mine?submitted=${number}`);
}
```

- [ ] **Step 2: Write `page.tsx`** - a server component rendering the 10-section form. Reuse `PageHeader`, `Card`, `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Alert`, `Button`, `FormActions` (same imports as the strikes page). Load the actor via `requirePersonSession()` and, when the actor manages any department, load the volunteers they can request a strike against (reuse `issuablePeople` from `./disciplinary` - returns `{ all, people }`; use `people` for the subject picker and to decide whether to show the request-strike checkbox). Key novel markup:

```tsx
// Section 1 - concern types (multi-select checkboxes)
<fieldset>
  <legend className="mb-2 text-sm font-medium">Type of concern (select all that apply)</legend>
  <div className="grid gap-2 sm:grid-cols-2">
    {CONCERN_TYPES.map((t) => (
      <label key={t.value} className="flex items-start gap-2 text-sm">
        <Checkbox name="concernTypes" value={t.value} />
        <span><span className="font-medium">{t.label}</span> - <span className="text-muted-foreground">{t.help}</span></span>
      </label>
    ))}
  </div>
</fieldset>

// Section 4 - subject: linked person (optional) + free-text
<Field label="Name, role, or department of the individual(s) of concern">
  <Textarea name="subjectDescription" rows={2} placeholder="If unknown, describe as observed" />
</Field>
{issuable.people.length > 0 && (
  <Field label="Or select a volunteer you manage (enables a strike request)">
    <Select name="subjectPersonId" defaultValue="">
      <option value="">Not a specific volunteer I manage</option>
      {issuable.people.map((p) => (
        <option key={p.id} value={p.id}>{p.name ?? p.id}{p.departmentNames.length ? ` (${p.departmentNames.join(", ")})` : ""}</option>
      ))}
    </Select>
  </Field>
)}

// Section 5 - patient impact
<Field label="Was a patient directly impacted?">
  <Select name="patientImpact" defaultValue=""><option value="">Select...</option><option value="YES">Yes</option><option value="NO">No</option><option value="UNSURE">Unsure</option></Select>
</Field>
<Field label="If yes, briefly describe"><Textarea name="patientImpactDetail" rows={2} /></Field>

// Section 6 - immediate risk (radio)
<fieldset>
  <legend className="mb-2 text-sm font-medium">Does this present an ongoing risk right now?</legend>
  <label className="mr-4 text-sm"><input type="radio" name="immediateRisk" value="yes" className="mr-1" />Yes - needs urgent attention</label>
  <label className="text-sm"><input type="radio" name="immediateRisk" value="no" defaultChecked className="mr-1" />No - resolved or not time-sensitive</label>
</fieldset>

// Section 7 - issue nature
<Field label="Is this primarily a workflow/system failure rather than individual conduct?">
  <Select name="issueNature" defaultValue=""><option value="">Select...</option><option value="SYSTEM">Yes - workflow or system gap</option><option value="INDIVIDUAL">No - individual conduct</option><option value="BOTH_UNSURE">Both / Unsure</option></Select>
</Field>

// Section 8 - prior occurrence
<Field label="Has this type of incident occurred before, to your knowledge?">
  <Select name="priorOccurrence" defaultValue=""><option value="">Select...</option><option value="YES">Yes - aware of prior similar incidents</option><option value="NO">No - appears to be a first occurrence</option><option value="UNSURE">Unsure</option></Select>
</Field>
<Field label="Optional - any context on prior occurrences"><Textarea name="priorOccurrenceDetail" rows={2} /></Field>

// Section 10 - name / anonymity
<Field label="Your name">
  <Input defaultValue={actor.name ?? ""} disabled />
</Field>
<label className="flex items-center gap-2 text-sm"><Checkbox name="anonymous" /> I would prefer to remain anonymous (your name is not shared with the subject)</label>

// Request-strike (only when the actor manages volunteers)
{issuable.people.length > 0 && (
  <label className="flex items-center gap-2 text-sm">
    <Checkbox name="requestStrike" /> Request a strike (only applies when you selected a volunteer you manage above; a reviewer approves)
  </label>
)}

<form action={submitReportAction}> ... fields above, plus Section 2 description (required), Section 3 date + setting ... <FormActions><Button type="submit">Submit report</Button></FormActions></form>
```

Include the same `?error=`/`message` Alert block as the strikes page (copy the `ERROR_MESSAGES` map with incident-specific codes: `validation`, `subject-not-found`, `forbidden`).

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS; `/incidents` compiles.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/incidents/page.tsx" "src/app/(app)/incidents/actions.ts"
git commit -m "feat(incidents): report-a-concern form + submit action"
```

---

### Task 14: My reports + report detail (owner view)

**Files:**
- Create: `src/app/(app)/incidents/mine/page.tsx`
- Create: `src/app/(app)/incidents/[id]/page.tsx`

**Interfaces:**
- Consumes: `listMyReports`, `getReport`, `IncidentForbiddenError`, `IncidentNotFoundError`.

- [ ] **Step 1: Write `mine/page.tsx`** - `requirePersonSession()`, call `listMyReports(personId)`, render a `Table` (Number, Concern types, Subject, Status `Badge`, Strike status, Submitted date). Read `searchParams.submitted` to show a success `Alert` ("Report #N submitted."). Each row links to `/incidents/[id]`. Strike status derives from `report.strikeDecision` (`null` -> nothing; `PENDING` -> "Strike requested"; `APPROVED`/`DECLINED` -> label). Use neutral `Badge` styling.

- [ ] **Step 2: Write `[id]/page.tsx`** - `requirePersonSession()`, `const { report, canManage } = await getReport(personId, id)` inside a try/catch that renders a not-found/forbidden state (catch `IncidentNotFoundError`/`IncidentForbiddenError` -> `notFound()` from `next/navigation`). Render all submitted fields read-only (concern types as text, description, date/setting, subject name or description, patient impact, immediate-risk, issue nature, prior occurrence, attachments list linking to the download route). If `canManage` is false, do not render `reviewNotes` (already stripped by the service). If `canManage` is true, render the reviewer controls inline (Task 15 adds the review/decide forms; for this task, a manager viewing `[id]` may reuse `/incidents/review` for actions - keep `[id]` read-only here and add manager actions in Task 15).

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/incidents/mine/page.tsx" "src/app/(app)/incidents/[id]/page.tsx"
git commit -m "feat(incidents): my reports list + report detail (owner view)"
```

---

### Task 15: Review queue + reviewer actions

**Files:**
- Create: `src/app/(app)/incidents/review/page.tsx`
- Modify: `src/app/(app)/incidents/actions.ts` (add `reviewReportAction`, `decideStrikeAction`)
- Modify: `src/app/(app)/incidents/[id]/page.tsx` (render reviewer controls when `canManage`)

**Interfaces:**
- Consumes: `listReviewQueue`, `reviewReport`, `decideStrike`, `DISCIPLINARY_CATEGORIES`.
- Produces: `reviewReportAction(formData)`, `decideStrikeAction(formData)`.

- [ ] **Step 1: Add the two server actions to `actions.ts`** (each `requirePermission("incidents.manage")`, call the service, catch `IncidentValidationError`/`IncidentForbiddenError`/`IncidentNotFoundError` -> redirect with an error code, then `revalidatePath` the detail + review paths):

```ts
import { requirePermission } from "@/platform/auth/session";
import { reviewReport, decideStrike } from "@/modules/incidents/services/report";
import type { IncidentReportStatus } from "@prisma/client";

export async function reviewReportAction(formData: FormData): Promise<void> {
  const actor = await requirePermission("incidents.manage");
  const id = String(formData.get("reportId"));
  try {
    await reviewReport(actor.personId, id, {
      status: String(formData.get("status") ?? "UNDER_REVIEW") as IncidentReportStatus,
      reviewNotes: (String(formData.get("reviewNotes") ?? "").trim() || null),
    });
  } catch (err) {
    if (err instanceof IncidentValidationError) redirect(`/incidents/${id}?error=validation&message=${encodeURIComponent(err.message)}`);
    if (err instanceof IncidentForbiddenError) redirect(`/incidents/${id}?error=forbidden`);
    if (err instanceof IncidentNotFoundError) redirect(`/incidents/review?error=not-found`);
    throw err;
  }
  revalidatePath(`/incidents/${id}`);
  revalidatePath("/incidents/review");
  redirect(`/incidents/${id}`);
}

export async function decideStrikeAction(formData: FormData): Promise<void> {
  const actor = await requirePermission("incidents.manage");
  const id = String(formData.get("reportId"));
  try {
    await decideStrike(actor.personId, id, {
      approve: formData.get("approve") === "yes",
      category: (String(formData.get("category") ?? "").trim() || undefined),
      occurredAt: null,
      notes: (String(formData.get("notes") ?? "").trim() || null),
    });
  } catch (err) {
    if (err instanceof IncidentValidationError) redirect(`/incidents/${id}?error=validation&message=${encodeURIComponent(err.message)}`);
    if (err instanceof IncidentForbiddenError) redirect(`/incidents/${id}?error=forbidden`);
    if (err instanceof IncidentNotFoundError) redirect(`/incidents/review?error=not-found`);
    throw err;
  }
  revalidatePath(`/incidents/${id}`);
  revalidatePath("/incidents/review");
  redirect(`/incidents/${id}`);
}
```

- [ ] **Step 2: Write `review/page.tsx`** - `requirePermission("incidents.manage")`, read filter searchParams (`status`, `concernType`, `immediateRisk`, `strikePending`, `q`, `page`), call `listReviewQueue`, render a filter bar (mirroring the strikes page filter bar) + a `Table` (Number, Reporter, Subject, Concern types, Immediate risk `Badge`, Strike `Badge` when `strikeDecision === "PENDING"`, Status, Submitted). Rows link to `/incidents/[id]`. Add `Pagination`.

- [ ] **Step 3: Add reviewer controls to `[id]/page.tsx`** when `canManage`: a status form (`reviewReportAction`: a `Select` of `SUBMITTED/UNDER_REVIEW/RESOLVED/DISMISSED` + a `reviewNotes` `Textarea` + submit) and, when `report.strikeDecision === "PENDING"`, a strike-decision form (`decideStrikeAction`: a hidden `approve` toggled by two submit buttons or a `Select`, a `category` `Select` of `DISCIPLINARY_CATEGORIES` for the approve path, an optional `notes` `Textarea`). Show the current `strikeDecision` and, when APPROVED, a note that the strike is recorded (link to `/incidents/strikes`).

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/incidents/review/page.tsx" "src/app/(app)/incidents/actions.ts" "src/app/(app)/incidents/[id]/page.tsx"
git commit -m "feat(incidents): review queue + reviewer status/strike actions"
```

---

# Phase 6 - Attachments

### Task 16: Upload attachments on submit + authorized download route

**Files:**
- Modify: `src/modules/incidents/services/report.ts` (accept + persist files in `submitReport`)
- Modify: `src/app/(app)/incidents/actions.ts` (read `File`s from the form)
- Create: `src/app/api/incidents/attachments/[id]/route.ts`
- Modify: `src/modules/incidents/services/report.test.ts`

**Interfaces:**
- Consumes: `putObject`/`getObject` from `@/platform/storage`, `validateUploadedFile` from `@/modules/recruitment/services/upload`, `getSetting("uploads.maxMb")`.
- Produces: attachment rows on submit; `GET /api/incidents/attachments/[id]` streams the file to the reporter or an `incidents.manage` holder.

- [ ] **Step 1: Extend `SubmitReportInput`** with `files?: Array<{ fileName: string; mimeType: string; bytes: Buffer }>`. After creating the report (still in `submitReport`), for each file: validate with `validateUploadedFile(file, null, await getSetting<number>("uploads.maxMb"))` (throw `IncidentValidationError` on the returned message), create an `IncidentReportAttachment` row with `storedName: "pending"`, derive `storedName = "incidents/" + report.id + "/" + attachment.id + ext`, update the row, then `putObject(storedName, file.bytes, file.mimeType)`; on storage failure delete the row (mirror `saveCertificate`). Keep this inside `submitReport` so a report + its files commit together (validation before create; on any file failure after the report row exists, delete created attachment rows and rethrow).

- [ ] **Step 2: Read files in `submitReportAction`** - `const files = formData.getAll("attachments").filter((f): f is File => f instanceof File && f.size > 0);` then map to `{ fileName: f.name, mimeType: f.type, bytes: Buffer.from(await f.arrayBuffer()) }` and pass as `files`. Add `<input type="file" name="attachments" multiple />` to Section 9 of the form (Task 13 page); set `encType` is automatic for server actions.

- [ ] **Step 3: Write the download route** (mirrors the certificate route, with an incidents access check):

```ts
import { auth } from "@/platform/auth";
import { getActivePerson } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { getObject } from "@/platform/storage";
import { can } from "@/platform/rbac/engine";

const INLINE_SAFE_MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const session = await auth();
  if (!session?.personId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const activePerson = await getActivePerson(session.personId);
  if (!activePerson) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const att = await prisma.incidentReportAttachment.findUnique({ where: { id }, include: { report: { select: { reporterId: true } } } });
  const allowed = att ? (att.report.reporterId === activePerson.id || (await can(activePerson.id, "incidents.manage"))) : false;
  if (!att || !allowed) return Response.json({ error: "Not found" }, { status: 404 });

  const buf = await getObject(att.storedName);
  if (!buf) return Response.json({ error: "Not found" }, { status: 404 });
  const inline = new URL(request.url).searchParams.get("inline") === "1";
  const renderInline = inline && INLINE_SAFE_MIME_TYPES.has(att.mimeType);
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": att.mimeType,
      "Content-Disposition": `${renderInline ? "inline" : "attachment"}; filename="${att.fileName.replace(/"/g, "")}"`,
      "Content-Length": String(buf.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
```

(Confirm the exact import path for `auth` and `getActivePerson` against the certificate route `src/app/(app)/my-info/certificate/[id]/route.ts` and reuse whatever it imports.)

- [ ] **Step 4: Add a test** that `submitReport` persists an attachment row (assert `prisma.incidentReportAttachment.count`), and verify locally with `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/incidents "src/app/(app)/incidents/actions.ts" "src/app/api/incidents/attachments"
git commit -m "feat(incidents): report attachments upload + authorized download"
```

---

# Phase 7 - Notifications

### Task 17: Email template descriptors + notification registry entries

**Files:**
- Create: `src/platform/email/templates/incidents.ts`
- Modify: `src/platform/email/templates/registry.ts`
- Modify: `src/platform/notifications/registry.ts`

**Interfaces:**
- Produces: `incidentsDescriptors: TemplateDescriptor[]` for keys `incidents.report_submitted`, `incidents.strike_requested`, `incidents.strike_decided`, `incidents.report_resolved`, each with a context builder; those four keys added to `NOTIFICATION_TYPES`.

- [ ] **Step 1: Write `incidents.ts`** mirroring `compliance.ts` - four `TemplateDescriptor`s plus context builders. Keep bodies to plain interpolation with the subset engine (`{{ var }}`, `{{#if}}`); no `{{#each}}`. Example (one descriptor + builder; write all four):

```ts
import type { TemplateDescriptor } from "./types";

export function reportSubmittedContext(p: { reviewerName: string; reportNumber: number; concernSummary: string; immediateRisk: boolean; reviewLink: string }): Record<string, unknown> {
  return { reviewerName: p.reviewerName, reportNumber: String(p.reportNumber), concernSummary: p.concernSummary, immediateRisk: p.immediateRisk, reviewLink: p.reviewLink };
}

export const incidentsDescriptors: TemplateDescriptor[] = [
  {
    key: "incidents.report_submitted",
    name: "Incident: report submitted (reviewers)",
    category: "transactional",
    group: "incidents",
    variables: [
      { name: "reviewerName", label: "Reviewer name", sampleValue: "Dr. Smith" },
      { name: "reportNumber", label: "Report number", sampleValue: "42" },
      { name: "concernSummary", label: "Comma-separated concern types", sampleValue: "Professional Conduct" },
      { name: "immediateRisk", label: "True when flagged as immediate risk", sampleValue: "false" },
      { name: "reviewLink", label: "Link to the review queue", sampleValue: "https://hub.havenfreeclinic.org/incidents/review" },
    ],
    defaultSubject: "[HAVEN] New incident report #{{ reportNumber }}",
    defaultBody: `<p>Hello {{ reviewerName }},</p>
{{#if immediateRisk}}<p><strong>This report is flagged as an immediate risk and needs urgent attention.</strong></p>{{/if}}
<p>Incident report #{{ reportNumber }} was submitted ({{ concernSummary }}).</p>
<p><a href="{{ reviewLink }}">Open the review queue</a></p>
<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
  // ... incidents.strike_requested, incidents.strike_decided, incidents.report_resolved (same shape)
];
```

(For `incidents.strike_decided` include a `{{#if approved}}...{{else}}...{{/if}}` branch; for `incidents.report_resolved` include the `{{ outcome }}` = "resolved"/"dismissed" as a precomputed string.)

- [ ] **Step 2: Register in `registry.ts`** - import `incidentsDescriptors` and spread it into `ALL`:

```ts
import { incidentsDescriptors } from "./incidents";
const ALL: TemplateDescriptor[] = [layoutDescriptor, ...complianceDescriptors, ...epicDescriptors, ...recruitmentDescriptors, ...incidentsDescriptors];
```

- [ ] **Step 3: Add the four `NOTIFICATION_TYPES`** entries in `src/platform/notifications/registry.ts`:

```ts
  { key: "incidents.report_submitted", label: "Incident: report submitted (reviewers)", defaultChannel: "email" },
  { key: "incidents.strike_requested", label: "Incident: strike requested (reviewers)", defaultChannel: "email" },
  { key: "incidents.strike_decided", label: "Incident: strike decision (reporter)", defaultChannel: "email" },
  { key: "incidents.report_resolved", label: "Incident: report resolved (reporter)", defaultChannel: "email" },
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test src/platform/email/templates` (the templates suite is not DB-backed; it renders descriptors)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/email/templates/incidents.ts src/platform/email/templates/registry.ts src/platform/notifications/registry.ts
git commit -m "feat(incidents): email templates + notification types"
```

---

### Task 18: Wire notify() into the report service

**Files:**
- Modify: `src/modules/incidents/services/report.ts`
- Modify: `src/modules/incidents/services/report.test.ts`

**Interfaces:**
- Consumes: `notify` from `@/platform/notifications/notify`, `peopleWithAnyPermission` from `@/platform/rbac/holders`, `renderEmail` + the incident context builders, `getSetting("app.url")` (or the same base-URL source the compliance reminder uses).

- [ ] **Step 1: Add a private `notifyReviewers` + reporter helpers** and call them from `submitReport`, `decideStrike`, and `reviewReport`:
  - End of `submitReport`: resolve reviewers via `peopleWithAnyPermission(["incidents.manage"])`; for each, `renderEmail("incidents.report_submitted", reportSubmittedContext({...}))` then `notify(prisma, { type: "incidents.report_submitted", person: { id, entraObjectId, contactEmail }, email, teams: {...}, triggeredById: actorPersonId })`. When `strikeDecision === "PENDING"`, also send `incidents.strike_requested` to the same reviewers.
  - `decideStrike`: after the update, load the reporter (`prisma.person.findUnique` selecting `id, entraObjectId, contactEmail, name`) and send `incidents.strike_decided` (approved/declined branch) to the reporter.
  - `reviewReport`: when the new status is `RESOLVED` or `DISMISSED`, send `incidents.report_resolved` to the reporter.
  - Subjects are never notified.

- [ ] **Step 2: Guard against notify failures** - wrap each notify batch so a delivery error does not roll back the mutation (mirror how existing services treat notify as best-effort; the mutation has already committed). Do not notify inside the DB write path unless using the same tx like `interviews.ts`; here notify runs after the write with `prisma` as the db arg.

- [ ] **Step 3: Add a test** asserting a submitted report enqueues a notification for a reviewer (assert on the `Notification` rows the dispatcher writes, per `notify.test.ts` conventions), and that the subject is never a recipient.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint` (DB assertions run in CI)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/incidents/services/report.ts src/modules/incidents/services/report.test.ts
git commit -m "feat(incidents): notify reviewers on submit, reporter on decision/resolution"
```

---

# Phase 8 - e2e and cleanup

### Task 19: e2e coverage + remove the disciplinary e2e block

**Files:**
- Create: `e2e/incidents.spec.ts`
- Modify: `e2e/volunteers.spec.ts` (delete the disciplinary `test(...)` block and any now-unused helper)

**Interfaces:**
- Consumes: `devLogin`/`loginAs` from `e2e/auth.ts`; existing seed fixtures.

- [ ] **Step 1: Remove the disciplinary block** from `e2e/volunteers.spec.ts` (the `test("disciplinary: issue attendance action ...")` block). If `confirmButtonClick` becomes unused there, leave it if other tests use it; otherwise remove.

- [ ] **Step 2: Write `e2e/incidents.spec.ts`:**
  - Test A (anyone can file): `devLogin(page, "dev.volunteer@yale.edu")`; go to `/incidents`; check at least one concern type; fill the description; submit; assert redirect to `/incidents/mine` and the new report row is visible.
  - Test B (reviewer round trip): `devLogin(page, "j.carney@yale.edu")` (Platform Admin holds `incidents.manage` via `*`); go to `/incidents/review`; open the report from Test A; set status to RESOLVED; assert the status badge updates.
  - Test C (strike request -> approve): log in as the seeded director (`dev.director@yale.edu`), file a report selecting a managed volunteer with "Request a strike"; then as admin approve the strike from `/incidents/[id]`; assert a strike now appears at `/incidents/strikes` and the report shows APPROVED. (Seed a director-managed volunteer with the same fixtures `volunteers.spec.ts` uses; clean up after.)

- [ ] **Step 3: Run e2e** (locally against the dev server, or defer to CI)

Run: `npm run e2e -- incidents` (or the repo's e2e invocation)
Expected: the three specs pass; if run locally requires the seeded dev DB, otherwise CI is the gate.

- [ ] **Step 4: Commit**

```bash
git add e2e/incidents.spec.ts e2e/volunteers.spec.ts
git commit -m "test(incidents): e2e report/review/strike flow; drop disciplinary from volunteers spec"
```

---

### Task 20: Final consistency sweep

**Files:**
- Modify: any stragglers surfaced by grep.

- [ ] **Step 1: Grep for stale references:**

Run:
```bash
grep -rn "volunteers.issue_disciplinary" src/ prisma/ e2e/
grep -rn "/volunteers/disciplinary" src/ e2e/
grep -rn "modules/volunteers/services/disciplinary" src/
```
Expected: no results (all moved/renamed). Fix any hit (e.g. a seed reference, a doc string, a test).

- [ ] **Step 2: Confirm the RBAC valid-permission set includes the new strings** - they are in the `incidents` manifest `permissions[]` (Task 3), so `admin/services/rbac.ts` accepts them. Grep `src/modules/admin/services/rbac.ts` for any hardcoded permission allowlist and confirm it derives from `MODULES`.

- [ ] **Step 3: Full local gate:**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 4: Deploy checklist note (do not run against Neon here):** before the Neon deploy, run `npx prisma migrate status` and confirm both new migrations are pending; the preview shares the prod DB, so the branch must be at/ahead of the migration to avoid P2021.

- [ ] **Step 5: Commit any fixes:**

```bash
git add -A
git commit -m "chore(incidents): final consistency sweep"
```

---

## Self-review notes (author)

- **Spec coverage:** module rename/open access (Task 3), two-permission model + backfill (Tasks 3-5), `IncidentReport`/attachment schema (Task 1-2), strikes relocation with `directorVisibility` preserved (Tasks 6-8), submit + concern types + 10 sections (Tasks 9, 13, 16), owner/reviewer visibility (Tasks 10, 14), review queue + reviewReport (Tasks 11, 15), ED-approval strike bridge + anonymous->confidential (Task 12), attachments (Task 16), four notifications (Tasks 17-18), e2e + cleanup (Tasks 19-20). CQA/SLA/public submission correctly absent.
- **Deviation from spec §4 wording:** attachments use the codebase's storage-key convention (`storedName` + `putObject`, mirroring `HipaaCertificate`) rather than Blob `url`/`pathname`; the single report<->strike FK lives on `DisciplinaryAction.reportId` (no `strikeActionId` column on `IncidentReport`). Both match existing patterns and the spec's intent.
- **Director behavior change** (confirmed with the user): directors request strikes and read their department's non-confidential strikes (`incidents.view_strikes`); they no longer issue directly (the strikes page `issueActionForm` now requires `incidents.manage`).

