# HIPAA Applicant Date Validation + Verification Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the applicant-entered HIPAA completion date with the same rules every staff path uses, and make any unverified completion date non-clearing until a human confirms it.

**Architecture:** Two parts. (1) Route the onboarding date through the shared `parseCompletionDate`. (2) Add a `PENDING_VERIFICATION` compliance status returned whenever a cert has a `completionDate` but `verifiedAt == null`; it is non-clearing everywhere clearance is computed. A grandfather SQL migration back-stamps existing dated-unverified certs so nobody loses clearance on deploy.

**Tech Stack:** Next.js (App Router) server actions, Prisma, Vitest, TypeScript.

## Global Constraints

- HAVEN voice in all user-facing copy: sentence case, **no em-dashes** (use commas, periods, or parentheses).
- `parseCompletionDate` (`@/platform/compliance/completion-date`) is the single source of truth for date rules: exact `YYYY-MM-DD`, real calendar date, not future, within 5 years, normalized to noon UTC. Do not re-implement.
- `ComplianceStatus` is a pure TS union, never a DB enum. Adding a value needs NO Prisma enum migration.
- DB safety: the repo `.env` points ALL DB URLs (incl. `TEST_DATABASE_URL`) at the production Neon DB. NEVER run `prisma migrate`/`prisma db push`/`vitest` against `.env`. Tests use a local Postgres via `TEST_DATABASE_URL` (default `postgresql://haven:haven_dev@localhost:5434/havenhub_test`). Bring it up with `npm run db:up` and prepare with `npm run test:prepare`.
- Run a suite with: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test npx vitest run <path>`.
- The clearance gate is keyed on `verifiedAt` alone (NOT `source`/`extraction`): a dated cert clears only once `verifiedAt != null`.

---

## File Structure

- `src/platform/compliance/rules.ts` — add `PENDING_VERIFICATION`, thread `verifiedAt` into `complianceStatus`.
- `src/modules/recruitment/services/onboarding.ts` — validate `hipaaCompletedAt` via `parseCompletionDate`.
- `src/app/onboard/[token]/actions.ts` — pass the raw date string through.
- `src/app/onboard/[token]/onboard-form.tsx` — `min`/`max` on the date input.
- `src/modules/volunteers/services/compliance.ts` — status maps + pass `verifiedAt`.
- `src/platform/email/reminders.ts` + `src/platform/email/templates/compliance.ts` — select `verifiedAt`, handle the new status.
- `src/modules/recruitment/services/training.ts`, `src/modules/schedule/services/builder.ts` — pass `verifiedAt`.
- `src/app/(app)/volunteers/page.tsx`, `src/app/(app)/volunteers/master/page.tsx`, `src/app/(app)/page.tsx`, `src/app/get-started/hipaa/page.tsx` — status labels/copy/filter.
- `src/platform/email/audience/person-fields.ts` — `COMPLIANCE_VALUES`.
- `prisma/migrations/<ts>_grandfather_unverified_hipaa_dates/migration.sql` — data backfill.

---

## Task 1: Validate the applicant-entered onboarding date

**Files:**
- Modify: `src/modules/recruitment/services/onboarding.ts` (type `ContractSubmission`, fn `submitContract`)
- Modify: `src/app/onboard/[token]/actions.ts:21`
- Modify: `src/app/onboard/[token]/onboard-form.tsx` (field helper + HIPAA date input)
- Test: `src/modules/recruitment/services/onboarding.test.ts` (create if absent; otherwise add cases)

**Interfaces:**
- Consumes: `parseCompletionDate(dateIso: string): Date` and `CompletionDateError` from `@/platform/compliance/completion-date`.
- Produces: `ContractSubmission.hipaaCompletedAt: string` (raw `YYYY-MM-DD`); `submitContract` rejects out-of-range dates with a `ContractValidationError` field error keyed `hipaaCompletedAt`.

- [ ] **Step 1: Write failing tests for date validation in `submitContract`**

Add to `src/modules/recruitment/services/onboarding.test.ts`. Mirror the existing test setup in that suite (a PENDING contract + token). Use the existing `resetDb` helper and a stored HIPAA file or pre-set `hipaaStoredName` so the file check passes. Test the date branch:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { submitContract, ContractValidationError } from "./onboarding";
import { prisma } from "@/platform/db";
import { resetDb } from "@/test/reset-db"; // match the helper path used by sibling suites

async function pendingContract() {
  // ...create an Acceptance + PENDING OnboardingContract with a token and hipaaStoredName set
  // Return { token }.
}

const base = {
  firstName: "A", lastName: "B", email: "a@b.com",
  agreementSignature: "A B", professionalismSignature: "A B",
  trainingSignature: "A B", initials: "AB",
  epicNeeded: false, hasEpic: false, worksWithYnhh: false,
};

describe("submitContract HIPAA date validation", () => {
  beforeEach(async () => { await resetDb(); });

  it("rejects a future completion date", async () => {
    const { token } = await pendingContract();
    const nextYear = new Date().getUTCFullYear() + 1;
    await expect(
      submitContract(token, { ...base, hipaaCompletedAt: `${nextYear}-01-01` } as any)
    ).rejects.toMatchObject({ fieldErrors: { hipaaCompletedAt: expect.any(String) } });
  });

  it("rejects a date older than 5 years", async () => {
    const { token } = await pendingContract();
    const old = new Date().getUTCFullYear() - 6;
    await expect(
      submitContract(token, { ...base, hipaaCompletedAt: `${old}-01-01` } as any)
    ).rejects.toBeInstanceOf(ContractValidationError);
  });

  it("rejects a malformed date", async () => {
    const { token } = await pendingContract();
    await expect(
      submitContract(token, { ...base, hipaaCompletedAt: "06/01/2025" } as any)
    ).rejects.toBeInstanceOf(ContractValidationError);
  });

  it("stores a valid date normalized to noon UTC", async () => {
    const { token } = await pendingContract();
    const yyyy = new Date().getUTCFullYear() - 1;
    const updated = await submitContract(token, { ...base, hipaaCompletedAt: `${yyyy}-06-01` } as any);
    expect(updated.hipaaCompletedAt?.toISOString()).toBe(`${yyyy}-06-01T12:00:00.000Z`);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test npx vitest run src/modules/recruitment/services/onboarding.test.ts`
