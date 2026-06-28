# Spanish verification Phases 2 + 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the interpreting-department Spanish review surface (Phase 2) and capture the Spanish/licensed-RN self-report on recruitment onboarding (Phase 3), feeding the review queue.

**Architecture:** Phase 2 adds a `recordSpanishAssessment` mutation + `listSpanishReviewQueue` query to the existing `src/platform/spanish-review.ts`, surfaced as a permission-gated Volunteers tab. Phase 3 adds two `OnboardingContract` columns captured on the token-gated onboarding form and mapped to the Person at promotion. Both build on Phase 1's data model and queue predicate; the two phases are independent.

**Tech Stack:** Next.js (App Router, server components + server actions), Prisma + PostgreSQL, Vitest, TypeScript.

## Global Constraints

- **No em-dashes** in any prose, comment, or copy (use commas, colons, parentheses, periods).
- **`spanishVerified` is the only scheduling-relevant signal.** `recordSpanishAssessment` ALWAYS stamps `spanishVerifiedAt` and `spanishVerifiedById` (for a yes OR a no), so an assessed person leaves the queue either way. This is deliberately different from Phase 1's admin-form override (where clearing verified returns to the queue).
- **Promotion never sets `spanishVerified`** (stays default false), so a recruited Spanish speaker enters the queue. The Person field is `spanishSelfReported` (the legacy `spanishSpeaking` was dropped in Phase 1).
- **Migration drift:** `prisma migrate dev` in this repo sweeps unrelated pre-existing drift (an `Application.subcommitteeRanking DROP DEFAULT` and five `Training VolunteerTraining_* -> Training_*` renames) into generated migrations. Generate with `--create-only` and strip the migration.sql to ONLY the intended statements.
- **Every task ends green:** the touched test(s) pass and `npm run typecheck` is clean before committing.

---

## Prerequisites (verify the isolated DB is up)

The Phase 1 work used a throwaway Postgres. Confirm it is still running; if not, recreate it.

- [ ] **P1: Confirm the isolated DB**

Run: `docker exec srn-pg pg_isready -U srn -d havenhub_spanishrn_dev`
Expected: "accepting connections". If the container is gone, recreate it:
```bash
docker run -d --name srn-pg -e POSTGRES_USER=srn -e POSTGRES_PASSWORD=srnpass -e POSTGRES_DB=havenhub_spanishrn_dev -p 5499:5432 postgres:16-alpine
# wait ~3s, then:
docker exec srn-pg psql -U srn -d postgres -c "CREATE DATABASE havenhub_spanishrn_test"
```
The worktree `.env` already points `DATABASE_URL`/`DATABASE_URL_UNPOOLED` at the dev DB.

- [ ] **P2: Sync both DBs to the current branch migrations**

```bash
npx prisma migrate deploy
DATABASE_URL="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" DATABASE_URL_UNPOOLED="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" npx prisma migrate deploy
npx prisma generate
```
Expected: "All migrations have been successfully applied" (or already in sync).

**Command reference (use these literal forms; do NOT run `npm run db:up`/`test:prepare`/`db:migrate`):**
- Test a file: `TEST_DATABASE_URL="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" npx vitest run <path>`
- Typecheck: `npm run typecheck`
- Apply a migration to the test DB: `DATABASE_URL="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" DATABASE_URL_UNPOOLED="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" npx prisma migrate deploy`

---

# Phase 2: interpreting-department Spanish review surface

## Task 1: `recordSpanishAssessment` + `listSpanishReviewQueue`

**Files:**
- Modify: `src/platform/spanish-review.ts`
- Test: `src/platform/spanish-review.test.ts`

**Interfaces:**
- Consumes: `spanishReviewWhere()` (already in the file); `PersonNotFoundError` from `@/platform/people`; `recordAudit` from `@/platform/audit`.
- Produces:
  - `listSpanishReviewQueue(): Promise<Array<{ id: string; name: string; netId: string | null; contactEmail: string | null }>>`
  - `recordSpanishAssessment(actorPersonId: string, personId: string, verified: boolean): Promise<Person>` (always stamps `spanishVerifiedAt`/`spanishVerifiedById`, sets `spanishVerified`, audits `person.spanish_assess`, throws `PersonNotFoundError` if missing).

- [ ] **Step 1: Write the failing tests**

