# Pre-acceptance Language Assessment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the interpreting department assess an applicant's languages BEFORE the applicant is accepted, for departments flagged as needing it (PATS and INTP), and show which cycle and department every language review row belongs to.

**Architecture:** The language review queue gains a second, DERIVED source. Nothing is written at application submit: `listLanguageReviewQueue()` computes applicant rows from live applications, and a verdict is stored only when a reviewer records one, on a new `ApplicationLanguageAssessment` row anchored on `applicationId`. A person with a verdict already on file never re-enters the queue. At promotion the verdict is copied onto `PersonLanguage` so the new member is never re-assessed.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma + Postgres, Vitest against a real local test database, Tailwind with `@/platform/ui` primitives.

**Spec:** `docs/superpowers/specs/2026-09-08-pre-acceptance-language-assessment-design.md`

## Global Constraints

- **No em-dashes anywhere.** CI enforces `local/no-em-dash`; a single one fails lint. Use a comma, a colon, or two sentences.
- **Platform code must not import module code.** `src/platform/**` may not import `@/modules/**` (eslint `no-restricted-imports`). All new query code lives in `src/platform/languages` and reads Prisma models directly. `promotion.ts` is module code and MAY import from platform.
- **Permission is `volunteers.verify_spanish`.** Do not rename it. Renaming a permission requires a production re-grant.
- **Route stays `/volunteers/spanish-review`.** Renaming breaks bookmarks.
- **The 1-5 score is INTERNAL.** It renders on staff-gated pages only, never on `/my-info` and never in an email to the person it describes.
- **A score belongs to Spanish (`"es"`) only.** Any other language carrying a score is a caller bug and must throw `LanguageValidationError`.
- **Migrations are hand-written**, in `prisma/migrations/<timestamp>_<name>/migration.sql`, with a comment block explaining why. Do NOT run `prisma migrate dev`: it folds pre-existing schema drift into your migration.
- **Run the full lint before pushing:** `npx eslint src e2e` (plain `npm run lint` walks a gitignored design-system directory).
- **Verification command set:** `npx eslint src e2e && npm run typecheck && npm test`.

---

### Task 1: Schema, migration, and department catalog