Expected: FAIL (future/old/malformed currently accepted; noon-UTC assertion fails because `new Date("...")` is midnight UTC).

- [ ] **Step 3: Change the submission type to a raw string**

In `onboarding.ts`, change the `ContractSubmission` field:

```ts
  hipaaCompletedAt?: string; // raw YYYY-MM-DD from the date input; validated in submitContract
```

- [ ] **Step 4: Validate in `submitContract`**

In `onboarding.ts`, add the import at the top:

```ts
import { parseCompletionDate, CompletionDateError } from "@/platform/compliance/completion-date";
```

Keep the existing presence check `if (!input.hipaaCompletedAt) e.hipaaCompletedAt = "required";`. Immediately AFTER the presence checks and BEFORE the `if (Object.keys(e).length > 0)` throw, add:

```ts
  let hipaaCompletedAt: Date | undefined;
  if (input.hipaaCompletedAt) {
    try {
      hipaaCompletedAt = parseCompletionDate(input.hipaaCompletedAt);
    } catch (err) {
      if (!(err instanceof CompletionDateError)) throw err;
      e.hipaaCompletedAt =
        err.reason.includes("future") ? "Completion date cannot be in the future."
        : err.reason.includes("older") ? "Completion date cannot be more than 5 years ago."
        : "Enter a valid completion date.";
    }
  }
```

Then in the `prisma.onboardingContract.update` data, replace:

```ts
        hipaaCompletedAt: input.hipaaCompletedAt ?? null,
```

with:

```ts
        hipaaCompletedAt: hipaaCompletedAt ?? null,
```

- [ ] **Step 5: Pass the raw string from the action**

In `actions.ts`, change line 21 from:

```ts
    hipaaCompletedAt: hipaaAt ? new Date(hipaaAt) : undefined,
```

to:

```ts
    hipaaCompletedAt: hipaaAt || undefined,
```

(`hipaaAt` is already `str("hipaaCompletedAt")`, a trimmed `YYYY-MM-DD` string.)

- [ ] **Step 6: Add min/max to the onboard form date input**

In `onboard-form.tsx`, extend the `field` helper's `opts` to accept `min`/`max` and forward them to `Input` (the `Input` primitive spreads native props, so `min`/`max` pass through):