Append to `src/platform/spanish-review.test.ts`. First, ensure the import line includes the new symbols. The file currently imports from `./spanish-review` and `@/platform/test/db` and `@/platform/db`. Update the `./spanish-review` import and add the `PersonNotFoundError` import:

```typescript
import { needsSpanishReview, spanishReviewWhere, recordSpanishAssessment, listSpanishReviewQueue } from "./spanish-review";
import { PersonNotFoundError } from "@/platform/people";
```

Then append these describe blocks at the end of the file:

```typescript
describe("recordSpanishAssessment", () => {
  beforeEach(resetDb);
  const ACTOR = "actor-1";

  it("verify=true sets verified, stamps verifier+timestamp, audits, and leaves the queue", async () => {
    const p = await prisma.person.create({ data: { name: "Self", spanishSelfReported: true } });
    const updated = await recordSpanishAssessment(ACTOR, p.id, true);
    expect(updated.spanishVerified).toBe(true);
    expect(updated.spanishVerifiedById).toBe(ACTOR);
    expect(updated.spanishVerifiedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "person.spanish_assess", entityId: p.id } })).toBe(1);
    const queue = await prisma.person.findMany({ where: spanishReviewWhere(), select: { id: true } });
    expect(queue.map((r) => r.id)).not.toContain(p.id);
  });

  it("verify=false still stamps verifiedAt (assessed-no) and leaves the queue", async () => {
    const p = await prisma.person.create({ data: { name: "Self", spanishSelfReported: true } });
    const updated = await recordSpanishAssessment(ACTOR, p.id, false);
    expect(updated.spanishVerified).toBe(false);
    expect(updated.spanishVerifiedAt).not.toBeNull();
    expect(updated.spanishVerifiedById).toBe(ACTOR);
    const queue = await prisma.person.findMany({ where: spanishReviewWhere(), select: { id: true } });
    expect(queue.map((r) => r.id)).not.toContain(p.id);
  });

  it("throws PersonNotFoundError for a missing id", async () => {
    await expect(recordSpanishAssessment(ACTOR, "nope", true)).rejects.toBeInstanceOf(PersonNotFoundError);
  });
});

describe("listSpanishReviewQueue", () => {
  beforeEach(resetDb);

  it("returns self-reported-unverified people ordered by name, excluding not-Spanish and assessed", async () => {
    await prisma.person.create({ data: { name: "Zed", spanishSelfReported: true } });
    await prisma.person.create({ data: { name: "Amy", spanishSelfReported: true } });
    await prisma.person.create({ data: { name: "NotSpanish" } });
    await prisma.person.create({ data: { name: "AssessedYes", spanishSelfReported: true, spanishVerified: true, spanishVerifiedAt: new Date() } });
    const rows = await listSpanishReviewQueue();
    expect(rows.map((r) => r.name)).toEqual(["Amy", "Zed"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TEST_DATABASE_URL="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" npx vitest run src/platform/spanish-review.test.ts`
Expected: FAIL (the new functions are not exported yet; compile/runtime error).

- [ ] **Step 3: Implement the two functions**

In `src/platform/spanish-review.ts`, replace the import line:

```typescript
import type { Prisma } from "@prisma/client";
```

with:

```typescript
import type { Person, Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { PersonNotFoundError } from "@/platform/people";
```

Then append at the end of the file:

```typescript
/** The clinic-wide review queue rows, name-ordered, for the Phase 2 surface. */
export async function listSpanishReviewQueue(): Promise<
  Array<{ id: string; name: string; netId: string | null; contactEmail: string | null }>
> {
  return prisma.person.findMany({
    where: spanishReviewWhere(),
    orderBy: { name: "asc" },
    select: { id: true, name: true, netId: true, contactEmail: true },
  });
}

/**
 * Record an interpreting-department Spanish assessment. Always stamps the
 * verifier + timestamp (a "no" is still an assessment), so the person leaves
 * the queue either way. Distinct from updatePersonFields' admin override.
 */
export async function recordSpanishAssessment(
  actorPersonId: string,
  personId: string,
  verified: boolean,
): Promise<Person> {
  const existing = await prisma.person.findUnique({ where: { id: personId } });
  if (!existing) throw new PersonNotFoundError(personId);

  const updated = await prisma.person.update({
    where: { id: personId },
    data: {
      spanishVerified: verified,
      spanishVerifiedAt: new Date(),
      spanishVerifiedById: actorPersonId,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "person.spanish_assess",
    entityType: "Person",
    entityId: personId,
    before: {
      spanishVerified: existing.spanishVerified,
      spanishVerifiedAt: existing.spanishVerifiedAt?.toISOString() ?? null,
    },
    after: {
      spanishVerified: updated.spanishVerified,
      spanishVerifiedAt: updated.spanishVerifiedAt?.toISOString() ?? null,
    },
  });

  return updated;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `TEST_DATABASE_URL="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" npx vitest run src/platform/spanish-review.test.ts`
Expected: PASS (all predicate, queue, and assessment tests).

Run: `npm run typecheck`
Expected: no errors. (If a circular-import error appears from importing `@/platform/people`, note it and report; `people.ts` does not import `spanish-review.ts`, so this should be clean.)

- [ ] **Step 5: Commit**

```bash
git add src/platform/spanish-review.ts src/platform/spanish-review.test.ts
git commit -m "feat(people): recordSpanishAssessment + listSpanishReviewQueue for INTP review"
```

---

## Task 2: Volunteers "Spanish review" surface (page + permission + nav)

**Files:**
- Modify: `src/platform/modules/registry.ts` (Volunteers manifest, lines 49-71)
- Create: `src/app/(app)/volunteers/spanish-review/page.tsx`

**Interfaces:**
- Consumes: `listSpanishReviewQueue`, `recordSpanishAssessment` (Task 1); `requirePermission` from `@/platform/auth/session`.
- Produces: a `/volunteers/spanish-review` page gated by `volunteers.verify_spanish`; the permission string + nav item registered on the Volunteers module.

- [ ] **Step 1: Add the permission and nav item to the Volunteers manifest**

In `src/platform/modules/registry.ts`, replace the Volunteers `permissions` array (lines 55-61):

```typescript
    permissions: [
      "volunteers.view",
      "volunteers.manage_compliance",
      "volunteers.manage_offboarding",
      "volunteers.manage_epic",
      "volunteers.issue_disciplinary",
    ],
```

with:

```typescript
    permissions: [
      "volunteers.view",
      "volunteers.manage_compliance",
      "volunteers.manage_offboarding",
      "volunteers.manage_epic",
      "volunteers.issue_disciplinary",
      "volunteers.verify_spanish",
    ],
```

And replace the Volunteers `nav` array (lines 63-70):

```typescript
    nav: [
      // Compliance / Offboarding / Disciplinary gate on volunteers.view (= module access).
      { label: "Compliance", href: "/volunteers" },
      { label: "Master view", href: "/volunteers/master", permission: "volunteers.manage_compliance" },
      { label: "Offboarding", href: "/volunteers/offboarding" },
      { label: "Epic requests", href: "/volunteers/epic", permission: "volunteers.manage_epic" },
      { label: "Disciplinary", href: "/volunteers/disciplinary" },
    ],
```

with:

```typescript
    nav: [
      // Compliance / Offboarding / Disciplinary gate on volunteers.view (= module access).
      { label: "Compliance", href: "/volunteers" },
      { label: "Master view", href: "/volunteers/master", permission: "volunteers.manage_compliance" },
      { label: "Spanish review", href: "/volunteers/spanish-review", permission: "volunteers.verify_spanish" },
      { label: "Offboarding", href: "/volunteers/offboarding" },
      { label: "Epic requests", href: "/volunteers/epic", permission: "volunteers.manage_epic" },
      { label: "Disciplinary", href: "/volunteers/disciplinary" },
    ],
```

- [ ] **Step 2: Create the page**

Create `src/app/(app)/volunteers/spanish-review/page.tsx`:

```tsx
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { listSpanishReviewQueue, recordSpanishAssessment } from "@/platform/spanish-review";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Button } from "@/platform/ui/button";

