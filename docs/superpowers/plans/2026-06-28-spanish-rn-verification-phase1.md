# Spanish self-report + interpreter verification — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `Person.spanishSpeaking` boolean with a self-reported flag plus an interpreter-verified flag (and verifier id/timestamp), repoint scheduling and email-audience at the verified signal, retire the Airtable import of these flags, fix the admin create form so it stops dropping them, and ship a tested INTP-review-queue predicate. Closes issue #68.

**Architecture:** Expand → migrate → contract. First ADD the new columns (every commit stays green because `spanishSpeaking` still exists), then repoint each consumer in its own task, then DROP `spanishSpeaking`. Spanish verification mirrors the existing `HipaaCertificate.verifiedById` / `verifiedAt` pattern (bare id, no FK). Only `spanishVerified` feeds clinical scheduling; `spanishSelfReported` is an intake signal that places a person in the interpreting-department review queue.

**Tech Stack:** Next.js (App Router, server components + server actions), Prisma + PostgreSQL, Vitest (integration tests against a real test DB), TypeScript.

## Global Constraints

- **No em-dashes** in any prose, comment, or copy (use commas, colons, parentheses, or periods). Author preference.
- **Product name** is "HAVEN Hub" (two words) in prose/UI; identifiers stay `havenhub`.
- **`spanishVerified` is the only scheduling-relevant signal.** Self-report never makes a person Spanish-eligible for the schedule.
- **`spanishVerifiedById` is a bare `String?` with no foreign key**, matching `HipaaCertificate.verifiedById`. It may hold any string (tests use a fake actor id).
- **Migrations use the direct/unpooled connection** (`DATABASE_URL_UNPOOLED`); Prisma is provider `postgresql`. `Person.id` is `String @default(cuid())`.
- **Every task ends green:** the touched test file passes and `npm run typecheck` is clean before committing.

---

## Prerequisites (one-time worktree setup)

Vitest ignores `.env` and every worktree otherwise shares `havenhub_test`, which deadlocks parallel runs. Give this worktree its own test DB.

- [ ] **P1: Ensure the local Postgres is running**

Run: `npm run db:up`
Expected: the `postgres` container is up (port 5434).

- [ ] **P2: Create and export a per-worktree test database URL**

```bash
export TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_spanishrn"
docker compose exec -T postgres psql -U haven -d havenhub -c 'CREATE DATABASE havenhub_test_spanishrn' || true
```

Keep `TEST_DATABASE_URL` exported in every shell you run tests from. To run one test file:
`TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run <path>`

- [ ] **P3: Apply current migrations to the dev and test DBs, confirm a clean baseline**

```bash
npm run db:migrate         # applies existing migrations to the dev DB (DATABASE_URL)
npm run test:prepare       # migrate deploy onto the test DB (uses TEST_DATABASE_URL)
TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/platform/people.test.ts
```

Expected: people.test.ts passes (baseline). If it fails before any change, stop and report.

> After EACH migration created in this plan, re-run `npm run test:prepare` so the test DB gets the new columns before you run that task's tests.

---

## Task 1: Expand the schema — add the new columns and backfill

**Files:**
- Modify: `prisma/schema.prisma` (Person model, around lines 134-137)
- Create: `prisma/migrations/<timestamp>_spanish_verification_add/migration.sql`
- Modify: `src/platform/airtable/mirror-map.test.ts:6-27` (the `nullPerson()` full-`Person` literal must gain the new required fields)

**Interfaces:**
- Produces: `Person.spanishSelfReported: boolean`, `Person.spanishVerified: boolean`, `Person.spanishVerifiedAt: Date | null`, `Person.spanishVerifiedById: string | null`. `Person.spanishSpeaking` and `Person.licensedRN` still exist (removed in Task 8).

- [ ] **Step 1: Edit the Person model**

In `prisma/schema.prisma`, replace these lines:

```prisma
  /// Capacity/RHD attributes imported from Airtable; future source is the Recruitment module.
  spanishSpeaking           Boolean              @default(false)
  /// Capacity/RHD attributes imported from Airtable; future source is the Recruitment module.
  licensedRN                Boolean              @default(false)
```

with:

```prisma
  /// Legacy Airtable-sourced flag. Retained during the expand phase; dropped after consumers repoint.
  spanishSpeaking           Boolean              @default(false)
  /// Self-reported at onboarding (or set by an admin). Intake signal only; does NOT gate scheduling.
  spanishSelfReported       Boolean              @default(false)
  /// Interpreting-department-confirmed Spanish capability. Gates clinical scheduling.
  spanishVerified           Boolean              @default(false)
  /// When the interpreting department (or an admin override) recorded the verification. Null = never assessed.
  spanishVerifiedAt         DateTime?
  /// Verifier's Person id. Bare id (no FK), mirroring HipaaCertificate.verifiedById.
  spanishVerifiedById       String?
  /// Self-reported RN licensure. No verification workflow.
  licensedRN                Boolean              @default(false)
```

- [ ] **Step 2: Generate the migration without applying it**

Run: `npx prisma migrate dev --create-only --name spanish_verification_add`
Expected: a new folder `prisma/migrations/<timestamp>_spanish_verification_add/` containing `migration.sql` with `ADD COLUMN` statements. It is NOT yet applied.

- [ ] **Step 3: Append the data backfill to the generated migration**

> The backfill is NOT unit-tested: the Vitest harness applies migrations to an empty DB before any seed, so there is no pre-migration data to assert. Verify it by reviewing the SQL below and, before production deploy, by a manual check on a staging copy of prod data (a `spanishSpeaking = true` person must land as `spanishSelfReported = true, spanishVerified = false, spanishVerifiedAt = null`).

Open the generated `migration.sql`. It will contain the four `ADD COLUMN` lines. Append this backfill at the END of the file (after the ADD COLUMNs, so the new column exists when the UPDATE runs):

```sql

-- Backfill: the legacy Airtable spanishSpeaking flag was a self-report, not an
-- interpreting-department assessment. Carry it to self-reported and leave
-- spanishVerified=false so the interpreting department must assess before it
-- counts clinically. Routes every previously-flagged person into the review queue.
UPDATE "Person" SET "spanishSelfReported" = true WHERE "spanishSpeaking" = true;
```