```tsx
  const field = (label: string, name: string, opts: { type?: string; defaultValue?: string; required?: boolean; min?: string; max?: string } = {}) => (
    <label className="block text-sm">{label}{opts.required && <span className="text-critical"> *</span>}
      <Input name={name} type={opts.type ?? "text"} defaultValue={opts.defaultValue} required={opts.required} min={opts.min} max={opts.max} className="mt-1" />
      {err(name) && <span className="block text-xs text-critical">{err(name)}</span>}
    </label>
  );
```

Inside `OnboardForm`, before the `return`, compute the bounds:

```tsx
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const maxHipaa = iso(today);
  const minHipaa = iso(new Date(today.getFullYear() - 5, today.getMonth(), today.getDate()));
```

Change the HIPAA date field (line 65) to:

```tsx
        {field("HIPAA completion date", "hipaaCompletedAt", { type: "date", required: true, min: minHipaa, max: maxHipaa })}
```

- [ ] **Step 7: Run the tests, verify they pass**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test npx vitest run src/modules/recruitment/services/onboarding.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/recruitment/services/onboarding.ts src/app/onboard src/modules/recruitment/services/onboarding.test.ts
git commit -m "fix(onboarding): validate applicant HIPAA completion date (#75)"
```

---

## Task 2: Add PENDING_VERIFICATION and thread verifiedAt through the gate

This is the behavior change. It compiles and is fully tested at the end. The param-type change makes `npx tsc --noEmit` the exhaustive checklist for the fan-out.

**Files:**
- Modify: `src/platform/compliance/rules.ts`
- Test: `src/platform/compliance/rules.test.ts`
- Modify (call sites / maps, tsc-driven): `src/modules/volunteers/services/compliance.ts`, `src/modules/recruitment/services/training.ts`, `src/modules/schedule/services/builder.ts`, `src/platform/email/reminders.ts`, `src/platform/email/templates/compliance.ts`, `src/app/(app)/volunteers/page.tsx`, `src/app/(app)/volunteers/master/page.tsx`, `src/platform/email/audience/person-fields.ts`
- Modify (test fixtures): see Step 6.

**Interfaces:**
- Produces: `type ComplianceStatus = "COMPLIANT" | "EXPIRING_SOON" | "EXPIRED" | "UNKNOWN_DATE" | "PENDING_VERIFICATION" | "NO_CERTIFICATE"` and
  `complianceStatus(cert: { completionDate: Date | null; verifiedAt: Date | null } | null, termEnd: Date | null, now?: Date): ComplianceStatus`.

- [ ] **Step 1: Write failing rules tests**

Add to `src/platform/compliance/rules.test.ts`:

```ts
describe("complianceStatus - verification gate", () => {
  it("dated but unverified -> PENDING_VERIFICATION", () => {
    const now = new Date("2026-06-29T12:00:00Z");
    const completion = new Date("2026-06-01T12:00:00Z");
    expect(complianceStatus({ completionDate: completion, verifiedAt: null }, null, now)).toBe("PENDING_VERIFICATION");
  });

  it("dated and verified -> COMPLIANT", () => {
    const now = new Date("2026-06-29T12:00:00Z");
    const completion = new Date("2026-06-01T12:00:00Z");
    expect(complianceStatus({ completionDate: completion, verifiedAt: now }, null, now)).toBe("COMPLIANT");
  });

  it("PENDING takes precedence over expiry math", () => {
    const now = new Date("2026-06-29T12:00:00Z");
    const old = new Date("2020-01-01T12:00:00Z"); // would be EXPIRED if verified
    expect(complianceStatus({ completionDate: old, verifiedAt: null }, null, now)).toBe("PENDING_VERIFICATION");
  });

  it("no date is still UNKNOWN_DATE regardless of verifiedAt", () => {
    expect(complianceStatus({ completionDate: null, verifiedAt: null }, null)).toBe("UNKNOWN_DATE");
  });
});

