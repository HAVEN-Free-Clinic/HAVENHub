# Returning Applicant Department Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any active returning member apply to come back into a department they are not currently in, recorded as a distinct `TRANSFER` applicant type that fills out the full new-applicant form for the target department.

**Architecture:** Add `TRANSFER` to the `ApplicantType` enum (Prisma + the TS union in `engine/visibility.ts`). Transfers reuse the NEW-applicant form via a `scopeForApplicantType` mapping (`TRANSFER -> NEW`), so no form sections are re-tagged. The target department flows through the existing department-choice field; a snapshot of the person's prior departments is stored on the `Application`. Eligibility broadens to any active member of the cycle's track. Promotion is unchanged (membership always comes from the acceptance's department).

**Tech Stack:** Next.js (App Router, RSC + client components), Prisma 6 + Postgres, Vitest, TypeScript.

## Global Constraints

- Database: NEVER run `prisma migrate` or vitest against the shared Neon DB. Use the local Docker Postgres (`localhost:5434`, role `haven` / `haven_dev`) and a worktree-local database `havenhub_transfer`. This worktree must have its own `.env` containing only local URLs.
- Tests resolve the DB from `process.env.TEST_DATABASE_URL` (see `vitest.setup.ts`); vitest does NOT read `.env`, so DB-backed test commands must inline `TEST_DATABASE_URL=...`.
- UI and prose copy: no em dashes (project preference). Use commas, periods, or parentheses.
- Applicant-type wording: "New applicant" / "Renewing in my current department" / "Transferring to a new department". Reserve "Renew/Renewing" for the same-department path; use "Transfer/Transferring" for the new-department path. Admin label for the new type is "Transfer".
- The `ApplicantType` TS union lives in `src/modules/recruitment/engine/visibility.ts` and is imported by services/UI; the Prisma `ApplicantType` enum is separate. Both must include `TRANSFER`.
- Scalar list columns in this schema are declared without `@default` (e.g. `departmentChoices String[]`); follow that convention. Prisma emits a Postgres `DEFAULT ARRAY[]::text[]`, so omitting the value on insert yields `[]`.

---

## Task 0: Bootstrap local database and verify clean baseline

**Files:**
- Create: `.env` (worktree root, git-ignored, local URLs only)

**Interfaces:**
- Produces: a running local Postgres with all existing migrations applied to `havenhub_transfer`, and a green test baseline. Later tasks rely on `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer` for DB-backed tests.

- [ ] **Step 1: Create the worktree `.env` (local URLs only, never Neon)**

```bash
cat > .env <<'EOF'
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer
AUTH_SECRET=test-secret
EMAIL_TRANSPORT=log
EOF
```

- [ ] **Step 2: Install dependencies (creates a worktree-local node_modules and generates the Prisma client)**

Run: `npm install`
Expected: completes; `postinstall` runs `prisma generate`. If `node_modules` is a symlink to the main checkout, remove it first (`rm node_modules`) and re-run so this worktree gets its own client.

- [ ] **Step 3: Start local Postgres**

Run: `npm run db:up`
Expected: the `postgres` compose service is up on host port 5434.

- [ ] **Step 4: Create the worktree database and apply existing migrations**

```bash
docker compose exec -T postgres psql -U haven -d postgres -c "CREATE DATABASE havenhub_transfer" || true
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer \
npx prisma migrate deploy
```
Expected: "All migrations have been applied" (or "No pending migrations").

- [ ] **Step 5: Verify the clean baseline (tests, typecheck, lint)**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer npm test
npm run typecheck
npm run lint
```
Expected: all pass. If any fail before changes, STOP and report (per using-git-worktrees: do not build on a red baseline).

---

## Task 1: Add the `TRANSFER` type (schema + enum migration + widen TS union sites)

This task introduces the new type everywhere it is named, with NO behavior change, so the codebase compiles and all existing tests stay green. Behavior is added in later tasks.

**Files:**
- Modify: `prisma/schema.prisma` (enum `ApplicantType`; model `Application`)
- Modify: `src/modules/recruitment/engine/visibility.ts:1`
- Modify: `src/modules/recruitment/services/drafts.ts:35,79`
- Modify: `src/app/apply/[slug]/draft-actions.ts:8`
- Modify: `src/app/apply/[slug]/apply-form.tsx:17-34,42`
- Modify: `src/app/apply/[slug]/page.tsx:77`

**Interfaces:**
- Produces: `ApplicantType = "NEW" | "RENEWAL" | "TRANSFER"` (TS union) and a Prisma `ApplicantType` enum value `TRANSFER`; new `Application.transferFromDepartments String[]`.

- [ ] **Step 1: Add `TRANSFER` to the Prisma enum and the snapshot column**

In `prisma/schema.prisma`, change the enum (around line 405):

```prisma
enum ApplicantType {
  NEW
  RENEWAL
  TRANSFER
}
```

In `model Application`, add the snapshot field right after `renewalDepartment String?` (line 936):

```prisma
  renewalDepartment String?
  // For a TRANSFER applicant: a snapshot of the department codes they were an
  // active member of at submit time (where they are coming from). Empty for
  // NEW and RENEWAL.
  transferFromDepartments String[]
```

- [ ] **Step 2: Generate and apply the migration against the LOCAL database**

```bash
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer \
npx prisma migrate dev --name returning_applicant_transfer
```
Expected: a new migration under `prisma/migrations/*_returning_applicant_transfer/` containing `ALTER TYPE "ApplicantType" ADD VALUE 'TRANSFER';` and `ALTER TABLE "Application" ADD COLUMN "transferFromDepartments" TEXT[] ...`; the Prisma client regenerates. If Postgres rejects adding and using the enum value in one transaction, split into two migrations (add the value first, then the column); this is unlikely because the column does not use the new value.

- [ ] **Step 3: Widen the TS `ApplicantType` union (source of truth)**

In `src/modules/recruitment/engine/visibility.ts`, line 1:

```ts
export type ApplicantType = "NEW" | "RENEWAL" | "TRANSFER";
```

- [ ] **Step 4: Widen the draft service union sites**

In `src/modules/recruitment/services/drafts.ts`, add the import near the top:

```ts
import type { ApplicantType } from "@/modules/recruitment/engine/visibility";
```

Change `DraftView.applicantType` (line 35) and the `saveDraft` input (line 79) from `"NEW" | "RENEWAL"` to `ApplicantType`:

```ts
  applicantType: ApplicantType;
```
```ts
  input: { answers: Record<string, unknown>; applicantType?: ApplicantType; renewalDepartment?: string | null },
```

- [ ] **Step 5: Widen the draft server-action payload**

In `src/app/apply/[slug]/draft-actions.ts`, add the import and widen the payload type (line 8):

```ts
import type { ApplicantType } from "@/modules/recruitment/engine/visibility";
```
```ts
  payload: { answers: Record<string, unknown>; applicantType?: ApplicantType; renewalDepartment?: string | null },
```

- [ ] **Step 6: Widen the apply-form prop and state types (no behavior change yet)**

In `src/app/apply/[slug]/apply-form.tsx`:

Add `ApplicantType` to the existing visibility import (line 5):

```ts
import { isSectionVisible, type ApplicantType } from "@/modules/recruitment/engine/visibility";
```

Change the two prop types (lines 31 and 33) and the state type (line 42):

```ts
  initialApplicantType?: ApplicantType;
```
```ts
  initialApplicantTypeFromDraft?: ApplicantType;
```
```ts
  const [applicantType, setApplicantType] = useState<ApplicantType>(autoIneligible ? "NEW" : seedType);
```

Leave `chooseType`, `applicantOptions`, and `SectionDef.appliesTo` (the `ApplicantScope` union on line 17) unchanged in this task.

- [ ] **Step 7: Widen the apply page annotation (no behavior change yet)**

In `src/app/apply/[slug]/page.tsx`, add the import and widen the annotation (line 77):

```ts
import type { ApplicantType } from "@/modules/recruitment/engine/visibility";
```
```ts
  const initialApplicantType: ApplicantType = type === "renewal" ? "RENEWAL" : "NEW";
```

- [ ] **Step 8: Typecheck, lint, and run the full suite (still green, behavior unchanged)**

```bash
npm run typecheck
npm run lint
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer npm test
```
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/modules/recruitment/engine/visibility.ts src/modules/recruitment/services/drafts.ts "src/app/apply/[slug]/draft-actions.ts" "src/app/apply/[slug]/apply-form.tsx" "src/app/apply/[slug]/page.tsx"
git commit -m "feat(recruitment): add TRANSFER applicant type (schema + types, no behavior yet)"
```

---

## Task 2: Map `TRANSFER` to the NEW form scope and add a display label

**Files:**
- Modify: `src/modules/recruitment/engine/visibility.ts`
- Test: `src/modules/recruitment/engine/visibility.test.ts`

**Interfaces:**
- Produces: `scopeForApplicantType(type: ApplicantType): "NEW" | "RENEWAL"` and `applicantTypeLabel(type: ApplicantType): string`. `isSectionVisible` now matches a section's `appliesTo` against the mapped scope, so a `TRANSFER` applicant sees the same sections a `NEW` applicant does.

- [ ] **Step 1: Write the failing tests**

In `src/modules/recruitment/engine/visibility.test.ts`, add inside the `describe("isSectionVisible", ...)` block:

```ts
  it("TRANSFER sees NEW sections and BOTH, but not RENEWAL-only", () => {
    expect(isSectionVisible(S({ appliesTo: "NEW" }), { applicantType: "TRANSFER", selectedDepartmentCodes: [] })).toBe(true);
    expect(isSectionVisible(S({}), { applicantType: "TRANSFER", selectedDepartmentCodes: [] })).toBe(true);
    expect(isSectionVisible(S({ appliesTo: "RENEWAL" }), { applicantType: "TRANSFER", selectedDepartmentCodes: [] })).toBe(false);
  });
```

Add a new `describe` block at the end of the file:

```ts
describe("applicantTypeLabel", () => {
  it("labels each applicant type", () => {
    expect(applicantTypeLabel("NEW")).toBe("New");
    expect(applicantTypeLabel("RENEWAL")).toBe("Renewal");
    expect(applicantTypeLabel("TRANSFER")).toBe("Transfer");
  });
});
```

Update the import at the top of the test file to include the new symbol:

```ts
import { isSectionVisible, visibleSections, applicantTypeLabel, type SectionVisibilityInput } from "./visibility";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/recruitment/engine/visibility.test.ts`
Expected: FAIL ("applicantTypeLabel is not a function" and the TRANSFER NEW-section expectation).

- [ ] **Step 3: Implement the mapping and label**

In `src/modules/recruitment/engine/visibility.ts`, add the helper above `isSectionVisible` and use it inside:

```ts
/** A department TRANSFER answers the same questions as a new applicant, so for
 *  section visibility it is scoped to NEW. NEW and RENEWAL map to themselves. */
export function scopeForApplicantType(type: ApplicantType): Exclude<ApplicantScope, "BOTH"> {
  return type === "TRANSFER" ? "NEW" : type;
}

/** Human label for an applicant type, used in review screens. */
export function applicantTypeLabel(type: ApplicantType): string {
  return type === "RENEWAL" ? "Renewal" : type === "TRANSFER" ? "Transfer" : "New";
}
```

Change the `typeMatch` line inside `isSectionVisible` (currently line 21):

```ts
  const scope = scopeForApplicantType(ctx.applicantType);
  const typeMatch = section.appliesTo === "BOTH" || section.appliesTo === scope;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/engine/visibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/engine/visibility.ts src/modules/recruitment/engine/visibility.test.ts
git commit -m "feat(recruitment): scope TRANSFER to the new-applicant form + add applicantTypeLabel"
```

---

## Task 3: Submission service handles TRANSFER (eligibility, snapshot, nudge-to-renew)

**Files:**
- Modify: `src/modules/recruitment/services/submissions.ts`
- Test: `src/modules/recruitment/services/submissions.test.ts`

**Interfaces:**
- Consumes: `getRenewalContext` (returns `{ personId, currentDepartments, eligible }`), `scopeForApplicantType` (indirectly, via the already-updated `visibleSections`).
- Produces: a submitted `Application` with `applicantType="TRANSFER"`, `departmentChoices=[target]`, `transferFromDepartments=[origin snapshot]`, `renewalDepartment=null`, and `applicant.applicantPersonId` set. Targeting a current department throws `SubmissionValidationError`.

- [ ] **Step 1: Write the failing tests**

In `src/modules/recruitment/services/submissions.test.ts`, add these tests (after the existing renewal tests; `makeVolunteer` is a hoisted function declaration so it is in scope):

```ts
it("routes a TRANSFER into a different in-cycle department and snapshots the origin", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("SRHD");
  const app = await submitApplication("apply-v", {
    applicantType: "TRANSFER",
    answers: { first_name: "Tess", last_name: "Fer", email: "tess@yale.edu", "1st_choice_department": "MDIC" },
    files: {},
    sessionPersonId: person.id,
    sessionEmail: "tess@yale.edu",
  });
  expect(app.applicantType).toBe("TRANSFER");
  expect(app.departmentChoices).toEqual(["MDIC"]);
  expect(app.transferFromDepartments).toEqual(["SRHD"]);
  expect(app.renewalDepartment).toBeNull();
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { id: app.applicantId } });
  expect(applicant.applicantPersonId).toBe(person.id);
  expect(applicant.email).toBe("tess@yale.edu");
});