- [ ] **Step 4: Apply the migration to the dev DB and regenerate the client**

Run: `npx prisma migrate dev`
Expected: "Applying migration ...spanish_verification_add" then "Your database is now in sync"; Prisma Client regenerated.

- [ ] **Step 5: Apply to the test DB**

Run: `npm run test:prepare`
Expected: migrate deploy applies the new migration to the test database.

- [ ] **Step 6: Fix the only full-`Person` literal so typecheck passes**

In `src/platform/airtable/mirror-map.test.ts`, the `nullPerson()` helper builds a complete `Person`. Replace this line:

```typescript
    spanishSpeaking: false,
    licensedRN: false,
```

with:

```typescript
    spanishSpeaking: false,
    spanishSelfReported: false,
    spanishVerified: false,
    spanishVerifiedAt: null,
    spanishVerifiedById: null,
    licensedRN: false,
```

- [ ] **Step 7: Verify typecheck is clean and the mirror-map test still passes**

Run: `npm run typecheck`
Expected: no errors. (If typecheck flags any OTHER full-`Person` object literal missing the new fields, add the same four fields there. `prisma.person.create({ data: {...} })` calls do NOT need them because the columns have defaults.)

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/platform/airtable/mirror-map.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/platform/airtable/mirror-map.test.ts
git commit -m "feat(people): add spanishSelfReported/spanishVerified columns + backfill (expand)"
```

---

## Task 2: Core mutations write the new fields, stamp verification, and close #68

**Files:**
- Modify: `src/platform/people.ts` (PersonInput 63-73; createPersonRecord 86-138; updatePersonFields 140-229)
- Test: `src/platform/people.test.ts` (replace the flags test at 162-177 with the tests below)

**Interfaces:**
- Consumes: `Person.*` fields from Task 1.
- Produces:
  - `PersonInput` gains `spanishSelfReported?: boolean` and `spanishVerified?: boolean` (keeps `licensedRN?`, keeps `spanishSpeaking?` until Task 8).
  - `createPersonRecord(actorPersonId, input)` writes `spanishSelfReported`, `spanishVerified`, `licensedRN`; when `spanishVerified` is true it stamps `spanishVerifiedAt = now` and `spanishVerifiedById = actorPersonId`; audit `after` includes the three booleans.
  - `updatePersonFields(actorPersonId, personId, input)`: a `spanishVerified` `false->true` change stamps verifier+timestamp; `true->false` clears them; other field edits never touch the verified fields.

- [ ] **Step 1: Write the failing tests**

In `src/platform/people.test.ts`, DELETE the existing test (lines 162-177, the one titled "persists spanishSpeaking and licensedRN and audits only the changed flag") and insert this block in its place:

```typescript
  it("#68: createPersonRecord persists spanishSelfReported / spanishVerified / licensedRN and audits them", async () => {
    const created = await createPersonRecord(ACTOR, {
      name: "Sam Onboard",
      spanishSelfReported: true,
      spanishVerified: false,
      licensedRN: true,
    });

    expect(created.spanishSelfReported).toBe(true);
    expect(created.spanishVerified).toBe(false);
    expect(created.licensedRN).toBe(true);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "person.create", entityId: created.id },
    });
    const after = audit.after as Record<string, unknown>;
    expect(after.spanishSelfReported).toBe(true);
    expect(after.spanishVerified).toBe(false);
    expect(after.licensedRN).toBe(true);
  });

  it("createPersonRecord stamps verifier+timestamp when spanishVerified is true on create", async () => {
    const created = await createPersonRecord(ACTOR, { name: "Vee Verified", spanishVerified: true });
    expect(created.spanishVerified).toBe(true);
    expect(created.spanishVerifiedById).toBe(ACTOR);
    expect(created.spanishVerifiedAt).not.toBeNull();
  });

  it("updatePersonFields stamps verifier+timestamp when spanishVerified goes false->true", async () => {
    const p = await createPersonRecord(ACTOR, { name: "Up" });
    expect(p.spanishVerifiedAt).toBeNull();

    const u = await updatePersonFields(ACTOR, p.id, { spanishVerified: true });
    expect(u.spanishVerified).toBe(true);
    expect(u.spanishVerifiedById).toBe(ACTOR);
    expect(u.spanishVerifiedAt).not.toBeNull();
  });

  it("updatePersonFields clears verifier+timestamp when spanishVerified goes true->false", async () => {
    const p = await createPersonRecord(ACTOR, { name: "Down", spanishVerified: true });
    expect(p.spanishVerifiedAt).not.toBeNull();

    const u = await updatePersonFields(ACTOR, p.id, { spanishVerified: false });
    expect(u.spanishVerified).toBe(false);
    expect(u.spanishVerifiedAt).toBeNull();
    expect(u.spanishVerifiedById).toBeNull();
  });

  it("updatePersonFields editing only spanishSelfReported leaves the verified fields untouched", async () => {
    const p = await createPersonRecord(ACTOR, { name: "Stable", spanishVerified: true });
    const verifiedAt = p.spanishVerifiedAt;

    const u = await updatePersonFields(ACTOR, p.id, { spanishSelfReported: true });
    expect(u.spanishSelfReported).toBe(true);
    expect(u.spanishVerified).toBe(true);
    expect(u.spanishVerifiedAt).toEqual(verifiedAt);
    expect(u.spanishVerifiedById).toBe(ACTOR);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/platform/people.test.ts`
Expected: the five new tests FAIL (createPersonRecord does not yet write/stamp the new fields; the values come back `false`/`null`).

- [ ] **Step 3: Extend `PersonInput`**

In `src/platform/people.ts`, replace the `PersonInput` type (lines 63-73):

```typescript
export type PersonInput = {
  name: string;
  netId?: string | null;
  contactEmail?: string | null;
  phone?: string | null;
  epicId?: string | null;
  yaleAffiliation?: string | null;
  gradYear?: string | null;
  spanishSpeaking?: boolean;
  licensedRN?: boolean;
};
```

with:

```typescript
export type PersonInput = {
  name: string;
  netId?: string | null;
  contactEmail?: string | null;
  phone?: string | null;
  epicId?: string | null;
  yaleAffiliation?: string | null;
  gradYear?: string | null;
  spanishSpeaking?: boolean; // legacy; removed in the contract step (Task 8)
  spanishSelfReported?: boolean;
  spanishVerified?: boolean;
  licensedRN?: boolean;
};
```

- [ ] **Step 4: Write the new fields (and stamp) in `createPersonRecord`**

In `createPersonRecord`, replace the `tx.person.create` data block (lines 94-104):

```typescript
      const created = await tx.person.create({
        data: {
          name: data.name,
          netId: data.netId ?? null,
          contactEmail: data.contactEmail ?? null,
          phone: data.phone ?? null,
          epicId: data.epicId ?? null,
          yaleAffiliation: data.yaleAffiliation ?? null,
          gradYear: data.gradYear ?? null,
        },
      });
```

with:

```typescript
      const created = await tx.person.create({
        data: {
          name: data.name,
          netId: data.netId ?? null,
          contactEmail: data.contactEmail ?? null,
          phone: data.phone ?? null,
          epicId: data.epicId ?? null,
          yaleAffiliation: data.yaleAffiliation ?? null,
          gradYear: data.gradYear ?? null,
          spanishSelfReported: data.spanishSelfReported ?? false,
          spanishVerified: data.spanishVerified ?? false,
          licensedRN: data.licensedRN ?? false,
          // An admin setting "verified" on create is itself a verification event.
          ...(data.spanishVerified
            ? { spanishVerifiedAt: new Date(), spanishVerifiedById: actorPersonId }
            : {}),
        },
      });
```

- [ ] **Step 5: Add the new fields to the create audit `after`**

In `createPersonRecord`, replace the audit `after` object (lines 123-131):

```typescript
      after: {
        name: person.name,
        netId: person.netId,
        contactEmail: person.contactEmail,
        phone: person.phone,
        epicId: person.epicId,
        yaleAffiliation: person.yaleAffiliation,
        gradYear: person.gradYear,
      },
```

with:

```typescript
      after: {
        name: person.name,
        netId: person.netId,
        contactEmail: person.contactEmail,
        phone: person.phone,
        epicId: person.epicId,
        yaleAffiliation: person.yaleAffiliation,
        gradYear: person.gradYear,
        spanishSelfReported: person.spanishSelfReported,
        spanishVerified: person.spanishVerified,
        licensedRN: person.licensedRN,
      },
```

- [ ] **Step 6: Add the new fields to the update diff and the verification stamping**

In `updatePersonFields`, replace the `fields` array (lines 156-166):

```typescript
  const fields: Array<keyof PersonInput> = [
    "name",
    "netId",
    "contactEmail",
    "phone",
    "epicId",
    "yaleAffiliation",
    "gradYear",
    "spanishSpeaking",
    "licensedRN",
  ];
```

with:

```typescript
  const fields: Array<keyof PersonInput> = [
    "name",
    "netId",
    "contactEmail",
    "phone",
    "epicId",
    "yaleAffiliation",
    "gradYear",
    "spanishSpeaking",
    "spanishSelfReported",
    "spanishVerified",
    "licensedRN",
  ];
```

Then, inside the transaction, replace the `updateData` construction (lines 193-196):

```typescript
      const updateData: Record<string, unknown> = {};
      for (const key of changedKeys) {
        updateData[key] = data[key] ?? null;
      }
```

with:

```typescript
      const updateData: Record<string, unknown> = {};
      for (const key of changedKeys) {
        updateData[key] = data[key] ?? null;
      }
      // Verification stamping: setting verified true records who/when; clearing
      // it returns the person to the interpreting-department review queue.
      if (changedKeys.includes("spanishVerified")) {
        if (data.spanishVerified) {
          updateData.spanishVerifiedAt = new Date();
          updateData.spanishVerifiedById = actorPersonId;
        } else {
          updateData.spanishVerifiedAt = null;
          updateData.spanishVerifiedById = null;
        }
      }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/platform/people.test.ts`
Expected: all tests in the file PASS (the five new ones plus the unchanged existing ones).

- [ ] **Step 8: Commit**

```bash
git add src/platform/people.ts src/platform/people.test.ts
git commit -m "feat(people): write+stamp spanishSelfReported/spanishVerified on create+update (#68)"
```

---

## Task 3: INTP-review-queue predicate helper

**Files:**
- Create: `src/platform/spanish-review.ts`
- Test: `src/platform/spanish-review.test.ts`

**Interfaces:**
- Produces:
  - `needsSpanishReview(p: { spanishSelfReported: boolean; spanishVerified: boolean; spanishVerifiedAt: Date | null }): boolean` — pure predicate.
  - `spanishReviewWhere(): Prisma.PersonWhereInput` — `{ spanishVerifiedAt: null, OR: [{ spanishSelfReported: true }, { spanishVerified: true }] }`. Phase 2 consumes this to render the queue.

- [ ] **Step 1: Write the failing test**

Create `src/platform/spanish-review.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { needsSpanishReview, spanishReviewWhere } from "./spanish-review";

describe("needsSpanishReview (pure predicate)", () => {
  it("not Spanish -> not in queue", () => {
    expect(needsSpanishReview({ spanishSelfReported: false, spanishVerified: false, spanishVerifiedAt: null })).toBe(false);
  });

  it("self-reported, never assessed -> in queue", () => {
    expect(needsSpanishReview({ spanishSelfReported: true, spanishVerified: false, spanishVerifiedAt: null })).toBe(true);
  });

  it("assessed yes -> not in queue", () => {
    expect(needsSpanishReview({ spanishSelfReported: true, spanishVerified: true, spanishVerifiedAt: new Date() })).toBe(false);
  });

  it("assessed no -> not in queue", () => {
    expect(needsSpanishReview({ spanishSelfReported: true, spanishVerified: false, spanishVerifiedAt: new Date() })).toBe(false);
  });

  it("verified but unstamped (defensive) -> in queue", () => {
    expect(needsSpanishReview({ spanishSelfReported: false, spanishVerified: true, spanishVerifiedAt: null })).toBe(true);
  });
});

describe("spanishReviewWhere (Prisma query)", () => {
  beforeEach(resetDb);

  it("returns exactly the people awaiting assessment", async () => {
    const notSpanish = await prisma.person.create({ data: { name: "None" } });
    const awaiting = await prisma.person.create({
      data: { name: "Awaiting", spanishSelfReported: true },
    });
    const assessedYes = await prisma.person.create({
      data: { name: "Yes", spanishSelfReported: true, spanishVerified: true, spanishVerifiedAt: new Date() },
    });
    const assessedNo = await prisma.person.create({
      data: { name: "No", spanishSelfReported: true, spanishVerifiedAt: new Date() },
    });

    const rows = await prisma.person.findMany({ where: spanishReviewWhere(), select: { id: true } });
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(awaiting.id);
    expect(ids).not.toContain(notSpanish.id);
    expect(ids).not.toContain(assessedYes.id);
    expect(ids).not.toContain(assessedNo.id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/platform/spanish-review.test.ts`
Expected: FAIL with "Cannot find module './spanish-review'" (or "needsSpanishReview is not a function").

- [ ] **Step 3: Implement the helper**

Create `src/platform/spanish-review.ts`:

```typescript
/**
 * Interpreting-department Spanish review queue.
 *
 * A person needs interpreting-department review when they have never been
 * through a human assessment (spanishVerifiedAt is null) but carry a Spanish
 * signal (self-reported, or a provisional verified flag). `spanishVerifiedAt`
 * is the single source of truth for "assessed by a human": once it is set
 * (yes OR no), the person leaves the queue.
 *
 * Phase 1 ships this predicate so Phase 2 (the interpreting-department surface)
 * only has to add UI on top of it.
 */
import type { Prisma } from "@prisma/client";

export function needsSpanishReview(p: {
  spanishSelfReported: boolean;
  spanishVerified: boolean;
  spanishVerifiedAt: Date | null;
}): boolean {
  return p.spanishVerifiedAt === null && (p.spanishSelfReported || p.spanishVerified);
}

export function spanishReviewWhere(): Prisma.PersonWhereInput {
  return {
    spanishVerifiedAt: null,
    OR: [{ spanishSelfReported: true }, { spanishVerified: true }],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/platform/spanish-review.test.ts`
Expected: PASS (all predicate cases and the query case).

- [ ] **Step 5: Commit**

```bash
git add src/platform/spanish-review.ts src/platform/spanish-review.test.ts
git commit -m "feat(people): tested INTP Spanish-review queue predicate"
```

---

## Task 4: Admin surface — form, create page, edit page, people table

**Files:**
- Modify: `src/modules/admin/components/person-form.tsx` (prop type 20-31; checkbox block 107-122)
- Modify: `src/app/(app)/admin/people/new/page.tsx` (createAction 22-30)
- Modify: `src/app/(app)/admin/people/[id]/page.tsx` (updateAction 43-44)
- Modify: `src/modules/admin/components/people-table.tsx` (badge 60)

**Interfaces:**
- Consumes: `PersonInput.spanishSelfReported` / `spanishVerified` / `licensedRN` (Task 2); `Person.spanishVerifiedAt` (Task 1).
- Produces: the create and edit forms post `spanishSelfReported`, `spanishVerified`, `licensedRN`; the people table "ES" badge reflects `spanishVerified`. There is no automated test harness for these server components; verification is `npm run typecheck` plus the manual checklist in Step 6.

- [ ] **Step 1: Update the form prop type**

In `src/modules/admin/components/person-form.tsx`, replace the `person?: Pick<...>` block (lines 20-31):

```typescript
  person?: Pick<
    Person,
    | "name"
    | "netId"
    | "contactEmail"
    | "phone"
    | "epicId"
    | "yaleAffiliation"
    | "gradYear"
    | "spanishSpeaking"
    | "licensedRN"
  >;
```

with:

```typescript
  person?: Pick<
    Person,
    | "name"
    | "netId"
    | "contactEmail"
    | "phone"
    | "epicId"
    | "yaleAffiliation"
    | "gradYear"
    | "spanishSelfReported"
    | "spanishVerified"
    | "spanishVerifiedAt"
    | "licensedRN"
  >;
```

- [ ] **Step 2: Replace the checkbox block with three checkboxes plus a verified caption**

In the same file, replace the flags block (lines 107-122):

```tsx
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm text-foreground-soft">
          <Checkbox
            name="spanishSpeaking"
            defaultChecked={person?.spanishSpeaking ?? false}
          />
          Spanish-speaking
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground-soft">
          <Checkbox
            name="licensedRN"
            defaultChecked={person?.licensedRN ?? false}
          />
          Licensed RN
        </label>
      </div>
```

with:

```tsx
      <div className="space-y-4">
        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2 text-sm text-foreground-soft">
            <Checkbox
              name="spanishSelfReported"
              defaultChecked={person?.spanishSelfReported ?? false}
            />
            Spanish-speaking (self-reported)
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground-soft">
            <Checkbox
              name="licensedRN"
              defaultChecked={person?.licensedRN ?? false}
            />
            Licensed RN
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm text-foreground-soft">
            <Checkbox
              name="spanishVerified"
              defaultChecked={person?.spanishVerified ?? false}
            />
            Spanish verified (interpreting dept)
          </label>
          {person?.spanishVerifiedAt && (
            <p className="text-xs text-subtle-foreground">
              Verified on {new Date(person.spanishVerifiedAt).toLocaleDateString()}
            </p>
          )}
        </div>
      </div>
```

- [ ] **Step 3: Read the three checkboxes in the create action**

In `src/app/(app)/admin/people/new/page.tsx`, replace the `createPerson` call args (lines 22-30):

```typescript
      person = await createPerson(actorSession.personId, {
        name: (formData.get("name") as string) ?? "",
        netId: (formData.get("netId") as string) || null,
        contactEmail: (formData.get("contactEmail") as string) || null,
        phone: (formData.get("phone") as string) || null,
        epicId: (formData.get("epicId") as string) || null,
        yaleAffiliation: (formData.get("yaleAffiliation") as string) || null,
        gradYear: (formData.get("gradYear") as string) || null,
      });
```

with:

```typescript
      person = await createPerson(actorSession.personId, {
        name: (formData.get("name") as string) ?? "",
        netId: (formData.get("netId") as string) || null,
        contactEmail: (formData.get("contactEmail") as string) || null,
        phone: (formData.get("phone") as string) || null,
        epicId: (formData.get("epicId") as string) || null,
        yaleAffiliation: (formData.get("yaleAffiliation") as string) || null,
        gradYear: (formData.get("gradYear") as string) || null,
        spanishSelfReported: formData.get("spanishSelfReported") === "on",
        spanishVerified: formData.get("spanishVerified") === "on",
        licensedRN: formData.get("licensedRN") === "on",
      });
```

- [ ] **Step 4: Repoint the edit action**

In `src/app/(app)/admin/people/[id]/page.tsx`, replace these two lines (43-44):

```typescript
        spanishSpeaking: formData.get("spanishSpeaking") === "on",
        licensedRN: formData.get("licensedRN") === "on",
```

with:

```typescript
        spanishSelfReported: formData.get("spanishSelfReported") === "on",
        spanishVerified: formData.get("spanishVerified") === "on",
        licensedRN: formData.get("licensedRN") === "on",
```

- [ ] **Step 5: Repoint the people-table badge**

In `src/modules/admin/components/people-table.tsx`, replace line 60:

```tsx
                {person.spanishSpeaking && <Badge tone="default">ES</Badge>}
```

with:

```tsx
                {person.spanishVerified && <Badge tone="default">ES</Badge>}
```

- [ ] **Step 6: Verify typecheck and do a manual smoke check**

Run: `npm run typecheck`
Expected: no errors.

Manual checklist (dev server `npm run dev`, signed in as an admin):
- `/admin/people/new`: check "Spanish-speaking (self-reported)", "Spanish verified (interpreting dept)", and "Licensed RN"; Save. The new person's detail page shows all three checked, and the "ES" badge appears in the people table only because verified is set.
- Edit an existing person: toggling "Spanish verified" on shows the "Verified on <date>" caption after save; toggling it off removes the caption.

- [ ] **Step 7: Commit**

```bash
git add src/modules/admin/components/person-form.tsx src/app/\(app\)/admin/people/new/page.tsx src/app/\(app\)/admin/people/\[id\]/page.tsx src/modules/admin/components/people-table.tsx
git commit -m "feat(admin): person form reads self-reported + verified Spanish; ES badge = verified (#68)"
```

---

## Task 5: Scheduling reads the verified signal

**Files:**
- Modify: `src/modules/schedule/engine/rhd.ts` (RhdPersonLite 38-44; coverage count 104)
- Test: `src/modules/schedule/engine/rhd.test.ts` (helper 22-23; fixture 85)
- Modify: `src/modules/schedule/services/builder.ts` (BuilderMember 530; selects 680, 954; mapping 728; count 749; toRhdPerson 965)
- Test: `src/modules/schedule/services/builder.test.ts` (createPerson helper 58-65; capacity test 991; add one new test)
- Modify: `src/app/(app)/schedule/builder/page.tsx` (flagBadges 424-426)

**Interfaces:**
- Consumes: `Person.spanishVerified` (Task 1).
- Produces: `RhdPersonLite.spanishVerified`; `BuilderMember.person.spanishVerified`; RHD coverage and builder capacity count `spanishVerified`; the schedule-builder "ES" badge reflects `spanishVerified`.

- [ ] **Step 1: Update the RHD test helper and fixture (RED)**

In `src/modules/schedule/engine/rhd.test.ts`, replace line 23:

```typescript
  return { id, email: `${id}@yale.edu`, licensedRN: !!opts.rn, spanishSpeaking: !!opts.es };
```

with:

```typescript
  return { id, email: `${id}@yale.edu`, licensedRN: !!opts.rn, spanishVerified: !!opts.es };
```

And replace line 85:

```typescript
      jctsOnShift: [{ id: "a", email: "a@yale.edu", licensedRN: false, spanishSpeaking: false }],
```

with:

```typescript
      jctsOnShift: [{ id: "a", email: "a@yale.edu", licensedRN: false, spanishVerified: false }],
```

- [ ] **Step 2: Run the RHD test to verify it fails**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/modules/schedule/engine/rhd.test.ts`
Expected: FAIL to typecheck/run (object literals reference `spanishVerified`, which `RhdPersonLite` does not have yet).

- [ ] **Step 3: Repoint the RHD engine**

In `src/modules/schedule/engine/rhd.ts`, replace line 43:

```typescript
  spanishSpeaking: boolean;
```

with:

```typescript
  spanishVerified: boolean;
```

And replace line 104:

```typescript
      spanish: all.filter((p) => p.spanishSpeaking).length,
```

with:

```typescript
      spanish: all.filter((p) => p.spanishVerified).length,
```

- [ ] **Step 4: Run the RHD test to verify it passes**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/modules/schedule/engine/rhd.test.ts`
Expected: PASS (coverage.spanish still counts the one `es: true` person, now meaning verified).

- [ ] **Step 5: Update the builder test helper and capacity tests (RED)**

In `src/modules/schedule/services/builder.test.ts`, replace the `createPerson` helper (lines 58-65):

```typescript
async function createPerson(
  name: string,
  opts: { licensedRN?: boolean; spanishSpeaking?: boolean; contactEmail?: string } = {}
) {
  return prisma.person.create({
    data: { name, licensedRN: opts.licensedRN ?? false, spanishSpeaking: opts.spanishSpeaking ?? false, contactEmail: opts.contactEmail },
  });
}
```

with:

```typescript
async function createPerson(
  name: string,
  opts: { licensedRN?: boolean; spanishVerified?: boolean; spanishSelfReported?: boolean; contactEmail?: string } = {}
) {
  return prisma.person.create({
    data: {
      name,
      licensedRN: opts.licensedRN ?? false,
      spanishVerified: opts.spanishVerified ?? false,
      spanishSelfReported: opts.spanishSelfReported ?? false,
      contactEmail: opts.contactEmail,
    },
  });
}
```

Replace line 991:

```typescript
    const spanishVol = await createPerson("Bilingual", { spanishSpeaking: true });
```

with:

```typescript
    const spanishVol = await createPerson("Bilingual", { spanishVerified: true });
```

Then add this new test immediately after the existing capacity test (after line 1003, the closing `});` of "capacity math: counts spanish-speaking assignees correctly"):

```typescript
  it("capacity math: self-reported-only (unverified) Spanish does not count", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("PCAR", { idealHeadcount: 4 });
    const director = await createPerson("Director");
    const selfReportedVol = await createPerson("Pending", { spanishSelfReported: true });
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(selfReportedVol.id, term.id, dept.id, "VOLUNTEER");

    await createShift(term.id, dept.id, selfReportedVol.id, dates[0], "VOLUNTEER");

    const view = await builderView(director.id, { departmentId: dept.id, dateKey: isoDateKey(dates[0]) });
    expect(view.capacity.spanishCount).toBe(0);
  });
```

- [ ] **Step 6: Run the builder test to verify it fails**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/modules/schedule/services/builder.test.ts`
Expected: FAIL (builder.ts still selects/counts `spanishSpeaking`; the helper now writes `spanishVerified`, so the existing capacity test sees 0 and the new test cannot compile against the old `BuilderMember`).

- [ ] **Step 7: Repoint the builder service**

In `src/modules/schedule/services/builder.ts`, make these five replacements:

Line 530:
```typescript
  person: { id: string; name: string; spanishSpeaking: boolean; licensedRN: boolean };
```
to:
```typescript
  person: { id: string; name: string; spanishVerified: boolean; licensedRN: boolean };
```

Line 680:
```typescript
        person: { select: { id: true, name: true, spanishSpeaking: true, licensedRN: true } },
```
to:
```typescript
        person: { select: { id: true, name: true, spanishVerified: true, licensedRN: true } },
```

Line 728:
```typescript
        spanishSpeaking: m.person.spanishSpeaking,
```
to:
```typescript
        spanishVerified: m.person.spanishVerified,
```

Line 749:
```typescript
    return p.spanishSpeaking;
```
to:
```typescript
    return p.spanishVerified;
```

Line 954:
```typescript
        select: { id: true, contactEmail: true, licensedRN: true, spanishSpeaking: true },
```
to:
```typescript
        select: { id: true, contactEmail: true, licensedRN: true, spanishVerified: true },
```

Line 965:
```typescript
      spanishSpeaking: p?.spanishSpeaking ?? false,
```
to:
```typescript
      spanishVerified: p?.spanishVerified ?? false,
```

- [ ] **Step 8: Repoint the schedule-builder badge**

In `src/app/(app)/schedule/builder/page.tsx`, replace the `flagBadges` function (lines 424-426 plus the badge line):

```tsx
  function flagBadges(person: { spanishSpeaking: boolean; licensedRN: boolean }) {
    if (!person.spanishSpeaking && !person.licensedRN) return null;
    return (
      <>
        {person.spanishSpeaking && <Badge tone="default">ES</Badge>}
        {person.licensedRN && <Badge tone="default">RN</Badge>}
```

with:

```tsx
  function flagBadges(person: { spanishVerified: boolean; licensedRN: boolean }) {
    if (!person.spanishVerified && !person.licensedRN) return null;
    return (
      <>
        {person.spanishVerified && <Badge tone="default">ES</Badge>}
        {person.licensedRN && <Badge tone="default">RN</Badge>}
```

- [ ] **Step 9: Run the builder test and typecheck to verify green**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/modules/schedule/services/builder.test.ts`
Expected: PASS (existing capacity test = 1 for the verified person; new test = 0 for the self-reported-only person).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/modules/schedule src/app/\(app\)/schedule/builder/page.tsx
git commit -m "feat(schedule): RHD coverage + builder capacity key off verified Spanish"
```

---

## Task 6: Email audience repoint + add self-reported condition

**Files:**
- Modify: `src/platform/email/audience/person-fields.ts` (spanishSpeaking descriptor 162-168)
- Test: `src/platform/email/audience/person-fields.test.ts` (whitelist 9-13; boolean test 100-105)

**Interfaces:**
- Consumes: `Person.spanishVerified` / `spanishSelfReported` (Task 1).
- Produces: audience field `spanishVerified` (replaces `spanishSpeaking`) and a new `spanishSelfReported` field, both boolean with `isTrue`/`isFalse`.

- [ ] **Step 1: Update the whitelist and boolean tests (RED)**

In `src/platform/email/audience/person-fields.test.ts`, replace this line in the whitelist test (line 12):

```typescript
      "spanishSpeaking", "licensedRN", "hasOpenEpicRequest", "hasDisciplinaryAction",
```

with:

```typescript
      "spanishVerified", "spanishSelfReported", "licensedRN", "hasOpenEpicRequest", "hasDisciplinaryAction",
```

And replace the boolean test (lines 100-105):

```typescript
  it("spanishSpeaking / licensedRN -> direct boolean", () => {
    expect(personFieldWhere({ field: "spanishSpeaking", op: "isTrue" }, ctx)).toEqual({ spanishSpeaking: true });
    expect(personFieldWhere({ field: "spanishSpeaking", op: "isFalse" }, ctx)).toEqual({ spanishSpeaking: false });
    expect(personFieldWhere({ field: "licensedRN", op: "isTrue" }, ctx)).toEqual({ licensedRN: true });
    expect(personFieldWhere({ field: "licensedRN", op: "isFalse" }, ctx)).toEqual({ licensedRN: false });
  });
```

with:

```typescript
  it("spanishVerified / spanishSelfReported / licensedRN -> direct boolean", () => {
    expect(personFieldWhere({ field: "spanishVerified", op: "isTrue" }, ctx)).toEqual({ spanishVerified: true });
    expect(personFieldWhere({ field: "spanishVerified", op: "isFalse" }, ctx)).toEqual({ spanishVerified: false });
    expect(personFieldWhere({ field: "spanishSelfReported", op: "isTrue" }, ctx)).toEqual({ spanishSelfReported: true });
    expect(personFieldWhere({ field: "spanishSelfReported", op: "isFalse" }, ctx)).toEqual({ spanishSelfReported: false });
    expect(personFieldWhere({ field: "licensedRN", op: "isTrue" }, ctx)).toEqual({ licensedRN: true });
    expect(personFieldWhere({ field: "licensedRN", op: "isFalse" }, ctx)).toEqual({ licensedRN: false });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/platform/email/audience/person-fields.test.ts`
Expected: FAIL (the whitelist still lists `spanishSpeaking`; `spanishVerified`/`spanishSelfReported` are unknown fields).

- [ ] **Step 3: Repoint and add the descriptors**

In `src/platform/email/audience/person-fields.ts`, replace the `spanishSpeaking` descriptor (lines 162-168):

```typescript
  {
    key: "spanishSpeaking",
    label: "Spanish-speaking",
    group: "Attributes",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) => ({ spanishSpeaking: cond.op === "isTrue" }),
  },
```

with:

```typescript
  {
    key: "spanishVerified",
    label: "Spanish-speaking (verified)",
    group: "Attributes",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) => ({ spanishVerified: cond.op === "isTrue" }),
  },
  {
    key: "spanishSelfReported",
    label: "Spanish-speaking (self-reported)",
    group: "Attributes",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) => ({ spanishSelfReported: cond.op === "isTrue" }),
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/platform/email/audience/person-fields.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/email/audience/person-fields.ts src/platform/email/audience/person-fields.test.ts
git commit -m "feat(email): audience targets verified + self-reported Spanish"
```

---

## Task 7: Retire the Airtable people-flags import

`runScheduleConfigImport` has no production caller (only its own test invokes it). The People-flags phase writes the soon-to-be-removed `spanishSpeaking` column, so it must go; the Department-config phase is untouched.

**Files:**
- Modify: `src/platform/airtable/import/schedule-config.ts` (report type 38-48; PEOPLE_FIELD 54-57; checkboxValue 73-76; report init 100-108; people select 111-113; People phase 130-159)
- Test: `src/platform/airtable/import/schedule-config.test.ts` (remove people fixtures/helpers/tests; keep department tests)

**Interfaces:**
- Produces: `ScheduleConfigImportReport` loses `spanishChanged`, `rnChanged`, `peopleScanned`, `peopleUnresolved`; `ScheduleConfigImportOptions` loses `peopleTableId`. The function imports only department config.

- [ ] **Step 1: Trim the report type**

In `src/platform/airtable/import/schedule-config.ts`, replace the report type (lines 38-48):

```typescript
export type ScheduleConfigImportReport = {
  peopleScanned: number;
  /** Rows whose spanishSpeaking changed (either direction). */
  spanishChanged: number;
  rnChanged: number;
  /** Airtable rows with no matching Person.airtableRecordId. */
  peopleUnresolved: number;
  rosterRowsScanned: number;
  deptConfigChanged: number;
  unknownDepartments: string[];
};
```

with:

```typescript
export type ScheduleConfigImportReport = {
  rosterRowsScanned: number;
  deptConfigChanged: number;
  unknownDepartments: string[];
};
```

- [ ] **Step 2: Drop the people option and the People field IDs**

Replace the options type (lines 31-36):

```typescript
export type ScheduleConfigImportOptions = {
  baseId: string;
  peopleTableId: string;
  rosterTableId: string;
  dryRun: boolean;
};
```

with:

```typescript
export type ScheduleConfigImportOptions = {
  baseId: string;
  rosterTableId: string;
  dryRun: boolean;
};
```

Delete the `PEOPLE_FIELD` constant block (lines 54-57) and the `checkboxValue` helper (lines 73-76, the function and its doc comment).

- [ ] **Step 3: Remove the People phase from the function body**

Replace the report initializer (lines 100-108):

```typescript
  const report: ScheduleConfigImportReport = {
    peopleScanned: 0,
    spanishChanged: 0,
    rnChanged: 0,
    peopleUnresolved: 0,
    rosterRowsScanned: 0,
    deptConfigChanged: 0,
    unknownDepartments: [],
  };
```

with:

```typescript
  const report: ScheduleConfigImportReport = {
    rosterRowsScanned: 0,
    deptConfigChanged: 0,
    unknownDepartments: [],
  };
```

Delete the people preload block (lines 110-119, the `allPersonRows` findMany and the `personByRecordId` map). Then delete the entire "Phase 1: People flags" section (lines 130-159, from the `// ----- Phase 1 -----` banner through the closing brace of the `for (const record of peopleRecords)` loop). Renumber the remaining comment banner from "Phase 2: Department config" to "Department config".

- [ ] **Step 4: Update the import file header comment**

Replace the file header (lines 1-20) summary lines so they no longer mention person flags. Change line 2-6 to describe only department capacity config (idealHeadcount, patientCapacityPerProvider) from the SU 26 Roster table. Remove the "All People table" source bullet and the checkbox-semantics paragraph (lines 14-16).

- [ ] **Step 5: Rewrite the test file to cover only department config**

In `src/platform/airtable/import/schedule-config.test.ts`:
- Delete the people constants `REC_ALICE`, `REC_BOB`, `REC_GHOST`, `FLD_SPANISH`, `FLD_RN`, and `PEOPLE_TABLE_ID` (lines 22, 26-28, 31-32).
- Delete the `seedPerson` helper (lines 49-57).
- In `BASE_OPTS` (lines 39-43), remove the `peopleTableId` line.
- In `makeReader` (lines 67-77), drop the `peopleRows` parameter; return `rosterRows` for the roster table and `[]` otherwise:

```typescript
function makeReader(
  rosterRows: Array<{ id: string; fields: Record<string, unknown> }> = []
): AirtableReader {
  return {
    async listAll(_base: string, table: string) {
      if (table === ROSTER_TABLE_ID) return rosterRows;
      return [];
    },
  };
}
```

- Delete every people-phase test (the `describe` cases at lines 90-103, 105-118, 124-137, 139-151, 157-167, 173-181) and the idempotent/dry-run people seeding inside the remaining tests.
- Update the surviving department tests that called `makeReader([], [ ...roster ])` to call `makeReader([ ...roster ])` (single argument). For the idempotent test (266-283) and dry-run test (289-311), remove the `seedPerson(...)` lines and the `spanishChanged`/person assertions, keeping only the department assertions.
- Replace the report-shape test (lines 339-351) with:

```typescript
  it("report contains all expected keys", async () => {
    const reader = makeReader([]);
    const report = await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });
    expect(report).toMatchObject({
      rosterRowsScanned: expect.any(Number),
      deptConfigChanged: expect.any(Number),
      unknownDepartments: expect.any(Array),
    });
  });
```

- End state: the file's only surviving `it(...)` cases are the department/roster ones, i.e. "sets idealHeadcount and patientCapacityPerProvider from roster row", "sets config to null when roster numbers are absent", "adds unknown department code to unknownDepartments list (deduped)", "matches department code case-insensitively", "second run produces all-zero changes (idempotent)" (department-only), "dry run counts changes without writing to the database" (department-only), the audit test below, and the report-shape test below. No test references a person, `FLD_SPANISH`, `FLD_RN`, `seedPerson`, `spanishChanged`, `rnChanged`, `peopleScanned`, or `peopleUnresolved`.
- For the audit test (317-333), remove the `seedPerson` line and change the final assertion to check a department-config audit instead of `after.spanishChanged`:

```typescript
  it("apply mode writes exactly one schedule.config_import audit entry", async () => {
    const reader = makeReader([
      { id: "rowSurg", fields: { [FLD_DEPT_CODE]: "SURG", [FLD_IDEAL_HC]: 4, [FLD_PAT_CAP]: 10 } },
    ]);
    await seedDept("SURG", "Surgery");

    await runScheduleConfigImport(reader, { ...BASE_OPTS, dryRun: false });

    const audit = await prisma.auditLog.findFirst({ where: { action: "schedule.config_import" } });
    expect(audit).not.toBeNull();
    expect(audit!.actorPersonId).toBeNull();
    const after = audit!.after as Record<string, unknown>;
    expect(after.deptConfigChanged).toBe(1);
  });
```

- [ ] **Step 6: Run the schedule-config test and typecheck**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/platform/airtable/import/schedule-config.test.ts`
Expected: PASS (department-config tests only).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/platform/airtable/import/schedule-config.ts src/platform/airtable/import/schedule-config.test.ts
git commit -m "refactor(airtable): retire person Spanish/RN import (source is now the app)"
```

---

## Task 8: Contract — drop `spanishSpeaking`

**Files:**
- Modify: `prisma/schema.prisma` (remove the `spanishSpeaking` line added/kept in Task 1)
- Create: `prisma/migrations/<timestamp>_spanish_speaking_drop/migration.sql`
- Modify: `src/platform/people.ts` (remove `spanishSpeaking?` from PersonInput; remove `"spanishSpeaking"` from the `fields` array)
- Modify: `src/platform/airtable/mirror-map.test.ts` (remove `spanishSpeaking: false` from `nullPerson()`)

**Interfaces:**
- Produces: `spanishSpeaking` no longer exists on `Person`, `PersonInput`, or any consumer. Full suite green.

- [ ] **Step 1: Confirm no live references remain**

Run: `grep -rn "spanishSpeaking" src prisma | grep -v "/migrations/"`
Expected output (these are the only ones; all get removed in this task):
- `prisma/schema.prisma` (the column)
- `src/platform/people.ts` (PersonInput + fields array)
- `src/platform/airtable/mirror-map.test.ts` (nullPerson literal)

If any OTHER path appears, repoint it before continuing (a task was missed).

- [ ] **Step 2: Remove the column from the schema**

In `prisma/schema.prisma`, delete these two lines (the legacy column and its comment):

```prisma
  /// Legacy Airtable-sourced flag. Retained during the expand phase; dropped after consumers repoint.
  spanishSpeaking           Boolean              @default(false)
```

- [ ] **Step 3: Remove the last code references**

In `src/platform/people.ts`, delete the `spanishSpeaking?: boolean;` line from `PersonInput`, and delete the `"spanishSpeaking",` entry from the `fields` array in `updatePersonFields`.

In `src/platform/airtable/mirror-map.test.ts`, delete the `spanishSpeaking: false,` line from `nullPerson()` (leaving the four new fields and `licensedRN`).

- [ ] **Step 4: Generate the drop migration**

Run: `npx prisma migrate dev --create-only --name spanish_speaking_drop`
Expected: a new migration whose `migration.sql` is:

```sql
-- AlterTable
ALTER TABLE "Person" DROP COLUMN "spanishSpeaking";
```

- [ ] **Step 5: Apply to dev and test DBs**

Run: `npx prisma migrate dev`
Then: `npm run test:prepare`
Expected: both DBs drop the column; client regenerated.

- [ ] **Step 6: Full typecheck + whole-suite green**

Run: `npm run typecheck`
Expected: no errors.

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run`
Expected: the full suite passes. (Per the test-DB-isolation note, the four certificate `/tmp` ENOENT tests are pre-existing flakes unrelated to this change; everything else must be green.)

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/platform/people.ts src/platform/airtable/mirror-map.test.ts
git commit -m "feat(people): drop legacy spanishSpeaking column (contract)"
```

---

## Final verification (after all tasks)

- [ ] `grep -rn "spanishSpeaking" src` returns nothing.
- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` clean.
- [ ] `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run` green (except the known cert `/tmp` flakes).
- [ ] Manual: add a new person with each box checked (#68 closed); RHD readiness + schedule-builder "ES" reflect verified only; the Spanish-review queue predicate returns the migrated population.