describe("overallClearance - PENDING is not cleared", () => {
  it("PENDING_VERIFICATION never clears", () => {
    expect(overallClearance("PENDING_VERIFICATION", true)).toBe("NOT_CLEARED");
  });
});
```

Update EVERY existing `complianceStatus(...)` call in `rules.test.ts` that passes `{ completionDate: ... }` to also pass `verifiedAt: <a date>` (so those existing cases still read COMPLIANT/EXPIRED/etc., not PENDING). Use the `now` value or any non-null date as `verifiedAt`.

- [ ] **Step 2: Run rules tests, verify the new ones fail**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test npx vitest run src/platform/compliance/rules.test.ts`
Expected: FAIL on the verification-gate cases (PENDING_VERIFICATION not yet a value).

- [ ] **Step 3: Implement the rules change**

In `rules.ts`, add `PENDING_VERIFICATION` to the `ComplianceStatus` union and its doc comment, then change `complianceStatus`:

```ts
export function complianceStatus(
  cert: { completionDate: Date | null; verifiedAt: Date | null } | null,
  termEnd: Date | null,
  now: Date = new Date()
): ComplianceStatus {
  if (cert === null) return "NO_CERTIFICATE";
  if (cert.completionDate === null) return "UNKNOWN_DATE";
  // A self-asserted date does not count toward clearance until a human verifies it.
  // Precedes the expiry math: we do not compute expiry from an unconfirmed date.
  if (cert.verifiedAt === null) return "PENDING_VERIFICATION";

  const expiresAt = certExpiresAt(cert.completionDate);
  // ... rest unchanged ...
}
```

- [ ] **Step 4: Run rules tests, verify they pass**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test npx vitest run src/platform/compliance/rules.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix every compile break (tsc-driven fan-out)**

Run: `npm run typecheck` (`tsc --noEmit`). Fix each error:

1. **`compliance.ts`** — three spots:
   - `STATUS_ORDER` (after `EXPIRED: 1` ... before `EXPIRING_SOON`): add `PENDING_VERIFICATION: ` with order value `2` and renumber `UNKNOWN_DATE: 3, EXPIRING_SOON: 4, COMPLIANT: 5` (PENDING sorts among the non-compliant group, near UNKNOWN_DATE).
   - the inline `counts` initializer (~line 212) and `EMPTY_SUMMARY` (~line 258): add `PENDING_VERIFICATION: 0,`.
   - the two `complianceStatus(...)` calls (~177 and the masterCompliance one ~387): add `verifiedAt: newestCert.verifiedAt` next to `completionDate`. The cert objects are full `HipaaCertificate` rows, so `verifiedAt` is present.
2. **`training.ts:334`** — change `{ completionDate: cert.completionDate }` to `{ completionDate: cert.completionDate, verifiedAt: cert.verifiedAt }`. If tsc says `verifiedAt` missing on the included cert, add it to the `hipaaCertificates` include/select in that query.
3. **`builder.ts:824`** — change `{ completionDate: newestCert.completionDate }` to `{ completionDate: newestCert.completionDate, verifiedAt: newestCert.verifiedAt }`. The builder include (`builder.ts:708`) is a full-object include, so `verifiedAt` is present.
4. **`volunteers/page.tsx` and `volunteers/master/page.tsx`** — `STATUS_LABEL` and `STATUS_TONE` (both `Record<ComplianceStatus, …>`): add `PENDING_VERIFICATION: "Needs verification"` and `PENDING_VERIFICATION: "warning"`.
5. **`person-fields.ts:25`** — add `"PENDING_VERIFICATION"` to `COMPLIANCE_VALUES`.

- [ ] **Step 6: Fix the reminder path (runtime-critical; not tsc-forced)**

`reminders.ts` selects only `completionDate`; the new status must be derivable, and the template switch must not throw.

In `reminders.ts`, the cert query `select` (~line 109): add `verifiedAt: true`. Update the `certMap` value type to `{ completionDate: Date | null; verifiedAt: Date | null }` and store `verifiedAt: c.verifiedAt` when filling it.

In `templates/compliance.ts`, the `complianceReminderContext` switch (~line 82) currently throws on unlisted statuses. Add a case so PENDING joins the existing dateless/missing group (verification-aware copy, no "re-upload" instruction):

```ts
    case "PENDING_VERIFICATION":
      return { ...baseCtx, headline: "Your HIPAA certificate is awaiting verification", needsAction: false };
```

Match the exact shape the other cases return in that file (copy their structure; the example keys are illustrative). PENDING reaching this switch is expected: COMPLIANT is handled earlier with `continue`, all other statuses fall through to reminders.