it("allows a TRANSFER from a department not offered by this cycle and enforces the new-applicant supplement", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("EXEC"); // EXEC is not one of the cycle's ["SRHD","MDIC"]
  const app = await submitApplication("apply-v", {
    applicantType: "TRANSFER",
    answers: { first_name: "Ned", last_name: "Ew", email: "ned@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "ready to switch" },
    files: {},
    sessionPersonId: person.id,
    sessionEmail: "ned@yale.edu",
  });
  expect(app.applicantType).toBe("TRANSFER");
  expect(app.departmentChoices).toEqual(["SRHD"]);
  expect(app.transferFromDepartments).toEqual(["EXEC"]);
});

it("rejects a TRANSFER whose target is the person's current department (nudge to renew)", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("SRHD");
  const err = await submitApplication("apply-v", {
    applicantType: "TRANSFER",
    answers: { first_name: "Sam", last_name: "Stay", email: "sam@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "x" },
    files: {},
    sessionPersonId: person.id,
    sessionEmail: "sam@yale.edu",
  }).catch((e) => e);
  expect(err).toBeInstanceOf(SubmissionValidationError);
  expect((err as SubmissionValidationError).fieldErrors).toHaveProperty("1st_choice_department");
});

it("rejects a TRANSFER when the signed-in person has no active membership", async () => {
  await openVolunteerCycle();
  const person = await prisma.person.create({ data: { name: "Stranger", status: "ACTIVE" } });
  await expect(
    submitApplication("apply-v", {
      applicantType: "TRANSFER",
      answers: { first_name: "St", last_name: "Ranger", email: "stranger@yale.edu", "1st_choice_department": "MDIC" },
      files: {},
      sessionPersonId: person.id,
      sessionEmail: "stranger@yale.edu",
    })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("rejects a TRANSFER with no session", async () => {
  await openVolunteerCycle();
  await expect(
    submitApplication("apply-v", {
      applicantType: "TRANSFER",
      answers: { first_name: "An", last_name: "On", email: "anon@yale.edu", "1st_choice_department": "MDIC" },
      files: {},
    })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer npx vitest run src/modules/recruitment/services/submissions.test.ts`
Expected: the five new tests FAIL (a TRANSFER currently falls through the NEW path: no person link, no snapshot, no nudge).

- [ ] **Step 3: Broaden the "accepts returning applicants" gate**

In `src/modules/recruitment/services/submissions.ts`, change the renewals gate (line 98):

```ts
  if ((input.applicantType === "RENEWAL" || input.applicantType === "TRANSFER") && !cycle.acceptsRenewals) {
    throw new CycleNotOpenError("This cycle does not accept returning applicants.");
  }
```

- [ ] **Step 4: Replace the RENEWAL-only identity block with a combined returning block**

Replace lines 102 to 120 (the `let applicantPersonId ...` through the end of the `if (input.applicantType === "RENEWAL") { ... }` block) with:

```ts
  let applicantPersonId: string | null = null;
  // The departments the renewing person currently belongs to, within this cycle.
  // A renewal can only be in one of these, so the department cannot be changed.
  let renewalAllowedDepartments: string[] = [];
  // For a TRANSFER: where the person is coming from (their active departments).
  let transferFromDepartments: string[] = [];
  const isReturning = input.applicantType === "RENEWAL" || input.applicantType === "TRANSFER";
  if (isReturning) {
    const roleNoun = cycle.track === "DIRECTOR" ? "director" : "volunteer";
    if (!input.sessionPersonId || !input.sessionEmail) {
      throw new SubmissionValidationError(`Please sign in with Yale to apply as a returning ${roleNoun}.`);
    }
    const renewalCtx = await getRenewalContext(input.sessionPersonId, input.sessionEmail, cycle.track);
    if (!renewalCtx.eligible) {
      throw new SubmissionValidationError(`We do not see a current ${roleNoun} membership for your account.`);
    }
    applicantPersonId = renewalCtx.personId;
    if (input.applicantType === "RENEWAL") {
      renewalAllowedDepartments = renewalCtx.currentDepartments.filter((d) => cycle.departments.includes(d));
    } else {
      // TRANSFER: the target department comes from the department-choice field,
      // like a new applicant; we only snapshot the origin for reviewer context.
      transferFromDepartments = renewalCtx.currentDepartments;
    }
    // Use the verified session email as the answer too, so schema validation
    // (and any EMAIL field) sees the authoritative value, not the client's.
    input.answers = { ...input.answers, email: input.sessionEmail };
  }
```

- [ ] **Step 5: Add the nudge-to-renew rule in the department-selection block**

Replace the `else` branch of the department-selection block (lines 140 to 144) with:

```ts
  } else {
    const deptField = cycle.sections.flatMap((s) => s.fields).find((f) => f.type === DEPT_CHOICE_KEY_TYPE);
    const raw = deptField ? input.answers[deptField.key] : undefined;
    selectedDepartmentCodes = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
    if (input.applicantType === "TRANSFER") {
      // A transfer may not target a department the person already belongs to;
      // that is a renewal, not a transfer.
      const stayingPut = selectedDepartmentCodes.filter((d) => transferFromDepartments.includes(d));
      if (stayingPut.length > 0) {
        const key = deptField?.key ?? "renewalDepartment";
        throw new SubmissionValidationError(
          `You are already in ${stayingPut.join(", ")}. Choose "Renewing in my current department" to come back to it.`,
          { [key]: "already a member" },
        );
      }
    }
  }
```

- [ ] **Step 6: Use the verified session email for returning applicants (transfers included)**

Change the dedup email line (line 158) from `input.applicantType === "RENEWAL"` to `isReturning`:

```ts
  const email = (isReturning ? input.sessionEmail! : String(input.answers.email ?? "")).trim();
```

- [ ] **Step 7: Persist the transfer snapshot on the Application**

In the `appData` object (lines 228 to 233), add the snapshot field:

```ts
      const appData = {
        answers: answersWithFiles as never,
        applicantType: input.applicantType, departmentChoices: selectedDepartmentCodes, subcommitteeRanking,
        renewalDepartment: input.applicantType === "RENEWAL" ? input.renewalDepartment! : null,
        transferFromDepartments,
        status: "SUBMITTED" as const, submittedAt: new Date(),
      };
```

- [ ] **Step 8: Run the suite to verify it passes**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer npx vitest run src/modules/recruitment/services/submissions.test.ts
npm run typecheck
```
Expected: PASS (the five new tests plus all existing renewal/new tests).

- [ ] **Step 9: Commit**

```bash
git add src/modules/recruitment/services/submissions.ts src/modules/recruitment/services/submissions.test.ts
git commit -m "feat(recruitment): submit TRANSFER applications with origin snapshot and nudge-to-renew"
```

---

## Task 4: Apply flow surfaces the transfer option (page, form, server action, nudge)

This wires the UI so a signed-in returning member can choose to transfer, fills the new-applicant form, and is blocked (with a nudge) from targeting a current department. There is no DB-backed unit test harness for the client form; verification is typecheck plus lint plus a manual smoke check noted at the end.

**Files:**
- Modify: `src/app/apply/[slug]/page.tsx`
- Modify: `src/app/apply/[slug]/apply-form.tsx`
- Modify: `src/app/apply/[slug]/actions.ts`

**Interfaces:**
- Consumes: `getRenewalContext` (page), the widened `ApplicantType`, `submitApplication` (via the server action).
- Produces: `ApplyForm` accepts `isReturning?: boolean`; the form posts `__applicantType="TRANSFER"` and the target via the normal department-choice field; `submitPublicApplication` parses `TRANSFER`.

- [ ] **Step 1: Compute returning eligibility and the transfer seed in the page**

In `src/app/apply/[slug]/page.tsx`, inside the `if (session?.personId) { ... }` block, add an `isReturning` signal. Replace lines 66 to 76 with:

```ts
  let isReturning = false;
  if (session?.personId) {
    signedIn = true;
    signedInName = session.user?.name ?? null;
    const ctx = await getRenewalContext(session.personId, session.user?.email ?? null, cycle.track);
    currentDepartments = ctx.currentDepartments.filter((d) => cycle.departments.includes(d));
    // Renewal needs a current department offered by this cycle. Transfer only
    // needs an active membership in the track (their department may be elsewhere).
    eligible = ctx.eligible && currentDepartments.length > 0;
    isReturning = ctx.eligible;
    const fields = cycle.sections.flatMap((s) => s.fields).map((f) => ({ key: f.key, type: f.type }));
    prefill = resolveRenewalPrefill(fields, ctx);
  }
```

Declare `isReturning` with the other `let` flags if your formatter prefers; the key change is computing `isReturning = ctx.eligible` and keeping `eligible` as the cycle-narrowed renewal flag.

Change the initial-type line (line 77) to recognize `?type=transfer`:

```ts
  const initialApplicantType: ApplicantType = type === "renewal" ? "RENEWAL" : type === "transfer" ? "TRANSFER" : "NEW";
```

Pass `isReturning` to the form (line 86); add `isReturning={isReturning}` to the `<ApplyForm ... />` props.

- [ ] **Step 2: Accept `isReturning`, offer the transfer option, and correct ineligible seeds in the form**

In `src/app/apply/[slug]/apply-form.tsx`:

Add the prop to the destructure (line 22 area) and the prop type (after `eligible?: boolean;`):

```ts
  def, signedIn = false, signedInName = null, eligible = false, isReturning = false, prefill, currentDepartments = [], initialApplicantType = "NEW",
```
```ts
  eligible?: boolean;
  isReturning?: boolean;
```

Replace the seed/ineligible computation (lines 39 to 43) with:

```ts
  // A returning seed type the visitor cannot use here is corrected to New, with a note.
  const renewalUnavailable = seedType === "RENEWAL" && signedIn && !eligible;
  const transferUnavailable = seedType === "TRANSFER" && (!signedIn || !isReturning);
  const autoIneligible = renewalUnavailable || transferUnavailable;
  const [applicantType, setApplicantType] = useState<ApplicantType>(autoIneligible ? "NEW" : seedType);
  const [ineligibleNote, setIneligibleNote] = useState(autoIneligible);
```

Replace `applicantOptions` (lines 81 to 84) with a list filtered by availability:

```ts
  const applicantOptions = [
    { value: "NEW" as const, label: "New applicant", desc: "First time applying", show: true },
    { value: "RENEWAL" as const, label: "Renewing in my current department", desc: `Continue as a ${roleNoun} in a department you are already in`, show: !signedIn || eligible },
    { value: "TRANSFER" as const, label: "Transferring to a new department", desc: `Return as a ${roleNoun} in a different department`, show: signedIn && isReturning },
  ].filter((o) => o.show);
```

Replace `chooseType` (lines 86 to 94) with:

```ts
  function chooseType(v: ApplicantType) {
    if (v === "RENEWAL" && signedIn && !eligible) { setApplicantType("NEW"); setIneligibleNote(true); return; }
    if (v === "TRANSFER" && signedIn && !isReturning) { setApplicantType("NEW"); setIneligibleNote(true); return; }
    setIneligibleNote(false);
    setApplicantType(v);
  }
```

- [ ] **Step 3: Add the nudge flag and block submit when transferring into a current department**

In `src/app/apply/[slug]/apply-form.tsx`, add after the `selectedDepartmentCodes` memo (around line 136):

```ts
  const transferIntoCurrent =
    applicantType === "TRANSFER" && deptChoice !== "" && currentDepartments.includes(deptChoice);
```

Guard `onSubmit` (top of the function body, line 143 area):

```ts
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (transferIntoCurrent) return;
    setSubmitting(true);
```

In the JSX, add the nudge alert immediately before the submit button (just before `<Button type="submit" ...>` on line 255), and disable the button when the nudge is active:

```tsx
          {transferIntoCurrent && (
            <Alert tone="warning">
              You are already a {roleNoun} in {deptChoice}. Choose &ldquo;Renewing in my current department&rdquo; to come back to it.
            </Alert>
          )}

          <Button type="submit" disabled={submitting || transferIntoCurrent}>{submitting ? "Submitting..." : "Submit application"}</Button>
```

(Optional, consistent with renewal) extend the "Signed in as" line (line 224) to also show for transfers:

```tsx
          {signedIn && (applicantType === "RENEWAL" ? eligible : applicantType === "TRANSFER" ? isReturning : false) && signedInName && (
            <p className="text-sm text-muted-foreground">Signed in as {signedInName}.</p>
          )}
```

- [ ] **Step 4: Parse `TRANSFER` in the server action**

In `src/app/apply/[slug]/actions.ts`, change the parse line (line 16):

```ts
  const applicantType: ApplicantType =
    rawType === "RENEWAL" ? "RENEWAL" : rawType === "TRANSFER" ? "TRANSFER" : "NEW";
```

- [ ] **Step 5: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```
Expected: pass.

- [ ] **Step 6: Manual smoke check (no automated client test exists)**

Start the app against the local DB and verify the three paths:

```bash
npm run dev
```
- As a signed-in member whose department is in the cycle: all three options appear; choosing Transfer shows the department-choice field; selecting your current department shows the nudge and disables Submit; selecting a different department lets you submit and lands `applicantType=TRANSFER`.
- As a signed-in member whose department is NOT in the cycle: New and Transfer appear, Renew does not.
- As a non-member: only New appears.

Record the result in the commit message or PR description.

- [ ] **Step 7: Commit**

```bash
git add "src/app/apply/[slug]/page.tsx" "src/app/apply/[slug]/apply-form.tsx" "src/app/apply/[slug]/actions.ts"
git commit -m "feat(recruitment): offer department transfer in the apply flow with nudge-to-renew"
```

---

## Task 5: Show the applicant type label and transfer origin in review screens

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`

**Interfaces:**
- Consumes: `applicantTypeLabel` (Task 2), `Application.transferFromDepartments` (Task 1).

- [ ] **Step 1: Label the type in the applicants list**

In `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx`, add to the visibility import (line 10 area; there is currently no import from visibility, so add one):

```ts
import { applicantTypeLabel } from "@/modules/recruitment/engine/visibility";
```

Change the type cell (line 59):

```tsx
                <TD className="text-foreground-soft">{applicantTypeLabel(a.applicantType)}</TD>
```

- [ ] **Step 2: Label the type and show origin on the detail page**

In `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`, extend the existing visibility import (line 4):

```ts
import { visibleSections, applicantTypeLabel } from "@/modules/recruitment/engine/visibility";
```

Replace the `description` prop of `PageHeader` (line 66):

```tsx
        description={`${app.applicant.email} · ${applicantTypeLabel(app.applicantType)}${
          app.renewalDepartment ? ` · renewing in ${app.renewalDepartment}` : ""
        }${
          app.applicantType === "TRANSFER" && app.transferFromDepartments.length > 0
            ? ` · returning member, previously ${app.transferFromDepartments.join(", ")}`
            : ""
        }`}
```

- [ ] **Step 3: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx" "src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx"
git commit -m "feat(recruitment): label applicant types and show transfer origin in review"
```

---

## Task 6: Lock the promotion behavior for transfers (membership comes from the acceptance)

Promotion already creates the membership from `contract.acceptance.departmentCode`, independent of applicant type. This task adds a regression test proving a transfer lands in the accepted department, not the person's prior one.

**Files:**
- Modify: `src/modules/recruitment/services/promotion.test.ts`

**Interfaces:**
- Consumes: `promoteContracts`, the `seedSubmitted` helper (extended with `applicantType` and `transferFromDepartments`).

- [ ] **Step 1: Extend the test helper to accept an applicant type and origin snapshot**

In `src/modules/recruitment/services/promotion.test.ts`, widen the `seedSubmitted` signature (line 8) and the `Application` create (line 16):

```ts
async function seedSubmitted(opts: { netId?: string; email?: string; epicNeeded?: boolean; existingEpicId?: string; applicantType?: "NEW" | "RENEWAL" | "TRANSFER"; transferFromDepartments?: string[] } = {}) {
```
```ts
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: opts.applicantType ?? "NEW", departmentChoices: ["SRHD"], transferFromDepartments: opts.transferFromDepartments ?? [] } });
```

- [ ] **Step 2: Write the failing test**

Add at the end of `src/modules/recruitment/services/promotion.test.ts`:

```ts
it("promotes a TRANSFER applicant into the accepted department, not their prior one", async () => {
  const { term, srhd, srr, contract } = await seedSubmitted({ applicantType: "TRANSFER", transferFromDepartments: ["MDIC"] });
  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 1, reactivated: 0, skipped: 0 });
  const person = await prisma.person.findFirstOrThrow({ where: { netId: "al99" } });
  expect(await prisma.termMembership.count({ where: { personId: person.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER" } })).toBe(1);
});
```

(`srhd` is the accepted department; `transferFromDepartments: ["MDIC"]` is the origin. The assertion confirms membership lands in the accepted department.)

- [ ] **Step 3: Run the test**

Run: `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer npx vitest run src/modules/recruitment/services/promotion.test.ts`
Expected: PASS immediately (promotion is already applicant-type-agnostic; this test documents and guards that). If it fails, investigate before proceeding rather than changing promotion.

- [ ] **Step 4: Commit**

```bash
git add src/modules/recruitment/services/promotion.test.ts
git commit -m "test(recruitment): promotion places a TRANSFER in the accepted department"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the entire suite, typecheck, and lint**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer npm test
npm run typecheck
npm run lint
```
Expected: all green.

- [ ] **Step 2: Confirm migration status is clean**

```bash
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_transfer \
npx prisma migrate status
```
Expected: "Database schema is up to date" with the new `returning_applicant_transfer` migration listed. The migration is additive (a new enum value and a list column defaulting to `[]`), so production `migrate deploy` needs no backfill.

- [ ] **Step 3: Note deferred coverage**

E2E coverage for the transfer happy-path (`e2e/recruitment.spec.ts`) is deferred; the apply-flow behavior is covered manually in Task 4 Step 6 and by the unit tests in Tasks 2, 3, and 6. Record this in the PR description so the gap is explicit.

---

## Self-Review Notes (spec coverage)

- Distinct `TRANSFER` type, surfaced in review: Tasks 1, 2, 5.
- Full new-applicant form for transfers (TRANSFER -> NEW scope): Task 2; enforced supplement covered by a test in Task 3.
- Eligibility = any active member of the track (origin may be outside the cycle): Tasks 3 and 4, tested in Task 3.
- Nudge-to-renew (UI + server): Task 3 (server) and Task 4 (form), tested server-side in Task 3.
- Origin snapshot for reviewer context: Tasks 1, 3, 5.
- Wording "New / Renewing in my current department / Transferring to a new department", admin label "Transfer": Tasks 2, 4.
- Promotion unchanged, locked by test: Task 6.
- Out of scope (transfer-only questions, auto-ending prior membership, renew-and-transfer in one cycle): not implemented, per spec.