export default async function SpanishReviewPage() {
  await requirePermission("volunteers.verify_spanish");
  const rows = await listSpanishReviewQueue();

  async function assessAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.verify_spanish");
    const personId = formData.get("personId") as string;
    const verified = formData.get("verified") === "true";
    await recordSpanishAssessment(actor.personId, personId, verified);
    revalidatePath("/volunteers/spanish-review");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Spanish review"
        description="Volunteers who self-reported speaking Spanish and are awaiting an interpreting-department assessment. Verifying counts them as a Spanish provider for scheduling."
      />
      {rows.length === 0 ? (
        <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
          No one is awaiting Spanish review.
        </Card>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>NetID</TH>
              <TH>Email</TH>
              <TH>Assessment</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map((p) => (
              <TR key={p.id}>
                <TD className="font-medium">{p.name}</TD>
                <TD className="text-muted-foreground">
                  {p.netId ?? <span className="text-subtle-foreground">-</span>}
                </TD>
                <TD className="text-muted-foreground">
                  {p.contactEmail ?? <span className="text-subtle-foreground">-</span>}
                </TD>
                <TD>
                  <div className="flex gap-2">
                    <form action={assessAction}>
                      <input type="hidden" name="personId" value={p.id} />
                      <input type="hidden" name="verified" value="true" />
                      <Button type="submit" variant="primary" size="sm">Verify</Button>
                    </form>
                    <form action={assessAction}>
                      <input type="hidden" name="personId" value={p.id} />
                      <input type="hidden" name="verified" value="false" />
                      <Button type="submit" variant="outline" size="sm">Not verified</Button>
                    </form>
                  </div>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify typecheck (and any modules test)**

Run: `npm run typecheck`
Expected: no errors.

If a modules registry test exists, run it:
Run: `ls src/platform/modules/*.test.ts 2>/dev/null && TEST_DATABASE_URL="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" npx vitest run src/platform/modules 2>/dev/null || echo "no modules test"`
Expected: PASS or "no modules test".

Manual smoke (optional, controller will do it): as a user holding `volunteers.view` + `volunteers.verify_spanish`, the "Spanish review" tab appears and lists self-reported-unverified people; Verify/Not-verified remove the row.

- [ ] **Step 4: Commit**

```bash
git add src/platform/modules/registry.ts "src/app/(app)/volunteers/spanish-review/page.tsx"
git commit -m "feat(volunteers): Spanish review tab (queue + verify/not-verified actions)"
```

---

# Phase 3: recruitment onboarding capture

## Task 3: OnboardingContract self-report columns

**Files:**
- Modify: `prisma/schema.prisma` (OnboardingContract model, near the `worksWithYnhh` field)
- Create: `prisma/migrations/<timestamp>_onboarding_contract_self_report/migration.sql`

**Interfaces:**
- Produces: `OnboardingContract.spanishSelfReported: boolean` and `OnboardingContract.licensedRN: boolean` (default false).

- [ ] **Step 1: Add the columns to the schema**

In `prisma/schema.prisma`, find the `worksWithYnhh Boolean @default(false)` line in the `OnboardingContract` model and add two lines right after it:

```prisma
  worksWithYnhh            Boolean        @default(false)
  spanishSelfReported      Boolean        @default(false)
  licensedRN               Boolean        @default(false)
```

- [ ] **Step 2: Generate the migration without applying**

Run: `npx prisma migrate dev --create-only --name onboarding_contract_self_report`
Expected: a new `prisma/migrations/<timestamp>_onboarding_contract_self_report/migration.sql`.

- [ ] **Step 3: Strip the migration to only the OnboardingContract columns**

Open the generated migration.sql and replace its ENTIRE contents with exactly:

```sql
-- AlterTable
ALTER TABLE "OnboardingContract" ADD COLUMN     "spanishSelfReported" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "licensedRN" BOOLEAN NOT NULL DEFAULT false;
```

(Delete any `Application` ALTER or `Training` RENAME CONSTRAINT lines the generator added; they are unrelated pre-existing drift.)

- [ ] **Step 4: Apply to dev + test, regenerate client**

```bash
npx prisma migrate deploy
npx prisma generate
DATABASE_URL="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" DATABASE_URL_UNPOOLED="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" npx prisma migrate deploy
```
Expected: "All migrations have been successfully applied" on both.

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(recruitment): add spanishSelfReported/licensedRN to OnboardingContract"
```

---

## Task 4: Capture the self-report on the onboarding form

**Files:**
- Modify: `src/modules/recruitment/services/onboarding.ts` (ContractSubmission type 96-117; submitContract update data 180-206)
- Modify: `src/app/onboard/[token]/actions.ts` (ContractSubmission build)
- Modify: `src/app/onboard/[token]/onboard-form.tsx` (add a Background fieldset)
- Test: `src/modules/recruitment/services/onboarding.test.ts`

**Interfaces:**
- Consumes: `OnboardingContract.spanishSelfReported`/`licensedRN` (Task 3).
- Produces: `ContractSubmission` gains optional `spanishSelfReported?: boolean` and `licensedRN?: boolean`; `submitContract` persists them (defaulting to false).

- [ ] **Step 1: Write the failing test**

Append to `src/modules/recruitment/services/onboarding.test.ts`:

```typescript
it("submitContract stores spanishSelfReported and licensedRN", async () => {
  const { srr, acceptance } = await seed();
  const c = await createOrResendContract(acceptance.id, srr.id, "http://test");
  const ok = await submitContract(c.token, {
    firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu", netId: "al99", phone: "203",
    agreementSignature: "Ada", professionalismSignature: "Ada", trainingSignature: "Ada", initials: "AL",
    epicNeeded: false, hasEpic: false, worksWithYnhh: false,
    spanishSelfReported: true, licensedRN: true,
    hipaaCompletedAt: new Date("2026-01-01"), hipaaFile: { fileName: "c.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") },
  });
  expect(ok.spanishSelfReported).toBe(true);
  expect(ok.licensedRN).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" npx vitest run src/modules/recruitment/services/onboarding.test.ts`
Expected: FAIL (passing `spanishSelfReported`/`licensedRN` is an excess-property type error until the type is extended, or the values are not persisted).

- [ ] **Step 3: Extend the ContractSubmission type**

In `src/modules/recruitment/services/onboarding.ts`, add two optional fields to the `ContractSubmission` type, right after `worksWithYnhh: boolean;` (line 114):

```typescript
  worksWithYnhh: boolean;
  spanishSelfReported?: boolean;
  licensedRN?: boolean;
```

- [ ] **Step 4: Persist them in submitContract**

In the `prisma.onboardingContract.update` data block, add two lines right after `worksWithYnhh: input.worksWithYnhh,` (line 200):

```typescript
        worksWithYnhh: input.worksWithYnhh,
        spanishSelfReported: input.spanishSelfReported ?? false,
        licensedRN: input.licensedRN ?? false,
```

- [ ] **Step 5: Read them in the onboarding action**

In `src/app/onboard/[token]/actions.ts`, add two fields to the `input` object, right after `epicAccessType: ...` / `worksWithYnhh: bool("worksWithYnhh"),` (line 18):

```typescript
    epicAccessType: str("epicAccessType") || undefined, worksWithYnhh: bool("worksWithYnhh"),
    spanishSelfReported: bool("spanishSelfReported"), licensedRN: bool("licensedRN"),
```

- [ ] **Step 6: Add the Background fieldset to the form**

In `src/app/onboard/[token]/onboard-form.tsx`, insert a new fieldset between the EPIC fieldset (ends line 57) and the HIPAA fieldset (starts line 58):

```tsx
      <fieldset className="space-y-3 rounded-xl border border-border bg-surface p-4"><legend className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Background</legend>
        <label className="block text-sm"><input type="checkbox" name="spanishSelfReported" /> I can speak Spanish with patients</label>
        <label className="block text-sm"><input type="checkbox" name="licensedRN" /> I am a licensed RN</label>
      </fieldset>
```

- [ ] **Step 7: Run the test + typecheck**

Run: `TEST_DATABASE_URL="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" npx vitest run src/modules/recruitment/services/onboarding.test.ts`
Expected: PASS (the new test plus the existing ones).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/modules/recruitment/services/onboarding.ts src/modules/recruitment/services/onboarding.test.ts "src/app/onboard/[token]/actions.ts" "src/app/onboard/[token]/onboard-form.tsx"
git commit -m "feat(recruitment): capture Spanish/licensed-RN self-report on onboarding form"
```

---

## Task 5: Map the self-report onto the Person at promotion

**Files:**
- Modify: `src/modules/recruitment/services/promotion.ts` (update branch 31-40; create branch 42-50)
- Test: `src/modules/recruitment/services/promotion.test.ts`

**Interfaces:**
- Consumes: `OnboardingContract.spanishSelfReported`/`licensedRN` (Task 3); `spanishReviewWhere` from `@/platform/spanish-review`.
- Produces: a promoted Person gets `spanishSelfReported`/`licensedRN` from the contract, `spanishVerified` stays false, and the person enters the review queue.

- [ ] **Step 1: Write the failing test**

In `src/modules/recruitment/services/promotion.test.ts`, add the import for `spanishReviewWhere` (extend the existing import block):

```typescript
import { spanishReviewWhere } from "@/platform/spanish-review";
```

Then append this test:

```typescript
it("maps spanishSelfReported + licensedRN onto the Person, leaves verified false, and enters the queue", async () => {
  const { srr, contract } = await seedSubmitted({ netId: "rn1", email: "rn1@yale.edu" });
  await prisma.onboardingContract.update({
    where: { id: contract.id },
    data: { spanishSelfReported: true, licensedRN: true },
  });

  const res = await promoteContracts([contract.id], srr.id);
  expect(res.created).toBe(1);

  const person = await prisma.person.findFirstOrThrow({ where: { netId: "rn1" } });
  expect(person.spanishSelfReported).toBe(true);
  expect(person.licensedRN).toBe(true);
  expect(person.spanishVerified).toBe(false);

  const queue = await prisma.person.findMany({ where: spanishReviewWhere(), select: { id: true } });
  expect(queue.map((r) => r.id)).toContain(person.id);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" npx vitest run src/modules/recruitment/services/promotion.test.ts`
Expected: FAIL (`person.spanishSelfReported`/`licensedRN` come back false because promotion does not map them yet).

- [ ] **Step 3: Map in the create-new-person branch**

In `src/modules/recruitment/services/promotion.ts`, replace the create data block (lines 43-49):

```typescript
          person = await tx.person.create({
            data: {
              name: `${contract.firstName} ${contract.lastName}`.trim(),
              netId: contract.netId, contactEmail: contract.email, phone: contract.phone,
              yaleAffiliation: contract.yaleAffiliation, gradYear: contract.gradYear,
              epicId: contract.existingEpicId, status: "ACTIVE",
            },
          });
```

with:

```typescript
          person = await tx.person.create({
            data: {
              name: `${contract.firstName} ${contract.lastName}`.trim(),
              netId: contract.netId, contactEmail: contract.email, phone: contract.phone,
              yaleAffiliation: contract.yaleAffiliation, gradYear: contract.gradYear,
              epicId: contract.existingEpicId, status: "ACTIVE",
              spanishSelfReported: contract.spanishSelfReported,
              licensedRN: contract.licensedRN,
            },
          });
```

- [ ] **Step 4: Map in the update-existing-person branch**

Replace the update data block (lines 33-39):

```typescript
            data: {
              status: "ACTIVE",
              phone: person.phone ?? contract.phone,
              yaleAffiliation: person.yaleAffiliation ?? contract.yaleAffiliation,
              gradYear: person.gradYear ?? contract.gradYear,
              epicId: person.epicId ?? contract.existingEpicId,
            },
```

with:

```typescript
            data: {
              status: "ACTIVE",
              phone: person.phone ?? contract.phone,
              yaleAffiliation: person.yaleAffiliation ?? contract.yaleAffiliation,
              gradYear: person.gradYear ?? contract.gradYear,
              epicId: person.epicId ?? contract.existingEpicId,
              spanishSelfReported: person.spanishSelfReported || contract.spanishSelfReported,
              licensedRN: person.licensedRN || contract.licensedRN,
            },
```

- [ ] **Step 5: Run the test + typecheck**

Run: `TEST_DATABASE_URL="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" npx vitest run src/modules/recruitment/services/promotion.test.ts`
Expected: PASS (the new test plus the existing ones).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/recruitment/services/promotion.ts src/modules/recruitment/services/promotion.test.ts
git commit -m "feat(recruitment): promote Spanish/licensed-RN self-report onto the Person"
```

---

## Final verification (after all tasks)

- [ ] `npm run typecheck` clean.
- [ ] Full suite: `TEST_DATABASE_URL="postgresql://srn:srnpass@localhost:5499/havenhub_spanishrn_test" npx vitest run` green (the 4 cert `/tmp` ENOENT tests are known pre-existing flakes; everything else must pass).
- [ ] Manual: a `volunteers.verify_spanish` holder sees the Spanish review tab and can Verify / Not-verify; a submitted onboarding contract with the boxes checked promotes a Person who is self-reported, unverified, and in the queue.