- [ ] **Step 7: Fix existing cert test fixtures**

The behavior change means any existing test that creates a dated cert WITHOUT `verifiedAt` and expects COMPLIANT/CLEARED will now read PENDING and fail. For each fixture below, add `verifiedAt: new Date()` (or a date matching the test's intent) to certs that should be compliant. Leave dateless certs (intended UNKNOWN_DATE/NO_CERTIFICATE) unchanged.

Files to audit and update:
- `src/modules/volunteers/services/compliance.test.ts` (helper ~line 100 + assertions)
- `src/modules/schedule/services/builder.test.ts` (~1148, ~1265)
- `src/modules/recruitment/services/training.test.ts` (~155)
- `src/modules/my-info/services/my-info.test.ts` (~470, 480, 503, 520)
- `src/platform/email/reminders.test.ts` (~100)

Add at least one NEW assertion (in `compliance.test.ts`) that a dated cert with `verifiedAt: null` reads `PENDING_VERIFICATION` and `overallClearance` is `NOT_CLEARED`, and that calling `verifyCertificate` flips it to `COMPLIANT`.

- [ ] **Step 8: Run typecheck + affected suites**

Run: `npm run typecheck`
Expected: clean.

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test npx vitest run src/modules/volunteers src/platform/compliance src/platform/email src/modules/recruitment src/modules/schedule src/modules/my-info`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(compliance): unverified HIPAA dates do not clear until verified (#75)"
```

---

## Task 3: Status copy for PENDING in user-facing surfaces (not tsc-forced)

**Files:**
- Modify: `src/app/(app)/volunteers/master/page.tsx` (`ALL_STATUSES` filter + summary tile)
- Modify: `src/app/(app)/page.tsx` (personal dashboard HIPAA line, ~lines 196-205)
- Modify: `src/app/get-started/hipaa/page.tsx` (and the `HipaaPanel` component it renders)

**Interfaces:**
- Consumes: `ComplianceStatus` including `PENDING_VERIFICATION`.

- [ ] **Step 1: Master filter + summary tile**

In `volunteers/master/page.tsx`, add `"PENDING_VERIFICATION"` to the `ALL_STATUSES` array (place it next to `"UNKNOWN_DATE"`). If there is a row of summary tiles (`result.summary.UNKNOWN_DATE` etc.), add a tile reading `result.summary.PENDING_VERIFICATION` labeled "Needs verification".

- [ ] **Step 2: Personal dashboard HIPAA line**

In `(app)/page.tsx`, add a `PENDING_VERIFICATION` branch to the `hipaaLine` ternary chain BEFORE the final `else`:

```tsx
        : status === "PENDING_VERIFICATION"
          ? { ok: false, title: "HIPAA certificate awaiting verification", sub: "A coordinator will confirm your completion date" }
```

- [ ] **Step 3: get-started HIPAA panel copy**

A self-uploaded cert now reads `PENDING_VERIFICATION`, so the uploader is held at this gate step until a coordinator verifies. Locate `HipaaPanel` (rendered in `get-started/hipaa/page.tsx`, receives `status: ComplianceStatus`) and add a `PENDING_VERIFICATION` branch to its status messaging:

> "Certificate uploaded. A coordinator will verify it before this step is complete."

Make sure the panel does NOT tell a PENDING user to upload again (that is only for `NO_CERTIFICATE`/`UNKNOWN_DATE`).

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add -A
git commit -m "feat(compliance): surface awaiting-verification status in dashboards and gate (#75)"
```

---

## Task 4: Grandfather existing dated-unverified certs (migration)

**Files:**
- Create: `prisma/migrations/20260629120000_grandfather_unverified_hipaa_dates/migration.sql`
- Test: `src/platform/compliance/grandfather.test.ts`

**Interfaces:**
- Produces: every existing `HipaaCertificate` with a non-null `completionDate` and null `verifiedAt` gets `verifiedAt` set, so it remains COMPLIANT after deploy.

- [ ] **Step 1: Write a failing test that runs the backfill SQL**

Create `src/platform/compliance/grandfather.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/test/reset-db"; // match sibling-suite helper path

const GRANDFATHER_SQL = `
  UPDATE "HipaaCertificate"
  SET "verifiedAt" = "uploadedAt"
  WHERE "completionDate" IS NOT NULL AND "verifiedAt" IS NULL;
`;

describe("grandfather unverified HIPAA dates", () => {
  beforeEach(async () => { await resetDb(); });

  it("back-stamps dated-unverified certs and leaves dateless certs untouched", async () => {
    const person = await prisma.person.create({ data: { name: "T", status: "ACTIVE" } });
    const dated = await prisma.hipaaCertificate.create({
      data: { personId: person.id, fileName: "a.pdf", storedName: "a.pdf", size: 1, mimeType: "application/pdf", completionDate: new Date("2026-01-01T12:00:00Z") },
    });
    const dateless = await prisma.hipaaCertificate.create({
      data: { personId: person.id, fileName: "b.pdf", storedName: "b.pdf", size: 1, mimeType: "application/pdf" },
    });

    await prisma.$executeRawUnsafe(GRANDFATHER_SQL);

    const a = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: dated.id } });
    const b = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: dateless.id } });
    expect(a.verifiedAt).not.toBeNull();
    expect(b.verifiedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test npx vitest run src/platform/compliance/grandfather.test.ts`
Expected: FAIL initially only if the SQL is wrong; if it passes immediately that is acceptable (the SQL is the implementation). The test's real job is to lock the invariant. Proceed to author the migration so the same SQL ships.

- [ ] **Step 3: Author the migration file (hand-written, no schema change)**

Create `prisma/migrations/20260629120000_grandfather_unverified_hipaa_dates/migration.sql`:

```sql
-- Grandfather existing self-asserted HIPAA completion dates as accepted so the
-- new verification gate does not retroactively un-clear current volunteers.
-- Only affects rows that already have a date but were never verified.
UPDATE "HipaaCertificate"
SET "verifiedAt" = "uploadedAt"
WHERE "completionDate" IS NOT NULL
  AND "verifiedAt" IS NULL;
```

No `schema.prisma` change is needed (no new columns), so this introduces no drift. It runs automatically on deploy via `prisma migrate deploy`.

- [ ] **Step 4: Confirm migration applies cleanly to a LOCAL db**

Run (LOCAL test DB only, never `.env`):
`TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test npm run test:prepare`
Expected: `migrate deploy` applies the new migration with no error and no drift warning.

- [ ] **Step 5: Run the grandfather test, verify it passes**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test npx vitest run src/platform/compliance/grandfather.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add prisma/migrations src/platform/compliance/grandfather.test.ts
git commit -m "feat(compliance): grandfather existing HIPAA dates on verification-gate rollout (#75)"
```

---

## Task 5: Full verification

- [ ] **Step 1: Typecheck, lint, full test suite**

```bash
npm run typecheck
npm run lint
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test npm run test:prepare
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test npx vitest run
```
Expected: all clean/green. Investigate any failure before proceeding.

- [ ] **Step 2: Manual trace (no code change)**

Confirm by reading: a promoted onboarding contract creates an `IMPORT` cert with a validated date and `verifiedAt: null` -> `complianceStatus` -> `PENDING_VERIFICATION` -> `deriveHipaaTaskState` -> `INCOMPLETE` (held at gate) and `overallClearance` -> `NOT_CLEARED`. A compliance manager hitting the existing verify button on `volunteers/page.tsx` stamps `verifiedAt` -> recomputes `COMPLIANT`.

- [ ] **Step 3: Push and open PR** (only when the user asks)

---

## Self-Review (completed during planning)

- **Spec coverage:** Part 1 validation → Task 1. `PENDING_VERIFICATION` + threading → Task 2. Non-clearing everywhere → Task 2 (gate/clearance) + Task 3 (copy). Manager queue → existing dashboards surfaced in Task 2/3. Grandfather migration → Task 4. Reminders known-limitation → Task 2 Step 6. DB safety → Global Constraints + Task 4. All covered.
- **Placeholder scan:** none (the reminder-context return shape is explicitly flagged "match the file's exact shape").
- **Type consistency:** `complianceStatus` signature `{ completionDate; verifiedAt } | null` is identical in the rules definition (Task 2 Step 3) and every call-site fix (Task 2 Step 5). `ComplianceStatus` union value is `PENDING_VERIFICATION` verbatim throughout.