**Files:**
- Modify: `prisma/schema.prisma` (Department model; new ApplicationLanguageAssessment model)
- Create: `prisma/migrations/20260908120000_pre_acceptance_language_assessment/migration.sql`
- Modify: `prisma/department-catalog.ts`
- Test: `src/modules/admin/services/departments.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma model `ApplicationLanguageAssessment` with fields `id, applicationId, language, verified, verifiedAt, verifiedById, note, score, createdAt, updatedAt` and unique `(applicationId, language)`; `Department.assessLanguageBeforeAcceptance: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/admin/services/departments.test.ts`. Add the import at the top of the file alongside the existing imports:

```ts
import { DEPARTMENTS } from "../../../../prisma/department-catalog";
```

```ts
describe("pre-acceptance language assessment flag", () => {
  // PATS and INTP are the departments whose applicants the interpreting
  // department assesses before an accept decision. The flag is what puts an
  // applicant in the pre-acceptance queue, so seeding it wrong silently
  // empties the queue.
  it("is set on PATS and INTP in the catalog and on no other department", () => {
    const flagged = DEPARTMENTS.filter((d) => d.assessLanguageBeforeAcceptance).map((d) => d.code);
    expect(flagged.sort()).toEqual(["INTP", "PATS"]);
  });

  it("defaults to false on a department created without it", async () => {
    const dept = await prisma.department.create({
      data: { code: "ZZTOP", name: "Test Department" },
    });
    expect(dept.assessLanguageBeforeAcceptance).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/admin/services/departments.test.ts -t "pre-acceptance language assessment flag"`

Expected: FAIL. The catalog test fails because no entry has the property; the default test fails to typecheck / at runtime because the column does not exist.

- [ ] **Step 3: Add the schema changes**

In `prisma/schema.prisma`, add this field to `model Department`, next to `autoRouteApplicants`:

```prisma
  /// Applicants to this department are assessed on their languages by the
  /// interpreting department BEFORE an accept decision, rather than after
  /// promotion like everyone else. True for PATS and INTP.
  ///
  /// A flag rather than two hardcoded codes in platform/languages: departments
  /// are configurable data in this app, and Department already carries this
  /// kind of per-department behaviour switch (autoRouteApplicants,
  /// minInterpreterScore). Defaults false so no existing department is dragged
  /// into the lane by the migration.
  assessLanguageBeforeAcceptance Boolean @default(false)
```

Add this model near `PersonLanguage`:

```prisma
/// One interpreting-department verdict on one language, for one APPLICATION.
///
/// The pre-acceptance twin of PersonLanguage's assessment half. It cannot live
/// on PersonLanguage: an applicant has no Person row until promotion, which
/// runs after acceptance AND onboarding, and PersonLanguage.personId is a
/// required FK.
///
/// Anchored on applicationId rather than applicantId because Application is
/// already @@unique([cycleId, applicantId]), so this is one row per person per
/// cycle per language with no extra constraint needed.
///
/// Carried onto PersonLanguage at promotion (see carryForwardApplicationAssessments),
/// so an accepted member is never re-queued for a language already assessed.
model ApplicationLanguageAssessment {
  id            String   @id @default(cuid())
  applicationId String
  /// Lowercase code from LANGUAGE_CODES, matching PersonLanguage.language.
  language      String
  /// The OUTCOME. Unlike PersonLanguage there is no separate verifiedAt to read
  /// it against: the existence of the row IS the assessment, so `verified`
  /// stands alone here and a "no" is a row with verified = false.
  verified      Boolean
  verifiedAt    DateTime @default(now())
  /// Bare id (no FK), mirroring PersonLanguage.verifiedById.
  verifiedById  String
  note          String?
  /// Internal 1-5 proficiency score, Spanish only. Never shown to the applicant.
  score         Int?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  /// Cascade: the verdict belongs to the application.
  application Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)

  @@unique([applicationId, language])
  @@index([language])
}
```

Add the back-relation to `model Application`, next to `acceptances` and `interviews`:

```prisma
  languageAssessments    ApplicationLanguageAssessment[]
```

- [ ] **Step 4: Write the migration**

Create `prisma/migrations/20260908120000_pre_acceptance_language_assessment/migration.sql`:

```sql
-- Pre-acceptance language assessment.
--
-- Two changes, one feature:
--
--  1. Department.assessLanguageBeforeAcceptance marks the departments whose
--     applicants the interpreting department assesses BEFORE an accept
--     decision. A flag rather than two hardcoded codes in application code,
--     because departments are configurable data here.
--
--  2. ApplicationLanguageAssessment holds the verdict. It cannot live on
--     PersonLanguage: an applicant has no Person row until promotion, which
--     runs after acceptance and onboarding, and PersonLanguage.personId is a
--     required FK.
--
-- The UPDATE at the bottom is load-bearing, not a convenience. prisma/seed.ts
-- upserts departments with `update: { name, isActive }` only, so a value set on
-- the create path in department-catalog.ts never reaches a database where the
-- row already exists. Vercel runs `prisma migrate deploy` and never the seed,
-- so without this the flag would be false in production forever and the queue
-- would stay empty. Same reasoning as the RBAC grant backfills.

ALTER TABLE "Department"
  ADD COLUMN "assessLanguageBeforeAcceptance" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ApplicationLanguageAssessment" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedById" TEXT NOT NULL,
    "note" TEXT,
    "score" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationLanguageAssessment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApplicationLanguageAssessment_applicationId_language_key"
  ON "ApplicationLanguageAssessment"("applicationId", "language");

CREATE INDEX "ApplicationLanguageAssessment_language_idx"
  ON "ApplicationLanguageAssessment"("language");

ALTER TABLE "ApplicationLanguageAssessment"
  ADD CONSTRAINT "ApplicationLanguageAssessment_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Idempotent: a re-run sets the same two rows to the same value.
UPDATE "Department"
   SET "assessLanguageBeforeAcceptance" = true
 WHERE "code" IN ('PATS', 'INTP');
```

- [ ] **Step 5: Update the department catalog**

In `prisma/department-catalog.ts`, add the property to the exported type:

```ts
export const DEPARTMENTS: {
  code: string;
  name: string;
  requiresEpicDirector?: EpicRequirementLiteral;
  requiresEpicVolunteer?: EpicRequirementLiteral;
  epicGuidance?: string;
  allowShiftDrop?: boolean;
  assessLanguageBeforeAcceptance?: boolean;
}[] = [
```

Extend the file's header comment, after the `allowShiftDrop` paragraph:

```ts
// assessLanguageBeforeAcceptance mirrors the Department column of the same
// name. Create-path only, for the same reason as the Epic columns. Existing
// databases get it from the 20260908120000 migration's backfill, NOT from here.
```

Set it on the two entries:

```ts
  { code: "INTP", name: "Interpreting", requiresEpicDirector: "NONE", requiresEpicVolunteer: "NONE", assessLanguageBeforeAcceptance: true },
```

```ts
  { code: "PATS", name: "Patient Services", requiresEpicDirector: "ALL", requiresEpicVolunteer: "ALL", assessLanguageBeforeAcceptance: true },
```

- [ ] **Step 6: Apply the migration and regenerate the client**

Run, in order:

```bash
npm run db:deploy
npx prisma generate
npm run test:prepare
```

`test:prepare` re-applies migrations to the test template database. Skipping it leaves the test database without the new table, and every test in this plan fails with "relation does not exist".

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run src/modules/admin/services/departments.test.ts`

Expected: PASS, including the pre-existing tests in the file.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/department-catalog.ts prisma/migrations/20260908120000_pre_acceptance_language_assessment src/modules/admin/services/departments.test.ts
git commit -m "feat(languages): add the pre-acceptance assessment table and department flag"
```

---

### Task 2: Admin plumbing for the department flag

**Files:**
- Modify: `src/modules/admin/services/departments.ts`
- Modify: `src/modules/admin/components/department-form.tsx`
- Modify: `src/app/(app)/admin/departments/[id]/page.tsx:40-63`
- Modify: `src/app/(app)/admin/departments/new/page.tsx:20-40`
- Test: `src/modules/admin/services/departments.test.ts`

**Interfaces:**
- Consumes: `Department.assessLanguageBeforeAcceptance` from Task 1.
- Produces: `updateDepartment` and `createDepartment` accept an optional `assessLanguageBeforeAcceptance?: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/admin/services/departments.test.ts`. Follow the file's existing helpers for creating an actor and a department; if it has none, create a person with `prisma.person.create({ data: { name: "Admin" } })` and use its id as the actor.

```ts
describe("updateDepartment and the pre-acceptance flag", () => {
  it("sets the flag when the form supplies it", async () => {
    const actor = await prisma.person.create({ data: { name: "Admin" } });
    const dept = await prisma.department.create({ data: { code: "AAAA", name: "A" } });

    const updated = await updateDepartment(actor.id, dept.id, {
      name: "A",
      isActive: true,
      assessLanguageBeforeAcceptance: true,
    });

    expect(updated.assessLanguageBeforeAcceptance).toBe(true);
  });

  // Same rule as autoRouteApplicants and allowShiftDrop: an update that does
  // not mention the flag must preserve it. A bare `input.x ?? false` here would
  // silently empty the pre-acceptance queue the next time anyone renamed PATS.
  it("preserves the flag on an update that does not mention it", async () => {
    const actor = await prisma.person.create({ data: { name: "Admin" } });
    const dept = await prisma.department.create({
      data: { code: "BBBB", name: "B", assessLanguageBeforeAcceptance: true },
    });

    const updated = await updateDepartment(actor.id, dept.id, { name: "B renamed", isActive: true });

    expect(updated.assessLanguageBeforeAcceptance).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/admin/services/departments.test.ts -t "pre-acceptance flag"`

Expected: FAIL, with a TypeScript error that `assessLanguageBeforeAcceptance` is not in the input type.

- [ ] **Step 3: Thread the flag through the service**

In `src/modules/admin/services/departments.ts`, add to the `updateDepartment` input type, beside `allowShiftDrop`:

```ts
    /** Optional for the same reason as autoRouteApplicants: an update that does
     *  not touch it must preserve it rather than silently dropping the
     *  department out of the pre-acceptance assessment lane. */
    assessLanguageBeforeAcceptance?: boolean;
```

Add the resolution line beside the `allowShiftDrop` one:

```ts
  const assessLanguageBeforeAcceptance =
    input.assessLanguageBeforeAcceptance ?? before.assessLanguageBeforeAcceptance;
```

Add it to the `data:` object of `prisma.department.update`, and to BOTH the `before:` and `after:` objects of the `recordAudit` call:

```ts
      assessLanguageBeforeAcceptance: before.assessLanguageBeforeAcceptance,
```

```ts
      assessLanguageBeforeAcceptance: dept.assessLanguageBeforeAcceptance,
```

Do the same for the create path: add `assessLanguageBeforeAcceptance?: boolean;` to the create input type and `assessLanguageBeforeAcceptance: input.assessLanguageBeforeAcceptance ?? false,` to its `data:` object, matching how `autoRouteApplicants` is handled there.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/admin/services/departments.test.ts`

Expected: PASS.

- [ ] **Step 5: Add the form control**

In `src/modules/admin/components/department-form.tsx`, add `"assessLanguageBeforeAcceptance"` to the `department` prop's picked key union (beside `"autoRouteApplicants"`), and add this block directly after the `autoRouteApplicants` block:

```tsx
        <div className="space-y-2">
          <Checkbox
            name="assessLanguageBeforeAcceptance"
            defaultChecked={department?.assessLanguageBeforeAcceptance ?? false}
            label="Assess applicants' languages before accepting them"
          />
          <p className="text-xs text-muted-foreground">
            For departments where speaking the language IS the job. Applicants to this department
            appear in the interpreting department&rsquo;s language review queue as soon as they
            apply, rather than after they are promoted, so the assessment is on the table when the
            decision is made. Advisory only: it never blocks an acceptance. Anyone with an
            assessment already on file is skipped.
          </p>
        </div>
```

- [ ] **Step 6: Wire both pages**

In `src/app/(app)/admin/departments/[id]/page.tsx`, inside `updateAction`, add beside `autoRouteApplicants`:

```ts
        assessLanguageBeforeAcceptance: formData.get("assessLanguageBeforeAcceptance") === "on",
```

Make the identical addition in `src/app/(app)/admin/departments/new/page.tsx`.

- [ ] **Step 7: Verify types and lint**

Run: `npm run typecheck && npx eslint src e2e`

Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/modules/admin src/app/\(app\)/admin/departments
git commit -m "feat(admin): let a department opt into pre-acceptance language assessment"
```

---

### Task 3: `priorLanguageVerdicts`, the on-file lookup

**Files:**
- Create: `src/platform/languages/applicant-review.ts`
- Test: `src/platform/languages/applicant-review.test.ts`

**Interfaces:**
- Consumes: `ApplicationLanguageAssessment` from Task 1.
- Produces:

```ts
export type LanguageVerdict = {
  language: string;
  verified: boolean;
  score: number | null;
  note: string | null;
  assessedAt: Date;
  assessedById: string | null;
  source: "member" | "application" | "history";
  /** Set when source is "application". */
  applicationId: string | null;
  /** Set when source is "history": the term label, e.g. "Spring 2025". */
  term: string | null;
};

/** applicantId -> language -> the verdict that stands for that person. */
export async function priorLanguageVerdicts(
  applicantIds: string[],
): Promise<Map<string, Map<string, LanguageVerdict>>>;
```

- [ ] **Step 1: Write the failing test**

Create `src/platform/languages/applicant-review.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { priorLanguageVerdicts } from "./applicant-review";

beforeEach(resetDb);

/** A cycle plus one applicant in it, identified by email. */
async function applicantIn(cycleTitle: string, email: string, personId?: string) {
  const lead = await prisma.person.create({ data: { name: "Lead" } });
  const term = await prisma.term.create({
    data: {
      code: `T${Math.random().toString(36).slice(2, 6)}`, name: "Term",
      startDate: new Date(), endDate: new Date(), status: "ACTIVE", clinicDates: [],
    },
  });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: cycleTitle,
      publicSlug: `s-${Math.random()}`, departments: ["PATS"],
      createdById: lead.id, status: "OPEN",
    },
  });
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace",
      email, emailLower: email.toLowerCase(), applicantPersonId: personId ?? null,
    },
  });
  const application = await prisma.application.create({
    data: {
      cycleId: cycle.id, applicantId: applicant.id, answers: {},
      applicantType: "NEW", departmentChoices: ["PATS"],
    },
  });
  return { cycle, applicant, application };
}

describe("priorLanguageVerdicts", () => {
  it("finds a verified PersonLanguage row through a linked person", async () => {
    const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
    await prisma.personLanguage.create({
      data: {
        personId: person.id, language: "es", verified: true,
        verifiedAt: new Date("2026-01-01"), verifiedById: "assessor", score: 4,
      },
    });
    const { applicant } = await applicantIn("Fall 2026", "ada@yale.edu", person.id);

    const map = await priorLanguageVerdicts([applicant.id]);

    expect(map.get(applicant.id)?.get("es")).toMatchObject({
      verified: true, score: 4, source: "member",
    });
  });

  // A recorded "no" settles the question exactly as it does in the member
  // queue, where a "no" stamps verifiedAt and removes the row for good.
  it("treats a recorded no as a verdict on file", async () => {
    const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
    await prisma.personLanguage.create({
      data: {
        personId: person.id, language: "es", verified: false,
        verifiedAt: new Date("2026-01-01"), verifiedById: "assessor",
      },
    });
    const { applicant } = await applicantIn("Fall 2026", "ada@yale.edu", person.id);

    const map = await priorLanguageVerdicts([applicant.id]);

    expect(map.get(applicant.id)?.get("es")?.verified).toBe(false);
  });

  // The member queue filters on status ACTIVE because it is deciding whose
  // worklist a MEMBER belongs on. This is a different question: an alum
  // reapplying still has their assessment on file.
  it("finds a verdict on an OFFBOARDED person", async () => {
    const person = await prisma.person.create({ data: { name: "Ada Lovelace", status: "OFFBOARDED" } });
    await prisma.personLanguage.create({
      data: {
        personId: person.id, language: "es", verified: true,
        verifiedAt: new Date("2026-01-01"), verifiedById: "assessor", score: 5,
      },
    });
    const { applicant } = await applicantIn("Fall 2026", "ada@yale.edu", person.id);

    const map = await priorLanguageVerdicts([applicant.id]);

    expect(map.get(applicant.id)?.get("es")?.score).toBe(5);
  });

  // A claim is not a verdict. verifiedAt IS NULL is exactly the state that puts
  // someone IN the queue, so it must never keep them out of it.
  it("does not treat an unassessed claim as a verdict", async () => {
    const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
    await prisma.personLanguage.create({
      data: { personId: person.id, language: "es", selfReported: true },
    });
    const { applicant } = await applicantIn("Fall 2026", "ada@yale.edu", person.id);

    const map = await priorLanguageVerdicts([applicant.id]);

    expect(map.get(applicant.id)?.get("es")).toBeUndefined();
  });

  // The case with no Person at all: a rejected applicant reapplying next year.
  it("finds a prior cycle's application verdict by email, with no person anywhere", async () => {
    const last = await applicantIn("Fall 2025", "ada@yale.edu");
    await prisma.applicationLanguageAssessment.create({
      data: {
        applicationId: last.application.id, language: "es", verified: true,
        verifiedById: "assessor", score: 3, verifiedAt: new Date("2025-09-01"),
      },
    });
    const now = await applicantIn("Fall 2026", "Ada@Yale.edu");

    const map = await priorLanguageVerdicts([now.applicant.id]);

    expect(map.get(now.applicant.id)?.get("es")).toMatchObject({
      verified: true, score: 3, source: "application",
    });
  });

  it("finds a SpanishAssessmentRecord linked to the resolved person", async () => {
    const person = await prisma.person.create({ data: { name: "Ada Lovelace" } });
    await prisma.spanishAssessmentRecord.create({
      data: {
        email: "", name: "Ada Lovelace", personId: person.id,
        term: "Spring 2019", termRank: 20191, score: 4, verified: true,
      },
    });
    const { applicant } = await applicantIn("Fall 2026", "ada@yale.edu", person.id);

    const map = await priorLanguageVerdicts([applicant.id]);

    expect(map.get(applicant.id)?.get("es")).toMatchObject({
      score: 4, source: "history", term: "Spring 2019",
    });
  });

  it("returns an empty map for an applicant with nothing on file", async () => {
    const { applicant } = await applicantIn("Fall 2026", "nobody@yale.edu");

    const map = await priorLanguageVerdicts([applicant.id]);

    expect(map.get(applicant.id)?.size ?? 0).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/languages/applicant-review.test.ts`

Expected: FAIL with "Failed to resolve import ./applicant-review".

- [ ] **Step 3: Implement `priorLanguageVerdicts`**

Create `src/platform/languages/applicant-review.ts`:

```ts
/**
 * The pre-acceptance half of language review.
 *
 * The interpreting department assesses applicants to certain departments (see
 * Department.assessLanguageBeforeAcceptance) BEFORE an accept decision, because
 * for those departments speaking the language IS the job. Everyone else is
 * assessed after promotion, through the PersonLanguage queue in ./index.
 *
 * Nothing here is written at application submit. The queue is DERIVED from live
 * applications and a verdict is stored only when a reviewer records one, so a
 * withdrawal, a rejection, a reopen, or a deleted application drops out of the
 * queue on its own with no cleanup path to maintain.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { SPANISH } from "./catalog";

/** One human verdict on one language, whatever record it came from. */
export type LanguageVerdict = {
  language: string;
  verified: boolean;
  score: number | null;
  note: string | null;
  assessedAt: Date;
  assessedById: string | null;
  source: "member" | "application" | "history";
  /** Set when source is "application". */
  applicationId: string | null;
  /** Set when source is "history": the term label, e.g. "Spring 2025". */
  term: string | null;
};

/** Later verdicts win. Ties keep the incumbent, so the read order does not matter. */
function keepLater(a: LanguageVerdict | undefined, b: LanguageVerdict): LanguageVerdict {
  if (!a) return b;
  return b.assessedAt > a.assessedAt ? b : a;
}

/**
 * Every language on which a human has already assessed these applicants,
 * whatever the outcome, so the queue can skip work that is already done.
 *
 * Identity is resolved the way getApplicantHistory resolves it:
 * Applicant.applicantPersonId when they signed in, Applicant.emailLower
 * otherwise. Three sources, because a verdict can exist in any of them and only
 * one of them is the obvious place:
 *
 *   1. PersonLanguage, for a linked Person. NOT filtered on Person.status: an
 *      offboarded alum reapplying still has their assessment on file, and
 *      languageReviewWhere()'s ACTIVE filter answers a different question
 *      (whose worklist a MEMBER belongs on).
 *   2. ApplicationLanguageAssessment on any application of the same identity,
 *      including the one being queued. This is what stops a rejected applicant
 *      being re-assessed when they reapply next year.
 *   3. SpanishAssessmentRecord linked to the Person, Spanish only.
 *      backfill-language-badges only carried historical scores onto
 *      PersonLanguage for ACTIVE people, so an alum's score is here and nowhere
 *      else.
 *
 * The 1423 unlinked historical records are deliberately NOT matched by email:
 * matching them is documented as exhausted (not one matches any Person by
 * email, name, or NetID). They are alumni, not a lookup source.
 */
export async function priorLanguageVerdicts(
  applicantIds: string[],
): Promise<Map<string, Map<string, LanguageVerdict>>> {
  const out = new Map<string, Map<string, LanguageVerdict>>();
  if (applicantIds.length === 0) return out;

  const applicants = await prisma.applicant.findMany({
    where: { id: { in: applicantIds } },
    select: { id: true, emailLower: true, applicantPersonId: true },
  });
  if (applicants.length === 0) return out;
  for (const a of applicants) out.set(a.id, new Map());

  const personIds = [
    ...new Set(applicants.map((a) => a.applicantPersonId).filter((id): id is string => id !== null)),
  ];
  const emails = [...new Set(applicants.map((a) => a.emailLower))];

  const [memberRows, applicationRows, historyRows] = await Promise.all([
    personIds.length === 0
      ? []
      : prisma.personLanguage.findMany({
          where: { personId: { in: personIds }, verifiedAt: { not: null } },
          select: {
            personId: true, language: true, verified: true, score: true,
            note: true, verifiedAt: true, verifiedById: true,
          },
        }),
    prisma.applicationLanguageAssessment.findMany({
      where: {
        application: {
          applicant: {
            OR: [
              { emailLower: { in: emails } },
              ...(personIds.length === 0 ? [] : [{ applicantPersonId: { in: personIds } }]),
            ],
          },
        },
      },
      select: {
        applicationId: true, language: true, verified: true, score: true,
        note: true, verifiedAt: true, verifiedById: true,
        application: { select: { applicant: { select: { emailLower: true, applicantPersonId: true } } } },
      },
    }),
    personIds.length === 0
      ? []
      : prisma.spanishAssessmentRecord.findMany({
          where: { personId: { in: personIds } },
          select: { personId: true, score: true, verified: true, term: true, termRank: true, updatedAt: true },
        }),
  ]);

  const byPerson = new Map<string, string[]>();
  const byEmail = new Map<string, string[]>();
  for (const a of applicants) {
    if (a.applicantPersonId) {
      byPerson.set(a.applicantPersonId, [...(byPerson.get(a.applicantPersonId) ?? []), a.id]);
    }
    byEmail.set(a.emailLower, [...(byEmail.get(a.emailLower) ?? []), a.id]);
  }

  function put(applicantId: string, verdict: LanguageVerdict): void {
    const forApplicant = out.get(applicantId);
    if (!forApplicant) return;
    forApplicant.set(verdict.language, keepLater(forApplicant.get(verdict.language), verdict));
  }

  for (const r of memberRows) {
    for (const applicantId of byPerson.get(r.personId) ?? []) {
      put(applicantId, {
        language: r.language,
        verified: r.verified,
        score: r.score,
        note: r.note,
        // verifiedAt is non-null by the query's own where clause.
        assessedAt: r.verifiedAt as Date,
        assessedById: r.verifiedById,
        source: "member",
        applicationId: null,
        term: null,
      });
    }
  }

  for (const r of applicationRows) {
    const owner = r.application.applicant;
    const targets = new Set([
      ...(owner.applicantPersonId ? (byPerson.get(owner.applicantPersonId) ?? []) : []),
      ...(byEmail.get(owner.emailLower) ?? []),
    ]);
    for (const applicantId of targets) {
      put(applicantId, {
        language: r.language,
        verified: r.verified,
        score: r.score,
        note: r.note,
        assessedAt: r.verifiedAt,
        assessedById: r.verifiedById,
        source: "application",
        applicationId: r.applicationId,
        term: null,
      });
    }
  }

  for (const r of historyRows) {
    if (!r.personId) continue;
    for (const applicantId of byPerson.get(r.personId) ?? []) {
      put(applicantId, {
        language: SPANISH,
        // An imported row with no explicit outcome still records that INTP sat
        // down with this person, which is the fact that spares them a re-assessment.
        verified: r.verified ?? true,
        score: r.score,
        note: null,
        assessedAt: r.updatedAt,
        assessedById: null,
        source: "history",
        applicationId: null,
        term: r.term,
      });
    }
  }

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/languages/applicant-review.test.ts`

Expected: PASS, all seven tests.

- [ ] **Step 5: Commit**

```bash
git add src/platform/languages/applicant-review.ts src/platform/languages/applicant-review.test.ts
git commit -m "feat(languages): find the language verdicts an applicant already has on file"
```

---

### Task 4: `listApplicantLanguageQueue`, the derived queue source

**Files:**
- Modify: `src/platform/languages/applicant-review.ts`
- Test: `src/platform/languages/applicant-review.test.ts`

**Interfaces:**
- Consumes: `priorLanguageVerdicts` from Task 3.
- Produces:

```ts
export type ApplicantQueueRow = {
  applicationId: string;
  applicantId: string;
  name: string;
  netId: string | null;
  email: string;
  language: string;
  cycleTitle: string;
  /** Routed department first when one is set, then the ranked choices. */
  departments: string[];
  /** Codes offered as a dual role, rendered with a "(dual)" marker. */
  dualRoleDepartments: string[];
};

export async function listApplicantLanguageQueue(): Promise<ApplicantQueueRow[]>;
```

- [ ] **Step 1: Write the failing test**

Append to `src/platform/languages/applicant-review.test.ts`. Add `listApplicantLanguageQueue` to the import from `./applicant-review`, and add this helper above the new describe block:

```ts
/** A flagged department, an unflagged one, a term, a cycle, and a lead. */
async function lane() {
  const lead = await prisma.person.create({ data: { name: "Lead" } });
  const [pats, educ] = await Promise.all([
    prisma.department.create({
      data: { code: "PATS", name: "Patient Services", assessLanguageBeforeAcceptance: true },
    }),
    prisma.department.create({ data: { code: "EDUC", name: "Education" } }),
  ]);
  const term = await prisma.term.create({
    data: {
      code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(),
      status: "ACTIVE", clinicDates: [],
    },
  });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: "Fall 2026 Volunteers",
      publicSlug: `s-${Math.random()}`, departments: ["PATS", "EDUC"],
      createdById: lead.id, status: "OPEN",
    },
  });
  return { lead, pats, educ, term, cycle };
}

/** One submitted application in the seeded cycle. */
async function apply(
  ctx: Awaited<ReturnType<typeof lane>>,
  email: string,
  overrides: Record<string, unknown> = {},
) {
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: ctx.cycle.id, firstName: "Ada", lastName: "Lovelace",
      email, emailLower: email.toLowerCase(),
    },
  });
  const application = await prisma.application.create({
    // The cast is load-bearing: `overrides` is an open record so the spread
    // cannot be narrowed to Prisma's generated create input. Each test supplies
    // real column names, and a typo surfaces immediately as a failing assertion.
    data: {
      cycleId: ctx.cycle.id, applicantId: applicant.id, answers: {},
      applicantType: "NEW", departmentChoices: ["PATS"],
      status: "SUBMITTED", submittedAt: new Date(),
      ...overrides,
    } as never,
  });
  return { applicant, application };
}

describe("listApplicantLanguageQueue", () => {
  it("queues Spanish for a flagged-department applicant who claimed nothing", async () => {
    const ctx = await lane();
    await apply(ctx, "ada@yale.edu");

    const rows = await listApplicantLanguageQueue();

    expect(rows.map((r) => r.language)).toEqual(["es"]);
    expect(rows[0].cycleTitle).toBe("Fall 2026 Volunteers");
    expect(rows[0].departments).toEqual(["PATS"]);
  });

  it("queues every other language the applicant claimed alongside Spanish", async () => {
    const ctx = await lane();
    await apply(ctx, "ada@yale.edu", { languagesClaimed: ["fr", "ht"] });

    const rows = await listApplicantLanguageQueue();

    expect(rows.map((r) => r.language).sort()).toEqual(["es", "fr", "ht"]);
  });

  it("ignores an applicant to an unflagged department", async () => {
    const ctx = await lane();
    await apply(ctx, "ada@yale.edu", { departmentChoices: ["EDUC"] });

    expect(await listApplicantLanguageQueue()).toEqual([]);
  });

  it("queues a dual-role offer to a flagged department from an unflagged primary", async () => {
    const ctx = await lane();
    await prisma.department.create({
      data: { code: "INTP", name: "Interpreting", assessLanguageBeforeAcceptance: true },
    });
    await apply(ctx, "ada@yale.edu", {
      departmentChoices: ["EDUC"], dualRoleDepartments: ["INTP"],
    });

    const rows = await listApplicantLanguageQueue();

    expect(rows).toHaveLength(1);
    expect(rows[0].dualRoleDepartments).toEqual(["INTP"]);
  });

  it("ignores a withdrawn application", async () => {
    const ctx = await lane();
    await apply(ctx, "ada@yale.edu", { status: "WITHDRAWN", withdrawnAt: new Date() });

    expect(await listApplicantLanguageQueue()).toEqual([]);
  });

  it("ignores an application in an ARCHIVED cycle", async () => {
    const ctx = await lane();
    await apply(ctx, "ada@yale.edu");
    await prisma.recruitmentCycle.update({
      where: { id: ctx.cycle.id }, data: { status: "ARCHIVED" },
    });

    expect(await listApplicantLanguageQueue()).toEqual([]);
  });

  it("ignores a volunteer application the department has already decided", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu");
    await prisma.application.update({
      where: { id: application.id }, data: { decision: "REJECT", decidedAt: new Date() },
    });

    expect(await listApplicantLanguageQueue()).toEqual([]);
  });

  // The regression the second decided-clause exists for. A DIRECTOR-track
  // application is decided on Interview.decision and its Application.decision
  // stays PENDING forever, so testing only the latter parks every decided
  // director applicant in the queue permanently.
  it("ignores a director application decided on its interview", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu");
    await prisma.interview.create({
      data: {
        applicationId: application.id, departmentCode: "PATS",
        decision: "ACCEPT", scheduledAt: new Date(),
      },
    });

    expect(await listApplicantLanguageQueue()).toEqual([]);
  });

  it("ignores an accepted application", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu");
    await prisma.acceptance.create({
      data: { applicationId: application.id, departmentCode: "PATS", approvedById: ctx.lead.id },
    });

    expect(await listApplicantLanguageQueue()).toEqual([]);
  });

  it("drops a language already assessed on this application", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu", { languagesClaimed: ["fr"] });
    await prisma.applicationLanguageAssessment.create({
      data: {
        applicationId: application.id, language: "es",
        verified: true, verifiedById: ctx.lead.id, score: 4,
      },
    });

    const rows = await listApplicantLanguageQueue();

    expect(rows.map((r) => r.language)).toEqual(["fr"]);
  });

  it("drops a language with a verdict on file from a previous life", async () => {
    const ctx = await lane();
    const person = await prisma.person.create({ data: { name: "Ada Lovelace", status: "OFFBOARDED" } });
    await prisma.personLanguage.create({
      data: {
        personId: person.id, language: "es", verified: true,
        verifiedAt: new Date("2025-01-01"), verifiedById: ctx.lead.id, score: 5,
      },
    });
    const applicant = await prisma.applicant.create({
      data: {
        cycleId: ctx.cycle.id, firstName: "Ada", lastName: "Lovelace",
        email: "ada@yale.edu", emailLower: "ada@yale.edu", applicantPersonId: person.id,
      },
    });
    await prisma.application.create({
      data: {
        cycleId: ctx.cycle.id, applicantId: applicant.id, answers: {},
        applicantType: "NEW", departmentChoices: ["PATS"],
        status: "SUBMITTED", submittedAt: new Date(),
      },
    });

    expect(await listApplicantLanguageQueue()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/languages/applicant-review.test.ts -t "listApplicantLanguageQueue"`

Expected: FAIL, `listApplicantLanguageQueue is not a function`.

- [ ] **Step 3: Implement the queue**

Append to `src/platform/languages/applicant-review.ts`:

```ts
/** One (application, language) pair the interpreting department still owes a verdict on. */
export type ApplicantQueueRow = {
  applicationId: string;
  applicantId: string;
  name: string;
  netId: string | null;
  email: string;
  language: string;
  cycleTitle: string;
  /** Routed department first when one is set, then the ranked choices. */
  departments: string[];
  /** Codes offered as a dual role, rendered with a "(dual)" marker. */
  dualRoleDepartments: string[];
};

/**
 * Applications whose department has opted into pre-acceptance assessment, that
 * nobody has decided yet, crossed with the languages still owing a verdict.
 *
 * Spanish is always in the set, claim or no claim: the point of the lane is to
 * confirm Spanish before the department commits, and an applicant who
 * under-reported is exactly the case the assessment exists to catch. Every
 * other language they claimed rides along, because the interpreting department
 * interprets in more than one.
 */
export async function listApplicantLanguageQueue(): Promise<ApplicantQueueRow[]> {
  const laneDepartments = await prisma.department.findMany({
    where: { assessLanguageBeforeAcceptance: true },
    select: { code: true },
  });
  const laneCodes = laneDepartments.map((d) => d.code);
  if (laneCodes.length === 0) return [];

  const applications = await prisma.application.findMany({
    where: {
      status: "SUBMITTED",
      withdrawnAt: null,
      // Undecided, tested twice on purpose. Application.decision carries the
      // routed department's verdict on a VOLUNTEER application, but a
      // DIRECTOR-track application is decided on Interview.decision and leaves
      // Application.decision PENDING forever. Testing only the first would
      // park every decided director applicant here permanently.
      decision: "PENDING",
      interviews: { none: { decision: { not: "PENDING" } } },
      acceptances: { none: {} },
      cycle: { status: { not: "ARCHIVED" } },
      OR: [
        { departmentChoices: { hasSome: laneCodes } },
        { dualRoleDepartments: { hasSome: laneCodes } },
        { routedDepartmentCode: { in: laneCodes } },
        // A DIRECTOR-track renewal has no routedDepartmentCode: submissions.ts
        // only sets that for the VOLUNTEER track. Without this clause a
        // returning PATS director would never be queued.
        { renewalDepartment: { in: laneCodes } },
      ],
    },
    select: {
      id: true,
      languagesClaimed: true,
      departmentChoices: true,
      dualRoleDepartments: true,
      routedDepartmentCode: true,
      renewalDepartment: true,
      cycle: { select: { title: true } },
      applicant: { select: { id: true, firstName: true, lastName: true, netId: true, email: true } },
      languageAssessments: { select: { language: true } },
    },
    orderBy: [{ applicant: { lastName: "asc" } }, { applicant: { firstName: "asc" } }],
  });
  if (applications.length === 0) return [];

  const onFile = await priorLanguageVerdicts(applications.map((a) => a.applicant.id));

  const rows: ApplicantQueueRow[] = [];
  for (const app of applications) {
    const assessedHere = new Set(app.languageAssessments.map((a) => a.language));
    const assessedEver = onFile.get(app.applicant.id) ?? new Map<string, LanguageVerdict>();
    const wanted = [SPANISH, ...app.languagesClaimed];

    const routedFirst = [
      ...(app.routedDepartmentCode ? [app.routedDepartmentCode] : []),
      ...(app.renewalDepartment && app.renewalDepartment !== app.routedDepartmentCode
        ? [app.renewalDepartment]
        : []),
      ...app.departmentChoices.filter(
        (c) => c !== app.routedDepartmentCode && c !== app.renewalDepartment,
      ),
    ];

    for (const language of new Set(wanted)) {
      if (assessedHere.has(language)) continue;
      if (assessedEver.has(language)) continue;
      rows.push({
        applicationId: app.id,
        applicantId: app.applicant.id,
        name: `${app.applicant.firstName} ${app.applicant.lastName}`.trim(),
        netId: app.applicant.netId,
        email: app.applicant.email,
        language,
        cycleTitle: app.cycle.title,
        departments: routedFirst,
        dualRoleDepartments: app.dualRoleDepartments,
      });
    }
  }
  return rows;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/languages/applicant-review.test.ts`

Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/platform/languages/applicant-review.ts src/platform/languages/applicant-review.test.ts
git commit -m "feat(languages): derive a pre-acceptance queue from live applications"
```

---

### Task 5: `recordApplicationLanguageAssessment`

**Files:**
- Modify: `src/platform/languages/applicant-review.ts`
- Test: `src/platform/languages/applicant-review.test.ts`

**Interfaces:**
- Consumes: `ApplicationLanguageAssessment` from Task 1.
- Produces:

```ts
export async function recordApplicationLanguageAssessment(
  actorPersonId: string,
  input: {
    applicationId: string;
    language: string;
    verified: boolean;
    note?: string | null;
    score?: number | null;
  },
): Promise<void>;
```

- [ ] **Step 1: Write the failing test**

Append to `src/platform/languages/applicant-review.test.ts`, adding `recordApplicationLanguageAssessment` to the import from `./applicant-review` and `LanguageValidationError` to a new import from `./catalog`:

```ts
describe("recordApplicationLanguageAssessment", () => {
  it("records the verdict, the score, and an audit row", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu");

    await recordApplicationLanguageAssessment(ctx.lead.id, {
      applicationId: application.id, language: "es", verified: true, score: 4,
    });

    const row = await prisma.applicationLanguageAssessment.findUniqueOrThrow({
      where: { applicationId_language: { applicationId: application.id, language: "es" } },
    });
    expect(row).toMatchObject({ verified: true, score: 4, verifiedById: ctx.lead.id });

    const audit = await prisma.auditLog.findFirst({
      where: { action: "application.language_assess", entityId: application.id },
    });
    expect(audit).not.toBeNull();
  });

  it("re-recording overwrites rather than creating a second row", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu");

    await recordApplicationLanguageAssessment(ctx.lead.id, {
      applicationId: application.id, language: "es", verified: true, score: 4,
    });
    await recordApplicationLanguageAssessment(ctx.lead.id, {
      applicationId: application.id, language: "es", verified: false, score: 2,
    });

    const rows = await prisma.applicationLanguageAssessment.findMany({
      where: { applicationId: application.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verified: false, score: 2 });
  });

  it("rejects an unknown language", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu");

    await expect(
      recordApplicationLanguageAssessment(ctx.lead.id, {
        applicationId: application.id, language: "klingon", verified: true,
      }),
    ).rejects.toBeInstanceOf(LanguageValidationError);
  });

  it("rejects a score outside 1 to 5", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu");

    await expect(
      recordApplicationLanguageAssessment(ctx.lead.id, {
        applicationId: application.id, language: "es", verified: true, score: 6,
      }),
    ).rejects.toBeInstanceOf(LanguageValidationError);
  });

  // The score is the INTP Spanish assessment. A score on any other language is
  // a caller bug, not something to quietly drop.
  it("rejects a score on a language other than Spanish", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu");

    await expect(
      recordApplicationLanguageAssessment(ctx.lead.id, {
        applicationId: application.id, language: "fr", verified: true, score: 4,
      }),
    ).rejects.toBeInstanceOf(LanguageValidationError);
  });

  // An applicant has no Person and no /my-info to link them to, so there is
  // nobody to notify and nowhere to send them. The outcome reaches them through
  // the acceptance decision.
  it("queues no email to the applicant", async () => {
    const ctx = await lane();
    const { application } = await apply(ctx, "ada@yale.edu");

    await recordApplicationLanguageAssessment(ctx.lead.id, {
      applicationId: application.id, language: "es", verified: true, score: 4,
    });

    expect(await prisma.emailMessage.count({ where: { to: "ada@yale.edu" } })).toBe(0);
  });
});
```

If the queued-email model is not named `emailMessage`, open `src/platform/email` and use whatever `queueEmail` writes to; the assertion is "no row addressed to the applicant".

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/languages/applicant-review.test.ts -t "recordApplicationLanguageAssessment"`

Expected: FAIL, `recordApplicationLanguageAssessment is not a function`.

- [ ] **Step 3: Implement the recorder**

Add to the imports at the top of `src/platform/languages/applicant-review.ts`:

```ts
import { recordAudit } from "@/platform/audit";
import { LanguageValidationError, SPANISH, isLanguageCode, languageLabel } from "./catalog";
```

(Replace the existing `import { SPANISH } from "./catalog";` line with the one above.)

Append:

```ts
/**
 * Record the interpreting department's verdict on one language for one
 * application. Same validation as recordLanguageAssessment, and deliberately
 * one difference: it notifies nobody.
 *
 * recordLanguageAssessment emails the member and links them to /my-info. An
 * applicant has neither a Person nor a /my-info page, and telling someone their
 * language was "not confirmed" before anyone has decided on their application
 * would land as a rejection they have not received. The outcome reaches them
 * through the acceptance decision instead.
 */
export async function recordApplicationLanguageAssessment(
  actorPersonId: string,
  input: {
    applicationId: string;
    language: string;
    verified: boolean;
    note?: string | null;
    score?: number | null;
  },
): Promise<void> {
  if (!isLanguageCode(input.language)) {
    throw new LanguageValidationError(`Unknown language "${input.language}".`);
  }
  const score = input.score ?? null;
  if (score !== null) {
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new LanguageValidationError(`Score must be 1-5, got "${score}".`);
    }
    if (input.language !== SPANISH) {
      throw new LanguageValidationError(
        `Only ${languageLabel(SPANISH)} carries a proficiency score.`,
      );
    }
  }

  const key = {
    applicationId_language: { applicationId: input.applicationId, language: input.language },
  };
  const before = await prisma.applicationLanguageAssessment.findUnique({
    where: key,
    select: { verified: true, score: true },
  });

  await prisma.applicationLanguageAssessment.upsert({
    where: key,
    create: {
      applicationId: input.applicationId,
      language: input.language,
      verified: input.verified,
      verifiedAt: new Date(),
      verifiedById: actorPersonId,
      note: input.note?.trim() || null,
      score,
    },
    update: {
      verified: input.verified,
      verifiedAt: new Date(),
      verifiedById: actorPersonId,
      note: input.note?.trim() || null,
      score,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "application.language_assess",
    entityType: "Application",
    entityId: input.applicationId,
    before: {
      language: input.language,
      verified: before?.verified ?? null,
      score: before?.score ?? null,
    },
    after: { language: input.language, verified: input.verified, score },
  });
}
```

Note the score semantics differ from `recordLanguageAssessment` on purpose: there, an omitted score means "the form did not ask, leave the stored one alone", because the member form has two variants. Here every write comes from one form that always shows the score field for Spanish, so an omitted score means N/A and stores null. Say so in a one-line comment if a reviewer asks.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/languages/applicant-review.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/languages/applicant-review.ts src/platform/languages/applicant-review.test.ts
git commit -m "feat(languages): record an interpreting verdict against an application"
```

---

### Task 6: Merge the two sources into one queue with cycle and department context

**Files:**
- Modify: `src/platform/languages/index.ts:52-90`
- Test: `src/platform/languages/index.test.ts`

**Interfaces:**
- Consumes: `listApplicantLanguageQueue` and `ApplicantQueueRow` from Task 4.
- Produces: a changed `LanguageReviewRow`:

```ts
export type LanguageReviewRow = {
  /** PersonLanguage id for a member; `${applicationId}:${language}` for an applicant. */
  id: string;
  source: "member" | "applicant";
  /** Null for an applicant: they have no Person until promotion. */
  personId: string | null;
  /** Null for a member. */
  applicationId: string | null;
  name: string;
  netId: string | null;
  language: string;
  languageLabel: string;
  score: number | null;
  /** "Fall 2026 Volunteers" for an applicant, the active term name for a member. */
  contextLabel: string;
  /** Department codes. A dual-role offer is rendered as "INTP (dual)". */
  departments: string[];
};
```

- [ ] **Step 1: Write the failing test**

Append to `src/platform/languages/index.test.ts`. Reuse the seeding style from `applicant-review.test.ts`.

```ts
describe("listLanguageReviewQueue with both sources", () => {
  it("puts applicant rows first, each with its cycle and departments", async () => {
    const lead = await prisma.person.create({ data: { name: "Lead" } });
    await prisma.department.create({
      data: { code: "PATS", name: "Patient Services", assessLanguageBeforeAcceptance: true },
    });
    const term = await prisma.term.create({
      data: {
        code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(),
        status: "ACTIVE", clinicDates: [],
      },
    });
    const cycle = await prisma.recruitmentCycle.create({
      data: {
        track: "VOLUNTEER", termId: term.id, title: "Fall 2026 Volunteers",
        publicSlug: `s-${Math.random()}`, departments: ["PATS"],
        createdById: lead.id, status: "OPEN",
      },
    });
    const applicant = await prisma.applicant.create({
      data: {
        cycleId: cycle.id, firstName: "Zoe", lastName: "Zephyr",
        email: "zoe@yale.edu", emailLower: "zoe@yale.edu",
      },
    });
    await prisma.application.create({
      data: {
        cycleId: cycle.id, applicantId: applicant.id, answers: {},
        applicantType: "NEW", departmentChoices: ["PATS"],
        status: "SUBMITTED", submittedAt: new Date(),
      },
    });

    // A member claim, which sorts after every applicant despite the earlier name.
    const member = await prisma.person.create({ data: { name: "Ada Member", status: "ACTIVE" } });
    await claimLanguage(member.id, "es");

    const rows = await listLanguageReviewQueue();

    expect(rows.map((r) => r.source)).toEqual(["applicant", "member"]);
    expect(rows[0]).toMatchObject({
      name: "Zoe Zephyr",
      personId: null,
      contextLabel: "Fall 2026 Volunteers",
      departments: ["PATS"],
    });
    expect(rows[1]).toMatchObject({ name: "Ada Member", applicationId: null });
  });

  it("marks a dual-role department on an applicant row", async () => {
    const lead = await prisma.person.create({ data: { name: "Lead" } });
    await Promise.all([
      prisma.department.create({ data: { code: "EDUC", name: "Education" } }),
      prisma.department.create({
        data: { code: "INTP", name: "Interpreting", assessLanguageBeforeAcceptance: true },
      }),
    ]);
    const term = await prisma.term.create({
      data: {
        code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(),
        status: "ACTIVE", clinicDates: [],
      },
    });
    const cycle = await prisma.recruitmentCycle.create({
      data: {
        track: "VOLUNTEER", termId: term.id, title: "Fall 2026 Volunteers",
        publicSlug: `s-${Math.random()}`, departments: ["EDUC"],
        createdById: lead.id, status: "OPEN",
      },
    });
    const applicant = await prisma.applicant.create({
      data: {
        cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace",
        email: "ada@yale.edu", emailLower: "ada@yale.edu",
      },
    });
    await prisma.application.create({
      data: {
        cycleId: cycle.id, applicantId: applicant.id, answers: {},
        applicantType: "NEW", departmentChoices: ["EDUC"],
        dualRoleDepartments: ["INTP"], status: "SUBMITTED", submittedAt: new Date(),
      },
    });

    const rows = await listLanguageReviewQueue();

    expect(rows[0].departments).toEqual(["EDUC", "INTP (dual)"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/languages/index.test.ts -t "both sources"`

Expected: FAIL. `source` and `contextLabel` are not on the returned rows.

- [ ] **Step 3: Rewrite `listLanguageReviewQueue`**

In `src/platform/languages/index.ts`, add to the imports:

```ts
import { listApplicantLanguageQueue } from "./applicant-review";
```

and re-export the applicant surface next to the existing `export * from "./catalog";`:

```ts
export * from "./applicant-review";
```

Replace the `LanguageReviewRow` type and `listLanguageReviewQueue` with:

```ts
export type LanguageReviewRow = {
  /** PersonLanguage id for a member; `${applicationId}:${language}` for an applicant. */
  id: string;
  source: "member" | "applicant";
  /** Null for an applicant: they have no Person until promotion. */
  personId: string | null;
  /** Null for a member. */
  applicationId: string | null;
  name: string;
  netId: string | null;
  language: string;
  languageLabel: string;
  score: number | null;
  /** "Fall 2026 Volunteers" for an applicant, the active term name for a member. */
  contextLabel: string;
  /** Department codes. A dual-role offer is rendered as "INTP (dual)". */
  departments: string[];
};

/**
 * One queue, two sources.
 *
 * MEMBERS are claims awaiting assessment, as they always were. This used to
 * split on active-term INTP membership into a scored queue and an unscored
 * "general" one, which meant a Spanish speaker outside interpreting never got a
 * number at all. Do not reintroduce that split.
 *
 * APPLICANTS come from ./applicant-review: people applying to a department that
 * assesses before it accepts. They sort FIRST because they are the ones holding
 * up a decision, and because a member's claim can wait for the next assessment
 * session while an application window cannot.
 */
export async function listLanguageReviewQueue(): Promise<LanguageReviewRow[]> {
  const [applicantRows, memberRows, activeTerm] = await Promise.all([
    listApplicantLanguageQueue(),
    prisma.personLanguage.findMany({
      where: languageReviewWhere(),
      orderBy: [{ person: { name: "asc" } }, { language: "asc" }],
      select: {
        id: true,
        personId: true,
        language: true,
        score: true,
        person: { select: { name: true, netId: true } },
      },
    }),
    getActiveTerm(),
  ]);

  const memberIds = memberRows.map((r) => r.personId);
  // Department context for the member half. Resolved live from the ACTIVE
  // memberships in the ACTIVE term, matching how every other roster read here
  // resolves a person's departments.
  const memberships = activeTerm
    ? await prisma.termMembership.findMany({
        where: { personId: { in: memberIds }, termId: activeTerm.id, status: "ACTIVE" },
        select: { personId: true, department: { select: { code: true } } },
      })
    : [];
  const deptsByPerson = new Map<string, string[]>();
  for (const m of memberships) {
    deptsByPerson.set(m.personId, [...(deptsByPerson.get(m.personId) ?? []), m.department.code]);
  }

  const applicants: LanguageReviewRow[] = applicantRows.map((r) => ({
    id: `${r.applicationId}:${r.language}`,
    source: "applicant",
    personId: null,
    applicationId: r.applicationId,
    name: r.name,
    netId: r.netId,
    language: r.language,
    languageLabel: languageLabel(r.language),
    score: null,
    contextLabel: r.cycleTitle,
    departments: [...r.departments, ...r.dualRoleDepartments.map((c) => `${c} (dual)`)],
  }));

  const members: LanguageReviewRow[] = memberRows.map((r) => ({
    id: r.id,
    source: "member",
    personId: r.personId,
    applicationId: null,
    name: r.person.name,
    netId: r.person.netId,
    language: r.language,
    languageLabel: languageLabel(r.language),
    score: r.score,
    contextLabel: activeTerm?.name ?? "",
    departments: (deptsByPerson.get(r.personId) ?? []).sort(),
  }));

  return [...applicants, ...members];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/languages`

Expected: PASS. Typecheck will still fail in the review page, which Task 7 fixes.

- [ ] **Step 5: Commit**

```bash
git add src/platform/languages
git commit -m "feat(languages): one review queue over members and applicants, with context"
```

---

### Task 7: The queue UI

**Files:**
- Create: `src/platform/ui/score-options.tsx`
- Create: `src/app/(app)/volunteers/spanish-review/queue-tab.tsx`
- Modify: `src/app/(app)/volunteers/spanish-review/page.tsx` (the `queue` tab block at 258-313, the `assessAction` at 118-142, the `AssessForm` at 691-731, and the `ScoreOptions` at 660-671)

**Interfaces:**
- Consumes: `LanguageReviewRow` (Task 6), `recordApplicationLanguageAssessment` (Task 5).
- Produces: `QueueTab`, a server component taking `{ rows, assessMemberAction, assessApplicantAction }`; `ScoreOptions` at `@/platform/ui/score-options`, which Task 9 also imports.

- [ ] **Step 1: Move `ScoreOptions` somewhere both callers can reach**

`ScoreOptions` is used by the queue tab (moving out of `page.tsx`), by the history tab (staying in `page.tsx`), and by Task 9's card (in `src/modules`). A module component may not import from an app route directory, so `src/platform/ui` is the only shared home.

Create `src/platform/ui/score-options.tsx` with the body currently at `page.tsx:660-671`, exported, importing `Select` from `./select` and `SPANISH_PROFICIENCY_LEVELS` from `@/platform/languages/catalog`. Keep the markup byte-identical. Delete the local copy from `page.tsx` and import the new one there.

- [ ] **Step 2: Extract the queue tab into its own file**

The page is already 786 lines and the queue tab is about to grow. Create `src/app/(app)/volunteers/spanish-review/queue-tab.tsx`. `EmptyCard` (`page.tsx:643-649`) stays in `page.tsx` because the history and crosscheck tabs still use it; the queue tab uses `<EmptyState title="..." bordered />` from `@/platform/ui/empty-state` directly, which is what the local wrapper approximates and what the `local/no-adhoc-empty-state` lint rule points at. Note the block variant takes `title` and optional `description` props, NOT children; only the `inline` variant takes children.

```tsx
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { SubmitButton } from "@/platform/ui/submit-button";
import { EmptyState } from "@/platform/ui/empty-state";
import type { LanguageReviewRow } from "@/platform/languages";
import { SPANISH, formatSpanishScore, spanishScoreTone } from "@/platform/languages/catalog";
import { ScoreOptions } from "@/platform/ui/score-options";

/**
 * The review queue, over both sources.
 *
 * Applicant rows come first and carry an "Applicant" badge: they are blocking a
 * department's accept decision, while a member's claim can wait for the next
 * assessment session. The Cycle / Department column is what tells a reviewer
 * which of the two they are looking at without reading the badge.
 */
export function QueueTab({
  rows,
  assessMemberAction,
  assessApplicantAction,
}: {
  rows: LanguageReviewRow[];
  assessMemberAction: (formData: FormData) => Promise<void>;
  assessApplicantAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-foreground">Language review queue</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Everyone awaiting assessment. Applicants come first: their departments assess before
          accepting, so a verdict here goes straight onto the application. Record a 1-5 proficiency
          score for Spanish speakers before verifying: departments differ on the score they will
          staff, so a conversational speaker is useful to someone even when they are below the
          clinic-wide interpreting bar. The score is internal and is never shown to the volunteer.
          Anyone with an assessment already on file does not appear.
        </p>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No one is awaiting language review." bordered />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Language</TH>
              <TH>NetID</TH>
              <TH>Cycle / Department</TH>
              <TH>Current score</TH>
              <TH>Assessment</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map((r) => (
              <TR key={r.id}>
                <TD className="font-medium">
                  <div className="flex items-center gap-2">
                    <span>{r.name}</span>
                    {r.source === "applicant" && <Badge tone="warning">Applicant</Badge>}
                  </div>
                </TD>
                <TD>
                  <Badge>{r.languageLabel}</Badge>
                </TD>
                <TD className="text-muted-foreground">
                  {r.netId ?? <span className="text-subtle-foreground">-</span>}
                </TD>
                <TD className="text-xs text-muted-foreground">
                  <div>{r.contextLabel || <span className="text-subtle-foreground">-</span>}</div>
                  {r.departments.length > 0 && (
                    <div className="text-subtle-foreground">{r.departments.join(", ")}</div>
                  )}
                </TD>
                <TD>
                  {r.language !== SPANISH ? (
                    <span className="text-xs text-subtle-foreground">-</span>
                  ) : r.score === null ? (
                    <span className="text-xs text-subtle-foreground">Not yet scored</span>
                  ) : (
                    <Badge tone={spanishScoreTone(r.score)}>{formatSpanishScore(r.score, null)}</Badge>
                  )}
                </TD>
                <TD>
                  <AssessForm
                    row={r}
                    action={r.source === "applicant" ? assessApplicantAction : assessMemberAction}
                    withScore={r.language === SPANISH}
                  />
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

function AssessForm({
  row,
  action,
  withScore,
}: {
  row: LanguageReviewRow;
  action: (formData: FormData) => Promise<void>;
  withScore: boolean;
}) {
  return (
    <form action={action} className="flex flex-col gap-2">
      {/* One of the two, never both: an applicant has no Person and a member has
          no application. The action each form is bound to reads only its own. */}
      {row.source === "applicant" ? (
        <input type="hidden" name="applicationId" value={row.applicationId ?? ""} />
      ) : (
        <input type="hidden" name="personId" value={row.personId ?? ""} />
      )}
      <input type="hidden" name="language" value={row.language} />
      {withScore && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="shrink-0">Score:</span>
          <ScoreOptions name="score" defaultValue={String(row.score ?? "")} />
        </div>
      )}
      <div className="flex gap-2">
        <SubmitButton variant="primary" size="sm" name="verified" value="true" pendingLabel="Saving...">
          Verify
        </SubmitButton>
        <SubmitButton variant="outline" size="sm" name="verified" value="false" pendingLabel="Saving...">
          Not verified
        </SubmitButton>
      </div>
    </form>
  );
}
```

- [ ] **Step 3: Add the applicant action to the page**

In `page.tsx`, rename `assessAction` to `assessMemberAction` (updating its one call site) and add beside it:

```ts
  async function assessApplicantAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.verify_spanish");
    const applicationId = String(formData.get("applicationId") ?? "");
    const language = String(formData.get("language") ?? "");
    const verified = formData.get("verified") === "true";
    const score = normalizeScore(formData.get("score"));

    try {
      await recordApplicationLanguageAssessment(actor.personId, {
        applicationId,
        language,
        verified,
        score,
      });
    } catch (err) {
      redirect(tabHref("queue", { error: messageFor(err, "Could not record that assessment.") }));
    }
    revalidatePath(BASE_PATH);
    redirect(tabHref("queue", { ok: "Assessment recorded." }));
  }
```

Add `recordApplicationLanguageAssessment` to the existing `@/platform/languages` import.

- [ ] **Step 4: Swap the inline queue block for the component**

Replace the whole `{activeTab === "queue" && ( ... )}` block in `page.tsx` with:

```tsx
      {activeTab === "queue" && (
        <QueueTab
          rows={queueRows}
          assessMemberAction={assessMemberAction}
          assessApplicantAction={assessApplicantAction}
        />
      )}
```

Import it: `import { QueueTab } from "./queue-tab";`. Remove any imports the page no longer uses (`Table`, `THead`, `TR`, `TH`, `TD` are probably still needed by the history and crosscheck tabs; `SPANISH`, `spanishScoreTone`, `formatSpanishScore` may not be). The lint step catches leftovers.

- [ ] **Step 5: Verify types and lint**

Run: `npm run typecheck && npx eslint src e2e`

Expected: both clean.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`

Expected: PASS. Also run `npx vitest run src/platform` on its own: the platform guard tests fire from anywhere and are easy to miss.

- [ ] **Step 7: Commit**

```bash
git add src/platform/ui/score-options.tsx src/app/\(app\)/volunteers/spanish-review
git commit -m "feat(volunteers): show applicants, their cycle, and their departments in the queue"
```

---

### Task 8: Carry the verdict forward at promotion

**Files:**
- Modify: `src/platform/languages/applicant-review.ts`
- Modify: `src/modules/recruitment/services/promotion.ts:36-45, 200-225, 344-350, 405-410`
- Test: `src/modules/recruitment/services/promotion.language-carry-forward.test.ts` (create)

**Interfaces:**
- Consumes: `ApplicationLanguageAssessment` (Task 1).
- Produces:

```ts
export async function carryForwardApplicationAssessments(
  personId: string,
  applicationId: string,
  client: Prisma.TransactionClient,
): Promise<Array<{ language: string; verified: boolean; score: number | null }>>;
```

- [ ] **Step 1: Write the failing test**

Create `src/modules/recruitment/services/promotion.language-carry-forward.test.ts`. Model the seeding on the existing `promotion.dual-roles.test.ts` in the same directory: copy its cycle, applicant, application, acceptance, and onboarding-contract setup verbatim, then adapt the assertions below. Do not invent a different fixture shape.

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { promoteContracts } from "./promotion";

beforeEach(resetDb);

describe("promotion carries a pre-acceptance language verdict forward", () => {
  it("writes a VERIFIED PersonLanguage keeping the original assessor and score", async () => {
    // seed(): a cycle, an applicant, a SUBMITTED onboarding contract for an
    // accepted PATS application, and an SRR actor with recruitment.review_all.
    const ctx = await seed();
    await prisma.applicationLanguageAssessment.create({
      data: {
        applicationId: ctx.application.id, language: "es", verified: true,
        verifiedById: ctx.assessor.id, score: 4, verifiedAt: new Date("2026-03-01"),
      },
    });

    await promoteContracts([ctx.contract.id], ctx.srr.id);

    const person = await prisma.person.findFirstOrThrow({ where: { name: ctx.applicantName } });
    const row = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: person.id, language: "es" } },
    });
    expect(row).toMatchObject({ verified: true, score: 4, verifiedById: ctx.assessor.id });
    expect(row.verifiedAt).toEqual(new Date("2026-03-01"));
  });

  // The whole point: a member INTP already assessed must not come back round.
  it("leaves the promoted person out of the review queue", async () => {
    const ctx = await seed();
    await prisma.applicationLanguageAssessment.create({
      data: {
        applicationId: ctx.application.id, language: "es", verified: true,
        verifiedById: ctx.assessor.id, score: 4,
      },
    });

    await promoteContracts([ctx.contract.id], ctx.srr.id);

    const queued = await prisma.personLanguage.count({ where: { verifiedAt: null } });
    expect(queued).toBe(0);
  });

  it("still creates a plain claim for a language nobody assessed", async () => {
    const ctx = await seed();
    await prisma.application.update({
      where: { id: ctx.application.id }, data: { languagesClaimed: ["fr"] },
    });

    await promoteContracts([ctx.contract.id], ctx.srr.id);

    const person = await prisma.person.findFirstOrThrow({ where: { name: ctx.applicantName } });
    const row = await prisma.personLanguage.findUniqueOrThrow({
      where: { personId_language: { personId: person.id, language: "fr" } },
    });
    expect(row.verifiedAt).toBeNull();
    expect(row.selfReported).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/promotion.language-carry-forward.test.ts`

Expected: FAIL. The first two fail because the promoted row is an unassessed claim.

- [ ] **Step 3: Add the carry-forward helper**

Append to `src/platform/languages/applicant-review.ts`:

```ts
/**
 * Copy an application's pre-acceptance verdicts onto the person promotion just
 * created, so a member the interpreting department already assessed is never
 * put back in the queue.
 *
 * Preserves the ORIGINAL assessor and timestamp rather than stamping the
 * promoting SRR: the fact being recorded is INTP's assessment, made weeks
 * earlier, and re-stamping it would misattribute an interpreting judgment to
 * whoever happened to run the promotion.
 *
 * Runs inside the promotion transaction, so it takes a client. The Spanish
 * history mirror does NOT: it needs the active term and can fail on its own,
 * and the transaction must not stretch across work like that. The caller does
 * it afterwards, from the returned list.
 */
export async function carryForwardApplicationAssessments(
  personId: string,
  applicationId: string,
  client: Prisma.TransactionClient,
): Promise<Array<{ language: string; verified: boolean; score: number | null }>> {
  const assessments = await client.applicationLanguageAssessment.findMany({
    where: { applicationId },
    select: { language: true, verified: true, score: true, note: true, verifiedAt: true, verifiedById: true },
  });
  if (assessments.length === 0) return [];

  const existing = await client.personLanguage.findMany({
    where: { personId, language: { in: assessments.map((a) => a.language) } },
    select: { language: true, verifiedAt: true },
  });
  const standingVerdictAt = new Map(
    existing
      .filter((e) => e.verifiedAt !== null)
      .map((e) => [e.language, e.verifiedAt as Date]),
  );

  const carried: Array<{ language: string; verified: boolean; score: number | null }> = [];
  for (const a of assessments) {
    // A reactivated member may already carry a verdict. Only write when the
    // application's is NEWER, so re-onboarding an alum cannot roll their record
    // back to an assessment from a previous cycle. Their carried verdict is
    // still returned, because they must stay out of the reviewer digest either
    // way: the language IS assessed, just not by this row.
    const standing = standingVerdictAt.get(a.language);
    carried.push({ language: a.language, verified: a.verified, score: a.score });
    if (standing && standing >= a.verifiedAt) continue;

    await client.personLanguage.upsert({
      where: { personId_language: { personId, language: a.language } },
      create: {
        personId,
        language: a.language,
        selfReported: true,
        verified: a.verified,
        verifiedAt: a.verifiedAt,
        verifiedById: a.verifiedById,
        note: a.note,
        score: a.score,
      },
      update: {
        selfReported: true,
        verified: a.verified,
        verifiedAt: a.verifiedAt,
        verifiedById: a.verifiedById,
        note: a.note,
        score: a.score,
      },
    });
  }

  return carried;
}
```

- [ ] **Step 4: Wire it into promotion**

In `src/modules/recruitment/services/promotion.ts`:

Add to the import from `@/platform/languages`:

```ts
import { carryForwardApplicationAssessments, claimLanguage, notifyReviewersOfPendingClaims } from "@/platform/languages";
```

Declare a batch collector beside `pendingLanguageClaims`:

```ts
  // Spanish verdicts carried forward this batch, mirrored into the assessment
  // history AFTER every transaction has committed. Same reason the notification
  // digest waits: the mirror needs the active term and can fail on its own.
  const carriedSpanish: Array<{ personId: string; verified: boolean; score: number | null }> = [];
```

Inside the transaction, immediately BEFORE the `for (const code of claimedLanguages)` loop:

```ts
        // Verdicts INTP recorded before the accept decision. Written first, and
        // as verdicts rather than claims, so the claimLanguage loop below finds
        // an assessed row and leaves it alone (it upserts selfReported only).
        const carried = application
          ? await carryForwardApplicationAssessments(person.id, application.id, tx)
          : [];
        const carriedLanguages = new Set(carried.map((c) => c.language));
```

Change the claim loop to skip carried languages, so a carried verdict never reports as a new claim:

```ts
        for (const code of claimedLanguages) {
          if (carriedLanguages.has(code)) continue;
          const { created } = await claimLanguage(person.id, code, tx);
          if (created) newClaims.push({ personId: person.id, language: code });
        }
```

Return the carried Spanish rows from the transaction callback, adding to the existing return object:

```ts
        return {
          isNew,
          personId: person.id,
          newClaims,
          newDualRoles,
          carriedSpanish: carried
            .filter((c) => c.language === "es")
            .map((c) => ({ personId: person.id, verified: c.verified, score: c.score })),
        };
```

And collect them beside the existing pushes:

```ts
      carriedSpanish.push(...result.carriedSpanish);
```

Finally, beside the two notify calls at the end of `promoteContracts`:

```ts
  // The assessment history mirror, after every transaction has committed.
  // Best-effort: a missing ACTIVE term means there is nothing to file under,
  // and PersonLanguage above is already the authoritative current score.
  const activeTerm = await getActiveTerm();
  if (activeTerm) {
    for (const c of carriedSpanish) {
      try {
        await upsertSpanishAssessmentForTerm({
          personId: c.personId,
          term: activeTerm.name,
          score: c.score,
          verified: c.verified,
        });
      } catch (err) {
        log.error(
          "[promotion] failed to mirror a carried Spanish assessment into history",
          errorAttrs(err, { personId: c.personId }),
        );
      }
    }
  }
```

Add the two imports this needs:

```ts
import { getActiveTerm } from "@/platform/terms/active-term";
import { upsertSpanishAssessmentForTerm } from "@/platform/languages/spanish-assessments";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/promotion.language-carry-forward.test.ts`

Expected: PASS.

- [ ] **Step 6: Run the neighbouring promotion suites**

Run: `npx vitest run src/modules/recruitment/services/promotion.test.ts src/modules/recruitment/services/promotion.dual-roles.test.ts src/modules/recruitment/services/promotion.posthog.test.ts`

Expected: PASS. These cover the claim loop you just changed.

- [ ] **Step 7: Commit**

```bash
git add src/platform/languages/applicant-review.ts src/modules/recruitment/services/promotion.ts src/modules/recruitment/services/promotion.language-carry-forward.test.ts
git commit -m "feat(recruitment): carry a pre-acceptance language verdict onto the promoted member"
```

---

### Task 9: The advisory card on the application detail page

**Files:**
- Create: `src/modules/recruitment/components/language-assessment-card.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts`
- Test: `src/app/(app)/recruitment/cycles/[id]/applicants/actions.test.ts`

**Interfaces:**
- Consumes: `priorLanguageVerdicts`, `recordApplicationLanguageAssessment` (Tasks 3 and 5).
- Produces: `assessApplicantLanguageAction(formData)` in the applicants actions file; `LanguageAssessmentCard`.

- [ ] **Step 1: Write the failing test**

Append to `src/app/(app)/recruitment/cycles/[id]/applicants/actions.test.ts`, following that file's existing session-mocking pattern for `requirePermission`:

```ts
describe("assessApplicantLanguageAction", () => {
  it("records a verdict against the application", async () => {
    const ctx = await seedApplication(); // reuse the file's existing helper
    const form = new FormData();
    form.set("applicationId", ctx.application.id);
    form.set("language", "es");
    form.set("verified", "true");
    form.set("score", "4");

    await assessApplicantLanguageAction(form);

    const row = await prisma.applicationLanguageAssessment.findUniqueOrThrow({
      where: { applicationId_language: { applicationId: ctx.application.id, language: "es" } },
    });
    expect(row).toMatchObject({ verified: true, score: 4 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "src/app/(app)/recruitment/cycles/[id]/applicants/actions.test.ts" -t "assessApplicantLanguageAction"`

Expected: FAIL, the action does not exist.

- [ ] **Step 3: Add the action**

In `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts`, following the shape of the actions already there:

```ts
export async function assessApplicantLanguageAction(formData: FormData) {
  "use server";
  const actor = await requirePermission("volunteers.verify_spanish");
  const applicationId = String(formData.get("applicationId") ?? "");
  const language = String(formData.get("language") ?? "");
  const verified = formData.get("verified") === "true";
  const raw = String(formData.get("score") ?? "");
  const score = raw === "" ? null : Number(raw);

  await recordApplicationLanguageAssessment(actor.personId, {
    applicationId,
    language,
    verified,
    score,
  });
  revalidatePath(`/recruitment/cycles`);
}
```

Match the file's existing error handling and `revalidatePath` target rather than copying the path above blindly; open the neighbouring actions and follow them.

- [ ] **Step 4: Build the card**

Create `src/modules/recruitment/components/language-assessment-card.tsx`:

```tsx
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { SubmitButton } from "@/platform/ui/submit-button";
import { DateTime } from "@/platform/dates/display";
import type { LanguageVerdict } from "@/platform/languages";
import { SPANISH, formatSpanishScore, languageLabel, spanishScoreTone } from "@/platform/languages/catalog";

/**
 * What the interpreting department knows about this applicant's languages, on
 * the page where the department decides.
 *
 * ADVISORY. Nothing here gates the accept control: the department reads the
 * score and makes the call, which is the whole reason the assessment happens
 * before acceptance rather than after promotion.
 */
export function LanguageAssessmentCard({
  applicationId,
  languages,
  verdicts,
  canAssess,
  action,
}: {
  applicationId: string;
  /** Spanish plus everything the applicant claimed. */
  languages: string[];
  /** language -> the verdict that stands, from priorLanguageVerdicts. */
  verdicts: Map<string, LanguageVerdict>;
  canAssess: boolean;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <Card>
      <SectionHeader title="Language assessment" />
      <p className="mb-3 text-xs text-muted-foreground">
        The interpreting department assesses this department&rsquo;s applicants before you decide.
        This is for your information: it does not block an acceptance.
      </p>
      <ul className="space-y-3">
        {languages.map((language) => {
          const v = verdicts.get(language);
          const here = v?.applicationId === applicationId;
          return (
            <li key={language} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge>{languageLabel(language)}</Badge>
              {!v ? (
                <span className="text-muted-foreground">Awaiting assessment</span>
              ) : (
                <>
                  <Badge tone={v.verified ? "success" : "critical"}>
                    {v.verified ? "Verified" : "Not verified"}
                  </Badge>
                  {language === SPANISH && v.score !== null && (
                    <Badge tone={spanishScoreTone(v.score)}>{formatSpanishScore(v.score, null)}</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {here ? "assessed for this application" : "already on file"}
                    {v.term ? `, ${v.term}` : null}, <DateTime value={v.assessedAt} />
                  </span>
                </>
              )}
              {canAssess && v && !here && (
                <form action={action} className="ml-auto">
                  <input type="hidden" name="applicationId" value={applicationId} />
                  <input type="hidden" name="language" value={language} />
                  <span className="flex items-center gap-2">
                    <ScoreOptions name="score" defaultValue={String(v.score ?? "")} />
                    <SubmitButton variant="ghost" size="sm" name="verified" value="true" pendingLabel="Saving...">
                      Verify
                    </SubmitButton>
                    <SubmitButton variant="ghost" size="sm" name="verified" value="false" pendingLabel="Saving...">
                      Not verified
                    </SubmitButton>
                  </span>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
```

The "Assess anyway" control carries the same score selector and both outcome buttons as the queue, rather than a bare "record a yes": the case it exists for is an applicant whose only verdict is a stale "no", and a reviewer who could not record the new number would have to go somewhere else to finish the job.

`ScoreOptions` comes from `@/platform/ui/score-options`, where Task 7 puts it. A module component may not import from an app route directory, so this is the only shared home for it.

- [ ] **Step 5: Render the card on the application page**

In `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`, after the existing answer-section cards, load the data and render:

```tsx
  const laneDepartments = await prisma.department.findMany({
    where: { assessLanguageBeforeAcceptance: true },
    select: { code: true },
  });
  const laneCodes = new Set(laneDepartments.map((d) => d.code));
  const applicationDepartments = [
    ...application.departmentChoices,
    ...application.dualRoleDepartments,
    ...(application.routedDepartmentCode ? [application.routedDepartmentCode] : []),
    ...(application.renewalDepartment ? [application.renewalDepartment] : []),
  ];
  const inLane = applicationDepartments.some((c) => laneCodes.has(c));
  const verdicts = inLane
    ? ((await priorLanguageVerdicts([application.applicantId])).get(application.applicantId) ??
       new Map())
    : new Map();
  const assessableLanguages = [...new Set(["es", ...application.languagesClaimed])];
  const canAssessLanguages = await can(session.personId, "volunteers.verify_spanish");
```

```tsx
      {inLane && (
        <LanguageAssessmentCard
          applicationId={application.id}
          languages={assessableLanguages}
          verdicts={verdicts}
          canAssess={canAssessLanguages}
          action={assessApplicantLanguageAction}
        />
      )}
```

Adjust the variable names to whatever `getApplication` actually returns on this page; do not assume the shape above. `can` and `prisma` are already imported there.

- [ ] **Step 6: Run the test and verify types**

Run: `npx vitest run "src/app/(app)/recruitment/cycles/[id]/applicants/actions.test.ts" && npm run typecheck && npx eslint src e2e`

Expected: all clean.

- [ ] **Step 7: Full verification**

Run: `npx eslint src e2e && npm run typecheck && npm test`

Expected: clean. If the suite is red, check `docs` or the test-flake notes before assuming a regression: an environment-caused red suite looks identical to one.

- [ ] **Step 8: Commit**

```bash
git add src/modules/recruitment/components/language-assessment-card.tsx src/app/\(app\)/recruitment/cycles
git commit -m "feat(recruitment): show the language assessment on the application under review"
```

---

## After the plan

Open the PR against `main` from `feat/pre-acceptance-language-assessment`. Two things belong in the description because they are not visible in the diff:

1. The migration flips `assessLanguageBeforeAcceptance` on for PATS and INTP in production. That is what turns the feature on, and it is deliberate.
2. The two things the spec left out on purpose: no notification to INTP when the queue fills, and no score chip on the decisions page.
