# Applicant Self-Withdrawal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an applicant remove themselves from consideration on the application portal, at every stage from unsubmitted draft through accepted-but-not-yet-promoted.

**Architecture:** A third `ApplicationStatus` value, `WITHDRAWN`, plus a `withdrawnAt` stamp. Because every reviewer-facing query already filters `status: "SUBMITTED"`, flipping the status removes the applicant from the review queue, the scoring pool, speed-routing, and the director digest without editing any of them. Withdrawal never deletes acceptances, interviews, or onboarding contracts: it is a declaration, and staff execute cleanup with the guarded tooling that already exists. Unsubmitted drafts are the one exception and are deleted outright, because a terminal row would lock the applicant out of a still-open cycle.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma 6 on Postgres, vitest against a real test database, Playwright for e2e, Tailwind with the in-repo design system.

**Spec:** `docs/superpowers/specs/2026-08-07-applicant-self-withdraw-design.md`

## Global Constraints

- **No em-dash (U+2014) anywhere under `src/**/*.{ts,tsx}`.** CI-enforced by the custom `local/no-em-dash` ESLint rule (`eslint.config.mjs:123-129`), which scans raw source text so it catches the character in comments and strings too. Use a comma, colon, parentheses, or hyphen.
- **Lint with `npx eslint src e2e`**, not `npm run lint`. The bare script walks the gitignored `HAVEN Free Clinic Design System/` directory and produces noise.
- **Every test command must carry the database prefix.** Run tests as:

  ```bash
  TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_selfwithdraw npm test -- <files>
  ```

  This is not optional and `.env` will not do it for you. **Vitest does not load `.env`**, so without the inline prefix `vitest.setup.ts` falls back to the shared `havenhub_test` database, which is behind on migrations and shared with other worktrees. The symptom is a wall of `relation "X" does not exist` errors that look like broken code and are not. `havenhub_test_selfwithdraw` is this worktree's dedicated database and is already fully migrated.
- **Postgres is native on :5434, not Docker.** Do NOT run `npm run db:up`: the port is already bound by the running native instance and compose will fail. It is already up.
- **Never run a Prisma command without an explicit local `DATABASE_URL`.** The main checkout's `.env` points every database URL at **production Neon**. This worktree has its own `.env` pointing at `havenhub_test_selfwithdraw`, so plain `npx prisma migrate deploy` is safe *here*, but never copy a database URL in from the main checkout.
- **`npm run typecheck` must pass before every commit.**
- Vitest runs with `fileParallelism: false` because integration tests share one database. Every DB-backed test file calls `resetDb()` in both `beforeEach` and `afterEach`.
- The email render engine supports `{{#if}}` but **has no `{{#each}}`**. Any list must be pre-joined into a string before it reaches a template.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/modules/recruitment/services/withdraw.ts` | All withdrawal logic: identity-scoped lookup, the atomic status claim, draft discard, staff reopen, notification fan-out |
| `src/modules/recruitment/services/withdraw.test.ts` | Integration tests for the above against the real test DB |
| `prisma/migrations/<timestamp>_application_withdrawn/migration.sql` | Enum value + column |

**Modified:**

| File | Change |
| --- | --- |
| `prisma/schema.prisma` | `ApplicationStatus` gains `WITHDRAWN`; `Application` gains `withdrawnAt` |
| `src/modules/recruitment/services/portal-tracker.ts` | Hide the tracker for `WITHDRAWN` |
| `src/modules/recruitment/services/portal-status.ts` | New `WITHDRAWN` state, new server-computed `withdraw` eligibility field |
| `src/platform/notifications/registry.ts` | One new notification type |
| `src/platform/email/templates/recruitment.ts` | One new template descriptor + context builder |
| `src/app/apply/portal-actions.ts` | Two new server actions |
| `src/app/apply/status-card.tsx` | Action footer, draft-branch restructure |
| `src/modules/recruitment/services/interviews.ts` | Surface withdrawal on panelist assignments |
| `src/app/(app)/recruitment/interviews/page.tsx` | Render the withdrawn badge |
| `src/app/(app)/recruitment/cycles/[id]/page.tsx` | Exclude withdrawn from department counts |
| `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts` | Staff reopen action |
| `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` | Staff reopen control |
| `e2e/apply-portal.spec.ts` | End-to-end withdrawal pass |

---

## Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma:534-537` (the `ApplicationStatus` enum), `prisma/schema.prisma:1368` (the `Application.status` field, add `withdrawnAt` beneath it)
- Create: `prisma/migrations/<timestamp>_application_withdrawn/migration.sql` (generated)
- Test: `src/modules/recruitment/services/withdraw.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `WITHDRAWN` value of `ApplicationStatus` and `Application.withdrawnAt: Date | null`, both used by every later task. Also produces the `seedCycle()` test fixture that Tasks 3, 4, 5 and 8 extend.

- [ ] **Step 1: Write the failing test**

Create `src/modules/recruitment/services/withdraw.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

/** A published volunteer cycle with one applicant holding one application.
 *  Later tasks append their tests to THIS file and reuse this fixture rather
 *  than writing their own, so it stays module-private (no export). */
async function seedCycle(
  slug: string,
  email: string,
  opts: { appStatus?: "DRAFT" | "SUBMITTED" | "WITHDRAWN"; cycleStatus?: "OPEN" | "CLOSED" } = {},
) {
  const appStatus = opts.appStatus ?? "SUBMITTED";
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "RA " + slug, grants: { create: [{ permission: "recruitment.review_all" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(), status: "ACTIVE" },
  });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "Student Run Health Dept" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER", termId: term.id, title: "Volunteer 2026", publicSlug: slug,
      departments: ["SRHD"], createdById: srr.id, status: opts.cycleStatus ?? "OPEN",
    },
  });
  const applicant = await prisma.applicant.create({
    data: { cycleId: cycle.id, firstName: "Reed", lastName: "Rivers", email, emailLower: email.toLowerCase() },
  });
  const app = await prisma.application.create({
    data: {
      cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW",
      departmentChoices: ["SRHD"], status: appStatus,
      submittedAt: appStatus === "DRAFT" ? null : new Date(),
    },
  });
  return { srr, term, dept, cycle, applicant, app };
}

/** The portal identity shape (email is always already lowercased). */
const ID = (email: string) => ({ email: email.toLowerCase(), personId: null, firstName: null });

it("stores a WITHDRAWN application with a withdrawnAt stamp", async () => {
  const { app } = await seedCycle("w-schema", "reed@yale.edu", { appStatus: "WITHDRAWN" });
  const stamped = await prisma.application.update({
    where: { id: app.id },
    data: { withdrawnAt: new Date() },
  });
  expect(stamped.status).toBe("WITHDRAWN");
  expect(stamped.withdrawnAt).toBeInstanceOf(Date);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/modules/recruitment/services/withdraw.test.ts`

Expected: FAIL. TypeScript rejects `"WITHDRAWN"` as an `ApplicationStatus` and rejects `withdrawnAt` as an unknown property on the update input.

- [ ] **Step 3: Edit the schema**

In `prisma/schema.prisma`, change the enum at line 534:

```prisma
enum ApplicationStatus {
  DRAFT
  SUBMITTED
  WITHDRAWN
}
```

And in `model Application`, directly beneath the `status` field (line 1368), add:

```prisma
  status                   ApplicationStatus @default(SUBMITTED)
  /// Set when the applicant removed themselves through the portal. Null on every
  /// other row. Withdrawal is a declaration only: it never deletes acceptances,
  /// interviews, or onboarding contracts, which have their own guarded teardown.
  withdrawnAt              DateTime?
```

- [ ] **Step 4: Generate the migration**

Run: `npx prisma migrate dev --name application_withdrawn`

Then **open the generated `migration.sql` and confirm it contains only these two statements**:

```sql
-- AlterEnum
ALTER TYPE "ApplicationStatus" ADD VALUE 'WITHDRAWN';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "withdrawnAt" TIMESTAMP(3);
```

`prisma migrate dev` folds any pre-existing dev-database drift into the new migration file. Delete any statement unrelated to the two above before committing, or unrelated schema changes ship to production under this migration's name.

- [ ] **Step 5: Run the test**

Run:

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_selfwithdraw npm test -- src/modules/recruitment/services/withdraw.test.ts
```

Expected: PASS.

Do NOT run `npm run test:prepare`. It shells out to `docker compose exec postgres`, which fails here (Postgres is native, not containerised), and it resolves `TEST_DATABASE_URL` from the shell rather than `.env`, so it would target the wrong database. Step 4's `migrate dev` already applied the migration to this worktree's database, because Prisma (unlike vitest and npm scripts) does read `.env`.

- [ ] **Step 6: Typecheck, lint, and commit**

```bash
npm run typecheck
npx eslint src e2e
git add prisma/schema.prisma prisma/migrations src/modules/recruitment/services/withdraw.test.ts
git commit -m "feat(recruitment): add WITHDRAWN application status and withdrawnAt stamp"
```

---

## Task 2: Portal status and tracker know about withdrawal

**Files:**
- Modify: `src/modules/recruitment/services/portal-tracker.ts:29-45`
- Modify: `src/modules/recruitment/services/portal-status.ts:7-14` (the view type) and `:44-93` (the loop)
- Test: `src/modules/recruitment/services/portal-tracker.test.ts`, `src/modules/recruitment/services/portal-status.test.ts`

**Interfaces:**
- Consumes: `ApplicationStatus.WITHDRAWN` from Task 1.
- Produces: `ApplicantStatusView.state` gains the `"WITHDRAWN"` member; `ApplicantStatusView` gains `withdraw: WithdrawOption | null` where `export type WithdrawOption = { kind: "discard_draft" | "withdraw" | "decline_offer" }`, exported from `portal-status.ts`. Task 6 renders from this field; Tasks 3 and 5 implement the actions each `kind` names.

**Eligibility rules** (this task is the single source of truth for which control appears):

| Portal state | `withdraw` |
| --- | --- |
| `DRAFT`, cycle open | `{ kind: "discard_draft" }` |
| `DRAFT`, cycle closed | `null` |
| `WITHDRAWN` | `null` |
| `SUBMITTED` | `{ kind: "withdraw" }` |
| `INTERVIEW` | `{ kind: "withdraw" }` |
| `WAITLISTED` | `{ kind: "withdraw" }` |
| `NOT_SELECTED` | `null` |
| `ACCEPTED` | `{ kind: "decline_offer" }` |
| `ONBOARDING`, contract not `PROMOTED` | `{ kind: "decline_offer" }` |
| `ONBOARDING`, contract `PROMOTED` | `null` |

`WAITLISTED` and `NOT_SELECTED` both sit on `status: "SUBMITTED"` underneath, so the service in Task 3 permits either. The difference is deliberate and lives here: coming off a waitlist is a real thing an applicant wants to do, while offering "withdraw" to someone already told they were not selected is pointless.

- [ ] **Step 1: Write the failing tracker test**

Append to `src/modules/recruitment/services/portal-tracker.test.ts`, inside the existing `describe("trackerStageFor", ...)` block:

```ts
  it("WITHDRAWN hides the tracker", () => {
    const s = trackerStageFor("WITHDRAWN");
    expect(s.showTracker).toBe(false);
    expect(s.nodes).toEqual([]);
    expect(s.terminal).toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/modules/recruitment/services/portal-tracker.test.ts`

Expected: FAIL. TypeScript rejects `"WITHDRAWN"` because it is not in the `ApplicantStatusView["state"]` union.

- [ ] **Step 3: Add the state to the view type and the withdraw field**

In `src/modules/recruitment/services/portal-status.ts`, replace the type block at lines 7-14:

```ts
/** Which self-service control the portal should offer for this application.
 *  Computed on the server and re-checked in the action; the client only renders
 *  what it is given and never decides eligibility itself. */
export type WithdrawOption = { kind: "discard_draft" | "withdraw" | "decline_offer" };

export type ApplicantStatusView = {
  slug: string;
  cycleTitle: string;
  state: "DRAFT" | "SUBMITTED" | "INTERVIEW" | "ACCEPTED" | "ONBOARDING" | "NOT_SELECTED" | "WAITLISTED" | "WITHDRAWN";
  headline: string;
  detail: string | null;
  canContinue: boolean;
  withdraw: WithdrawOption | null;
};
```

- [ ] **Step 4: Handle WITHDRAWN in the tracker**

In `src/modules/recruitment/services/portal-tracker.ts`, add a case to the switch in `trackerStageFor`, immediately after the `DRAFT` case:

```ts
    case "WITHDRAWN":
      // No progress rail on a withdrawn application: running "Submitted, In
      // review, Interview, Decision" past it would imply movement that stopped.
      return { showTracker: false, nodes: [], terminal: null };
```

- [ ] **Step 5: Run the tracker test to verify it passes**

Run: `npm test -- src/modules/recruitment/services/portal-tracker.test.ts`

Expected: PASS.

- [ ] **Step 6: Write the failing status-service test**

Append to `src/modules/recruitment/services/portal-status.test.ts`:

```ts
it("reports WITHDRAWN with no withdraw control", async () => {
  const { app } = await cycleWithApp("cw1", "reed@yale.edu");
  await prisma.application.update({
    where: { id: app.id },
    data: { status: "WITHDRAWN", withdrawnAt: new Date() },
  });
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  expect(v.state).toBe("WITHDRAWN");
  expect(v.headline).toBe("Withdrawn");
  expect(v.withdraw).toBeNull();
});

it("offers discard_draft on an open-cycle draft and nothing once the cycle closes", async () => {
  await cycleWithApp("cw2", "reed@yale.edu", { appStatus: "DRAFT" });
  expect((await getApplicantStatus(ID("reed@yale.edu")))[0].withdraw).toEqual({ kind: "discard_draft" });

  await cycleWithApp("cw3", "dana@yale.edu", { appStatus: "DRAFT", cycleStatus: "CLOSED" });
  expect((await getApplicantStatus(ID("dana@yale.edu")))[0].withdraw).toBeNull();
});

it("offers withdraw under review and decline_offer once accepted", async () => {
  const { srr, app, cycle } = await cycleWithApp("cw4", "reed@yale.edu");
  expect((await getApplicantStatus(ID("reed@yale.edu")))[0].withdraw).toEqual({ kind: "withdraw" });

  await accept(app.id, "SRHD", srr.id);
  await releaseDecisions(cycle.id, srr.id);
  expect((await getApplicantStatus(ID("reed@yale.edu")))[0].withdraw).toEqual({ kind: "decline_offer" });
});

it("offers nothing once the onboarding contract is promoted", async () => {
  const { srr, app, cycle } = await cycleWithApp("cw5", "reed@yale.edu");
  const acc = await accept(app.id, "SRHD", srr.id);
  await releaseDecisions(cycle.id, srr.id);
  await createOrResendContract(acc.id, srr.id, "http://test");
  await prisma.onboardingContract.update({
    where: { acceptanceId: acc.id },
    data: { status: "PROMOTED", promotedAt: new Date() },
  });
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  expect(v.state).toBe("ONBOARDING");
  expect(v.withdraw).toBeNull();
});

it("offers nothing once the applicant was not selected", async () => {
  const { srr, cycle } = await cycleWithApp("cw6", "reed@yale.edu");
  await releaseDecisions(cycle.id, srr.id);
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  expect(v.state).toBe("NOT_SELECTED");
  expect(v.withdraw).toBeNull();
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npm test -- src/modules/recruitment/services/portal-status.test.ts`

Expected: FAIL. Every new assertion fails because `withdraw` is `undefined` on the returned views and no `WITHDRAWN` branch exists.

- [ ] **Step 8: Implement the branches in getApplicantStatus**

In `src/modules/recruitment/services/portal-status.ts`, replace the body of the `for (const a of applicants)` loop (lines 44-93) with:

```ts
  for (const a of applicants) {
    const app = a.applications[0];
    if (!app) continue;
    const base = { slug: a.cycle.publicSlug, cycleTitle: a.cycle.title };

    if (app.status === "WITHDRAWN") {
      views.push({ ...base, state: "WITHDRAWN", headline: "Withdrawn", detail: "You withdrew this application.", canContinue: false, withdraw: null });
      continue;
    }
    if (app.status === "DRAFT") {
      // A draft is only continuable while its cycle is still accepting
      // applications. Once the cycle closes, the destination form rejects the
      // submission, so do not offer a dead "Continue" link here. Discarding is
      // gated the same way: after close there is nothing left to discard toward.
      const open = isCycleOpen(a.cycle, now);
      views.push(open
        ? { ...base, state: "DRAFT", headline: "Draft", detail: "Continue your application", canContinue: true, withdraw: { kind: "discard_draft" } }
        : { ...base, state: "DRAFT", headline: "Applications closed", detail: "This cycle is no longer accepting applications.", canContinue: false, withdraw: null });
      continue;
    }
    const releasedAt = a.cycle.decisionsReleasedAt;
    const released = releasedAt != null;
    // NOT_SELECTED must hang on a per-application signal, not merely the
    // cycle-level release stamp. Release is allowed on an OPEN cycle, is
    // repeatable/batched, and survives reopen, so an application submitted (or
    // newly created) after a release must not inherit a false definitive
    // rejection. The strongest correct per-application signal available is the
    // submission time: only an application submitted at/before the release was
    // in the pool that release decided on. Residual limitation: there is no
    // per-application decision timestamp on the volunteer not-selected path, so
    // an application submitted before release that reviewers simply never got to
    // still reads NOT_SELECTED, same as an intentional pass (pre-existing).
    const decidedForApp = releasedAt != null && app.submittedAt != null && app.submittedAt <= releasedAt;
    const emailedAcc = app.acceptances.find((acc) => acc.emailedAt != null);
    const onboardingAcc = app.acceptances.find((acc) => acc.contract != null);
    const scheduledInterview = app.interviews.find((iv) => iv.scheduledAt != null);
    const waitlisted = released && (app.interviews.some((iv) => iv.decision === "WAITLIST") || app.decision === "WAITLIST");

    if (onboardingAcc?.contract) {
      const step = onboardingAcc.contract.status === "PROMOTED" ? "Complete" : onboardingAcc.contract.status === "SUBMITTED" ? "Form submitted" : "Form sent to you";
      // A PROMOTED contract means they hold a real TermMembership. They are a
      // member now, not an applicant, and /my-info withdrawFromTerm is the path.
      const withdraw: WithdrawOption | null = onboardingAcc.contract.status === "PROMOTED" ? null : { kind: "decline_offer" };
      views.push({ ...base, state: "ONBOARDING", headline: "Onboarding in progress", detail: step, canContinue: false, withdraw });
    } else if (emailedAcc) {
      views.push({ ...base, state: "ACCEPTED", headline: `Accepted to ${deptName.get(emailedAcc.departmentCode) ?? emailedAcc.departmentCode}`, detail: null, canContinue: false, withdraw: { kind: "decline_offer" } });
    } else if (released && waitlisted) {
      // Coming off a waitlist is a real thing to want, so the control stays.
      views.push({ ...base, state: "WAITLISTED", headline: "Waitlisted", detail: "We will be in touch if a spot opens.", canContinue: false, withdraw: { kind: "withdraw" } });
    } else if (decidedForApp && app.acceptances.length === 0) {
      // Guard against the conflict case: if acceptance rows exist but none is emailed (pending resolution),
      // fall through to the neutral state rather than showing a false rejection.
      // No control here: withdrawing from a decision already made is pointless.
      views.push({ ...base, state: "NOT_SELECTED", headline: "Not selected this cycle", detail: "Thank you for applying.", canContinue: false, withdraw: null });
    } else if (scheduledInterview?.scheduledAt) {
      const zone = await getDisplayTimeZone();
      const when = formatDateTime(scheduledInterview.scheduledAt, zone, { dateStyle: "long", timeStyle: "short" });
      views.push({ ...base, state: "INTERVIEW", headline: "Interview scheduled", detail: scheduledInterview.zoomLink ? `${when} (join link in your email)` : when, canContinue: false, withdraw: { kind: "withdraw" } });
    } else {
      views.push({ ...base, state: "SUBMITTED", headline: "Submitted", detail: "Under review", canContinue: false, withdraw: { kind: "withdraw" } });
    }
  }
```

Also add `contract: { select: { status: true } }` is already present in the acceptances select at line 28, so no include change is needed. Confirm that line still reads:

```ts
          acceptances: { select: { departmentCode: true, emailedAt: true, contract: { select: { status: true } } } },
```

- [ ] **Step 9: Run both test files to verify they pass**

Run: `npm test -- src/modules/recruitment/services/portal-status.test.ts src/modules/recruitment/services/portal-tracker.test.ts`

Expected: PASS, including every pre-existing test in both files.

- [ ] **Step 10: Typecheck, lint, and commit**

```bash
npm run typecheck
npx eslint src e2e
git add src/modules/recruitment/services/portal-status.ts src/modules/recruitment/services/portal-tracker.ts src/modules/recruitment/services/portal-status.test.ts src/modules/recruitment/services/portal-tracker.test.ts
git commit -m "feat(recruitment): portal status reports withdrawal and its eligible control"
```

---

## Task 3: The withdrawal write

**Files:**
- Create: `src/modules/recruitment/services/withdraw.ts`
- Modify: `src/modules/recruitment/services/withdraw.test.ts`

**Interfaces:**
- Consumes: `ApplicationStatus.WITHDRAWN` and `withdrawnAt` (Task 1); `ApplicantIdentity` from `./portal-auth` (shape `{ email: string; personId: string | null; firstName: string | null }`, where `email` is always already lowercased).
- Produces:
  - `export class WithdrawError extends Error`
  - `export type WithdrawKind = "withdraw" | "decline_offer"`
  - `export async function withdrawApplication(slug: string, identity: ApplicantIdentity): Promise<{ kind: WithdrawKind }>`
  Task 4 adds notification inside this function. Task 6 calls it from a server action.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/recruitment/services/withdraw.test.ts`:

```ts
import { withdrawApplication, WithdrawError } from "./withdraw";
import { releaseDecisions } from "./decisions";
import { createOrResendContract } from "./onboarding";

it("withdraws a submitted application and stamps withdrawnAt", async () => {
  const { app } = await seedCycle("w1", "reed@yale.edu");
  const res = await withdrawApplication("w1", ID("reed@yale.edu"));
  expect(res.kind).toBe("withdraw");
  const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  expect(after.status).toBe("WITHDRAWN");
  expect(after.withdrawnAt).toBeInstanceOf(Date);
});

it("reports decline_offer when an acceptance exists", async () => {
  const { srr, app } = await seedCycle("w2", "reed@yale.edu");
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id } });
  const res = await withdrawApplication("w2", ID("reed@yale.edu"));
  expect(res.kind).toBe("decline_offer");
});

it("leaves acceptances, contracts, and interviews untouched", async () => {
  const { srr, app, cycle } = await seedCycle("w3", "reed@yale.edu");
  const acc = await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id } });
  await releaseDecisions(cycle.id, srr.id);
  await createOrResendContract(acc.id, srr.id, "http://test");
  const iv = await prisma.interview.create({
    data: { applicationId: app.id, departmentCode: "SRHD", createdById: srr.id, scheduledAt: new Date() },
  });

  await withdrawApplication("w3", ID("reed@yale.edu"));

  expect(await prisma.acceptance.count({ where: { id: acc.id } })).toBe(1);
  expect(await prisma.onboardingContract.count({ where: { acceptanceId: acc.id } })).toBe(1);
  expect(await prisma.interview.count({ where: { id: iv.id } })).toBe(1);
});

it("refuses once the onboarding contract is promoted", async () => {
  const { srr, app, cycle } = await seedCycle("w4", "reed@yale.edu");
  const acc = await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id } });
  await releaseDecisions(cycle.id, srr.id);
  await createOrResendContract(acc.id, srr.id, "http://test");
  await prisma.onboardingContract.update({
    where: { acceptanceId: acc.id },
    data: { status: "PROMOTED", promotedAt: new Date() },
  });
  await expect(withdrawApplication("w4", ID("reed@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
  expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).status).toBe("SUBMITTED");
});

it("is idempotent: a second call rejects and does not restamp", async () => {
  const { app } = await seedCycle("w5", "reed@yale.edu");
  await withdrawApplication("w5", ID("reed@yale.edu"));
  const first = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  await expect(withdrawApplication("w5", ID("reed@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
  const second = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  expect(second.withdrawnAt?.getTime()).toBe(first.withdrawnAt?.getTime());
});

it("refuses to touch another applicant's application", async () => {
  const { app } = await seedCycle("w6", "reed@yale.edu");
  await expect(withdrawApplication("w6", ID("intruder@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
  expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).status).toBe("SUBMITTED");
});

it("refuses on an unsubmitted draft", async () => {
  await seedCycle("w7", "reed@yale.edu", { appStatus: "DRAFT" });
  await expect(withdrawApplication("w7", ID("reed@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- src/modules/recruitment/services/withdraw.test.ts`

Expected: FAIL with `Failed to resolve import "./withdraw"`.

- [ ] **Step 3: Write the service**

Create `src/modules/recruitment/services/withdraw.ts`:

```ts
/**
 * Applicant self-withdrawal from the application portal.
 *
 * The core rule: withdrawal DECLARES, it does not tear down. It flips
 * Application.status to WITHDRAWN, stamps withdrawnAt, and audits. It never
 * deletes an Acceptance, cancels an Interview, or touches an OnboardingContract.
 *
 * That restraint is load-bearing. revokeAcceptance (services/review.ts) refuses
 * outright to delete an acceptance that has a contract, because
 * OnboardingContract.acceptance is onDelete: Cascade and deleting through it
 * would destroy submitted signatures, DOB, and the HIPAA certificate, and orphan
 * the stored blob. interview-decisions.ts carries the mirror guard. A portal
 * action that reached past those guards could destroy onboarding records from an
 * unauthenticated-adjacent surface. So staff execute any cleanup with the
 * existing guarded tooling; this module only records the applicant's intent.
 *
 * Same shape as recordSelfWithdrawal in platform/offboarding: the subject
 * declares, ops executes.
 */

import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import type { ApplicantIdentity } from "./portal-auth";

export class WithdrawError extends Error {
  constructor(m: string) { super(m); this.name = "WithdrawError"; }
}

export type WithdrawKind = "withdraw" | "decline_offer";

const PROMOTED_MESSAGE =
  "You are already on this term's roster. Use My Info to step back, or contact us.";
const RACED_MESSAGE = "This application has already been updated.";

/**
 * The signed-in applicant's own application for this cycle, or null.
 *
 * Resolution is BY SLUG AND IDENTITY ONLY. No identifier supplied by the request
 * ever selects the record, so a forged form field cannot reach somebody else's
 * application. Mirrors findRow in drafts.ts; identity.email is already lowercased
 * by portal-auth, matching the emailLower column directly.
 */
async function findOwnApplication(slug: string, identity: ApplicantIdentity) {
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { publicSlug: slug },
    select: { id: true, title: true, status: true, opensAt: true, closesAt: true },
  });
  if (!cycle) return null;
  const applicant = await prisma.applicant.findFirst({
    where: {
      cycleId: cycle.id,
      OR: [
        { emailLower: identity.email },
        ...(identity.personId ? [{ applicantPersonId: identity.personId }] : []),
      ],
    },
    include: {
      applications: {
        include: {
          acceptances: { select: { departmentCode: true, contract: { select: { status: true } } } },
          interviews: { select: { id: true, departmentCode: true, scheduledAt: true } },
        },
      },
    },
  });
  const application = applicant?.applications[0];
  if (!applicant || !application) return null;
  return { cycle, applicant, application };
}

/**
 * Remove the applicant from consideration. Returns which flavour of withdrawal
 * it was, so the caller can word its confirmation correctly.
 *
 * Throws WithdrawError for every refusal (not found, wrong owner, still a draft,
 * already withdrawn, already promoted) so the portal action can render the
 * message without leaking whether the slug or the identity was the mismatch.
 */
export async function withdrawApplication(
  slug: string,
  identity: ApplicantIdentity,
): Promise<{ kind: WithdrawKind }> {
  const row = await findOwnApplication(slug, identity);
  if (!row) throw new WithdrawError("Application not found.");
  const { application } = row;

  if (application.status === "DRAFT") throw new WithdrawError("This application has not been submitted yet.");
  if (application.status === "WITHDRAWN") throw new WithdrawError(RACED_MESSAGE);
  if (application.acceptances.some((a) => a.contract?.status === "PROMOTED")) {
    throw new WithdrawError(PROMOTED_MESSAGE);
  }

  const kind: WithdrawKind = application.acceptances.length > 0 ? "decline_offer" : "withdraw";

  const claimed = await prisma.$transaction(async (tx) => {
    // Re-read the promotion state INSIDE the transaction. The guard above ran
    // before this transaction opened, so a promotion that committed in between
    // would otherwise be withdrawn straight past.
    const promoted = await tx.onboardingContract.count({
      where: { acceptance: { applicationId: application.id }, status: "PROMOTED" },
    });
    if (promoted > 0) throw new WithdrawError(PROMOTED_MESSAGE);

    // Atomic claim on the SUBMITTED precondition, in the style of the draft claim
    // in submissions.ts. A double-click, a retry, or a race against a staff
    // decision loses the claim rather than writing twice, which is what keeps the
    // notification in Task 4 from firing more than once.
    const res = await tx.application.updateMany({
      where: { id: application.id, status: "SUBMITTED" },
      data: { status: "WITHDRAWN", withdrawnAt: new Date() },
    });
    return res.count === 1;
  });
  if (!claimed) throw new WithdrawError(RACED_MESSAGE);

  await recordAudit({
    actorPersonId: identity.personId ?? undefined,
    action: "recruitment.application_withdraw",
    entityType: "Application",
    entityId: application.id,
    after: { kind, self: true },
  });

  return { kind };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/modules/recruitment/services/withdraw.test.ts`

Expected: PASS, all eight tests.

- [ ] **Step 5: Typecheck, lint, and commit**

```bash
npm run typecheck
npx eslint src e2e
git add src/modules/recruitment/services/withdraw.ts src/modules/recruitment/services/withdraw.test.ts
git commit -m "feat(recruitment): withdrawApplication with an atomic claim and promotion ceiling"
```

---

## Task 4: Notify the people whose time it costs

**Files:**
- Modify: `src/platform/notifications/registry.ts:43` (append to `NOTIFICATION_TYPES`)
- Modify: `src/platform/email/templates/recruitment.ts` (append a context builder and a descriptor)
- Modify: `src/modules/recruitment/services/withdraw.ts`
- Test: `src/modules/recruitment/services/withdraw.test.ts`

**Interfaces:**
- Consumes: `withdrawApplication` (Task 3); `notify(db, input)` from `@/platform/notifications/notify` (input is `{ type, person: { id, entraObjectId, contactEmail }, email: { subject, html }, teams: { title, summary, link }, triggeredById }`); `departmentDirectorPersonIds(departmentId)` from `@/platform/departments`; `peopleWithAnyPermission(permissions)` from `@/platform/rbac/holders`; `renderEmail(key, context)` from `@/platform/email/templates/renderEmail`.
- Produces: the notification type key `recruitment.applicant_withdrew` and `applicantWithdrewContext(params)` exported from `src/platform/email/templates/recruitment.ts`.

**Who is notified:**

| Situation | Recipients |
| --- | --- |
| Any interview on the application has `scheduledAt` set | every `InterviewPanelist` on those interviews, plus `departmentDirectorPersonIds` for each of those interviews' `departmentCode` |
| `kind === "decline_offer"` | `departmentDirectorPersonIds` for each acceptance's `departmentCode`, plus `peopleWithAnyPermission(["recruitment.review_all"])` |
| Neither | nobody |

Both can apply at once (a scheduled interview and an acceptance); recipients are unioned and deduped. The withdrawing applicant is never a recipient: on the renewal path they have a `Person` and could otherwise be in a director list for their own withdrawal.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/recruitment/services/withdraw.test.ts`:

```ts
/** Grant a permission to a fresh person and return them. */
async function personWithPermission(name: string, permission: string) {
  const p = await prisma.person.create({ data: { name, status: "ACTIVE", contactEmail: `${name}@yale.edu` } });
  const role = await prisma.role.create({ data: { name: `${name}-role`, grants: { create: [{ permission }] } } });
  await prisma.roleAssignment.create({ data: { personId: p.id, roleId: role.id } });
  return p;
}

it("notifies the panel when a scheduled interview is withdrawn from", async () => {
  const { srr, app } = await seedCycle("w8", "reed@yale.edu");
  const panelist = await prisma.person.create({
    data: { name: "Pat Panel", status: "ACTIVE", contactEmail: "pat@yale.edu" },
  });
  const iv = await prisma.interview.create({
    data: { applicationId: app.id, departmentCode: "SRHD", createdById: srr.id, scheduledAt: new Date() },
  });
  await prisma.interviewPanelist.create({ data: { interviewId: iv.id, personId: panelist.id } });

  await withdrawApplication("w8", ID("reed@yale.edu"));

  const queued = await prisma.notification.findMany({ where: { personId: panelist.id } });
  expect(queued).toHaveLength(1);
});

it("stays silent for a plain under-review withdrawal", async () => {
  await seedCycle("w9", "reed@yale.edu");
  await withdrawApplication("w9", ID("reed@yale.edu"));
  // notify() always writes an inbox row, so a zero count proves nobody was told
  // through any channel.
  expect(await prisma.notification.count()).toBe(0);
});

it("notifies review_all holders when an offer is declined", async () => {
  const { srr, app } = await seedCycle("w10", "reed@yale.edu");
  const reviewer = await personWithPermission("Robin", "recruitment.review_all");
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id } });

  await withdrawApplication("w10", ID("reed@yale.edu"));

  expect(await prisma.notification.count({ where: { personId: reviewer.id } })).toBe(1);
});

it("does not notify twice when the second withdrawal loses the claim", async () => {
  const { srr, app } = await seedCycle("w11", "reed@yale.edu");
  const reviewer = await personWithPermission("Rory", "recruitment.review_all");
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: srr.id } });

  await withdrawApplication("w11", ID("reed@yale.edu"));
  await expect(withdrawApplication("w11", ID("reed@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);

  expect(await prisma.notification.count({ where: { personId: reviewer.id } })).toBe(1);
});
```

Note: `personWithPermission` grants an unscoped role, so the `recruitment.review_all` holder created by `seedCycle` (named "SRR") also matches. The third test asserts on the specific reviewer's id rather than a global count for that reason.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- src/modules/recruitment/services/withdraw.test.ts`

Expected: FAIL. The notify assertions find zero rows because nothing dispatches yet.

- [ ] **Step 3: Register the notification type**

In `src/platform/notifications/registry.ts`, add to the `NOTIFICATION_TYPES` array immediately after the `recruitment.review_digest` entry:

```ts
  { key: "recruitment.applicant_withdrew", label: "Recruitment: applicant withdrew (panel + directors)", defaultChannel: "email" },
```

- [ ] **Step 4: Add the email template**

In `src/platform/email/templates/recruitment.ts`, add this context builder above the descriptor array:

```ts
export type ApplicantWithdrewParams = {
  /** Full name of the applicant who withdrew. */
  applicantName: string;
  /** The recruitment cycle's title. */
  cycleTitle: string;
  /** True when they were declining an offer rather than withdrawing from review. */
  declinedOffer: boolean;
  /** True when they had an interview on the schedule. */
  hadScheduledInterview: boolean;
  /** Comma-joined department codes affected, e.g. "SRHD, MDIC". */
  departments: string;
  /** Absolute link to the applicant's detail page. */
  reviewLink: string;
};

/** Build the flat render-engine context for recruitment.applicant_withdrew.
 *  Department codes arrive pre-joined: the render engine has no {{#each}}. */
export function applicantWithdrewContext(p: ApplicantWithdrewParams): Record<string, unknown> {
  return {
    applicantName: p.applicantName,
    cycleTitle: p.cycleTitle,
    declinedOffer: p.declinedOffer,
    hadScheduledInterview: p.hadScheduledInterview,
    departments: p.departments,
    reviewLink: p.reviewLink,
  };
}
```

And add this entry to the `recruitmentDescriptors` array:

```ts
  {
    key: "recruitment.applicant_withdrew",
    name: "Recruitment: applicant withdrew",
    category: "transactional",
    group: "recruitment",
    variables: [
      { name: "applicantName", label: "Applicant who withdrew", sampleValue: "Reed Rivers" },
      { name: "cycleTitle", label: "Recruitment cycle title", sampleValue: "Volunteer 2026" },
      { name: "declinedOffer", label: "True when they declined an offer", sampleValue: "false" },
      { name: "hadScheduledInterview", label: "True when an interview was on the schedule", sampleValue: "true" },
      { name: "departments", label: "Affected department codes (comma-joined)", sampleValue: "SRHD, MDIC" },
      { name: "reviewLink", label: "Link to the applicant detail page", sampleValue: "https://hub.havenfreeclinic.org/recruitment" },
    ],
    defaultSubject: "[HAVEN] {{ applicantName }} withdrew from {{ cycleTitle }}",
    defaultBody: `<p>Hello,</p>

{{#if declinedOffer}}<p>{{ applicantName }} declined their offer for {{ cycleTitle }} ({{ departments }}).</p>

<p>Their acceptance and any onboarding paperwork are still on file and unchanged. Rescind the acceptance on the Decisions page, or withdraw the onboarding contract first if one was already sent.</p>{{else}}<p>{{ applicantName }} withdrew their application to {{ cycleTitle }} ({{ departments }}).</p>{{/if}}

{{#if hadScheduledInterview}}<p>They had an interview on the schedule. It has not been cancelled automatically, so the slot is still held until someone removes it.</p>{{/if}}

<p>They no longer appear in the review queue.</p>

<p><a href="{{ reviewLink }}">Open recruitment</a></p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
```

- [ ] **Step 5: Dispatch from the service**

In `src/modules/recruitment/services/withdraw.ts`, add these imports:

```ts
import { notify } from "@/platform/notifications/notify";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { departmentDirectorPersonIds } from "@/platform/departments";
import { getSetting } from "@/platform/settings/service";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { applicantWithdrewContext } from "@/platform/email/templates/recruitment";
```

Add this function beneath `findOwnApplication`:

```ts
/**
 * Tell the people who would otherwise act on stale information.
 *
 * Deliberately silent for a plain under-review withdrawal: the application falls
 * out of the review queue on its own, and during a live cycle one notification
 * per withdrawal is noise on exactly the population that generates the most of
 * them. Notification is reserved for a held interview slot and a planned roster
 * spot, where a human is about to spend time on somebody who is gone.
 */
async function notifyWithdrawal(input: {
  applicantName: string;
  cycleTitle: string;
  kind: WithdrawKind;
  scheduledDepartmentCodes: string[];
  acceptedDepartmentCodes: string[];
  scheduledInterviewIds: string[];
  actorPersonId: string | null;
}): Promise<void> {
  const declinedOffer = input.kind === "decline_offer";
  const hadScheduledInterview = input.scheduledInterviewIds.length > 0;
  if (!declinedOffer && !hadScheduledInterview) return;

  const recipientIds = new Set<string>();

  if (hadScheduledInterview) {
    const panelists = await prisma.interviewPanelist.findMany({
      where: { interviewId: { in: input.scheduledInterviewIds } },
      select: { personId: true },
    });
    for (const p of panelists) recipientIds.add(p.personId);
  }

  // departmentDirectorPersonIds takes a department id, not a code.
  const codes = [...new Set([...input.scheduledDepartmentCodes, ...input.acceptedDepartmentCodes])];
  if (codes.length > 0) {
    const depts = await prisma.department.findMany({ where: { code: { in: codes } }, select: { id: true } });
    for (const d of depts) {
      for (const id of await departmentDirectorPersonIds(d.id)) recipientIds.add(id);
    }
  }

  if (declinedOffer) {
    for (const p of await peopleWithAnyPermission(["recruitment.review_all"])) recipientIds.add(p.id);
  }

  // Never notify the withdrawing applicant about their own withdrawal: on the
  // renewal path they have a Person and can sit in one of the lists above.
  if (input.actorPersonId) recipientIds.delete(input.actorPersonId);
  if (recipientIds.size === 0) return;

  const baseUrl = await getSetting<string>("app.baseUrl");
  const reviewLink = `${baseUrl}/recruitment`;
  const departments = codes.join(", ");
  const { subject, html } = await renderEmail(
    "recruitment.applicant_withdrew",
    applicantWithdrewContext({
      applicantName: input.applicantName,
      cycleTitle: input.cycleTitle,
      declinedOffer,
      hadScheduledInterview,
      departments,
      reviewLink,
    }),
  );

  const summary = declinedOffer
    ? `${input.applicantName} declined their offer for ${input.cycleTitle}. Their acceptance is still on file.`
    : `${input.applicantName} withdrew from ${input.cycleTitle}${hadScheduledInterview ? " and their interview slot is still held." : "."}`;

  const recipients = await prisma.person.findMany({
    where: { id: { in: [...recipientIds] } },
    select: { id: true, entraObjectId: true, contactEmail: true },
  });
  for (const person of recipients) {
    await notify(prisma, {
      type: "recruitment.applicant_withdrew",
      person,
      email: { subject, html },
      teams: { title: `${input.applicantName} withdrew`, summary, link: reviewLink },
      triggeredById: input.actorPersonId,
    });
  }
}
```

Then, in `withdrawApplication`, replace the `return { kind };` at the end with:

```ts
  // Only after a won claim, so a lost race cannot send the panel a second
  // cancellation email.
  await notifyWithdrawal({
    applicantName: `${row.applicant.firstName} ${row.applicant.lastName}`.trim(),
    cycleTitle: row.cycle.title,
    kind,
    scheduledDepartmentCodes: application.interviews.filter((iv) => iv.scheduledAt != null).map((iv) => iv.departmentCode),
    acceptedDepartmentCodes: application.acceptances.map((a) => a.departmentCode),
    scheduledInterviewIds: application.interviews.filter((iv) => iv.scheduledAt != null).map((iv) => iv.id),
    actorPersonId: identity.personId,
  });

  return { kind };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- src/modules/recruitment/services/withdraw.test.ts src/platform/email/templates`

Expected: PASS. The email template registry test verifies every descriptor's sample values render, so it exercises the new template too.

- [ ] **Step 7: Typecheck, lint, and commit**

```bash
npm run typecheck
npx eslint src e2e
git add src/modules/recruitment/services/withdraw.ts src/modules/recruitment/services/withdraw.test.ts src/platform/notifications/registry.ts src/platform/email/templates/recruitment.ts
git commit -m "feat(recruitment): notify panel and directors when a withdrawal costs them time"
```

---

## Task 5: Discard an unsubmitted draft

**Files:**
- Modify: `src/modules/recruitment/services/withdraw.ts`
- Test: `src/modules/recruitment/services/withdraw.test.ts`

**Interfaces:**
- Consumes: `findOwnApplication` (Task 3, module-private); `cleanupFiles(keys)` from `./upload`; `isCycleOpen(cycle, now)` from `./cycle-window`.
- Produces: `export async function discardDraft(slug: string, identity: ApplicantIdentity): Promise<void>`. Task 6 calls it.

Deletion rather than a `WITHDRAWN` marker is required here, not merely tidier. `Application` carries `@@unique([cycleId, applicantId])`, so a terminal row would permanently lock the applicant out of a cycle that is still open. This reuses the exact teardown `sweepAbandonedDrafts` performs (`drafts.ts:206-222`): gather the stored file keys out of `answers`, clean up the blobs, then delete the `Applicant`, which cascades to the draft.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/recruitment/services/withdraw.test.ts`:

```ts
import { discardDraft } from "./withdraw";

it("deletes the draft and its applicant so a fresh application is possible", async () => {
  const { app, applicant, cycle } = await seedCycle("w12", "reed@yale.edu", { appStatus: "DRAFT" });
  await discardDraft("w12", ID("reed@yale.edu"));
  expect(await prisma.application.count({ where: { id: app.id } })).toBe(0);
  expect(await prisma.applicant.count({ where: { id: applicant.id } })).toBe(0);
  // The unique (cycleId, emailLower) slot is free again.
  const fresh = await prisma.applicant.create({
    data: { cycleId: cycle.id, firstName: "Reed", lastName: "Rivers", email: "reed@yale.edu", emailLower: "reed@yale.edu" },
  });
  expect(fresh.id).toBeTruthy();
});

it("refuses to discard a submitted application", async () => {
  const { app } = await seedCycle("w13", "reed@yale.edu");
  await expect(discardDraft("w13", ID("reed@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
  expect(await prisma.application.count({ where: { id: app.id } })).toBe(1);
});

it("refuses once the cycle has closed", async () => {
  const { app } = await seedCycle("w14", "reed@yale.edu", { appStatus: "DRAFT", cycleStatus: "CLOSED" });
  await expect(discardDraft("w14", ID("reed@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
  expect(await prisma.application.count({ where: { id: app.id } })).toBe(1);
});

it("refuses to discard another applicant's draft", async () => {
  const { app } = await seedCycle("w15", "reed@yale.edu", { appStatus: "DRAFT" });
  await expect(discardDraft("w15", ID("intruder@yale.edu"))).rejects.toBeInstanceOf(WithdrawError);
  expect(await prisma.application.count({ where: { id: app.id } })).toBe(1);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- src/modules/recruitment/services/withdraw.test.ts`

Expected: FAIL with `discardDraft is not a function` / no exported member `discardDraft`.

- [ ] **Step 3: Implement it**

In `src/modules/recruitment/services/withdraw.ts`, add these imports:

```ts
import { cleanupFiles } from "./upload";
import { isCycleOpen } from "./cycle-window";
```

And add this exported function:

```ts
/**
 * Throw away an unsubmitted draft, including any files uploaded into it.
 *
 * Deletes rather than marking WITHDRAWN, and that is required, not merely
 * tidier: Application carries @@unique([cycleId, applicantId]), so a terminal
 * row would lock the applicant out of a cycle that is still open. Discard at
 * 2pm, change your mind at 3pm, no way back in.
 *
 * Reuses the teardown sweepAbandonedDrafts performs (drafts.ts): collect the
 * stored file keys out of answers, clean up the blobs, then delete the Applicant,
 * which cascades to the draft Application. One Applicant holds exactly one
 * application per cycle (@@unique([cycleId, emailLower])), so deleting it takes
 * nothing else with it.
 *
 * Only offered while the cycle is open, matching the canContinue gate in
 * portal-status: after close there is nothing left to discard toward, and the
 * stale-draft sweep will collect it anyway.
 */
export async function discardDraft(slug: string, identity: ApplicantIdentity): Promise<void> {
  const row = await findOwnApplication(slug, identity);
  if (!row) throw new WithdrawError("Application not found.");
  const { cycle, applicant, application } = row;
  if (application.status !== "DRAFT") throw new WithdrawError("This application has already been submitted.");
  if (!isCycleOpen(cycle, new Date())) throw new WithdrawError("This cycle is no longer accepting applications.");

  const full = await prisma.application.findUnique({
    where: { id: application.id },
    select: { answers: true },
  });
  const answers = ((full?.answers as Record<string, unknown> | null) ?? {});
  const keys: string[] = [];
  for (const v of Object.values(answers)) {
    if (v && typeof v === "object" && "storedName" in (v as object)) {
      keys.push(`recruitment/${cycle.id}/${(v as { storedName: string }).storedName}`);
    }
  }
  await cleanupFiles(keys);
  await prisma.applicant.delete({ where: { id: applicant.id } });

  await recordAudit({
    actorPersonId: identity.personId ?? undefined,
    action: "recruitment.draft_discard",
    entityType: "Application",
    entityId: application.id,
    before: { cycleId: cycle.id, files: keys.length },
  });
}
```

Note the `select: { id: true, title: true, status: true, opensAt: true, closesAt: true }` in `findOwnApplication` already returns everything `isCycleOpen` needs.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/modules/recruitment/services/withdraw.test.ts`

Expected: PASS, all sixteen tests.

- [ ] **Step 5: Typecheck, lint, and commit**

```bash
npm run typecheck
npx eslint src e2e
git add src/modules/recruitment/services/withdraw.ts src/modules/recruitment/services/withdraw.test.ts
git commit -m "feat(recruitment): discard an unsubmitted draft from the portal"
```

---

## Task 6: Portal actions and the status card control

**Files:**
- Modify: `src/app/apply/portal-actions.ts`
- Modify: `src/app/apply/status-card.tsx`
- Test: manual verification plus the e2e pass in Task 9

**Interfaces:**
- Consumes: `withdrawApplication`, `discardDraft`, `WithdrawError` (Tasks 3 and 5); `ApplicantStatusView.withdraw` (Task 2); `ConfirmButton` from `@/platform/ui/confirm-button`.
- Produces: `withdrawApplicationAction(slug: string): Promise<void>` and `discardDraftAction(slug: string): Promise<void>`, both server actions bound with `.bind(null, slug)` in the card.

- [ ] **Step 1: Add the server actions**

In `src/app/apply/portal-actions.ts`, add these imports:

```ts
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withdrawApplication, discardDraft, WithdrawError } from "@/modules/recruitment/services/withdraw";
import { termGroupForCycleSlug } from "@/platform/posthog/groups";
```

Two things already exist in this file and must not be imported twice: `captureEvent` from `@/platform/posthog/capture` (line 5), and the `@/modules/recruitment/services/portal-auth` import on line 4, which currently brings in `requestMagicLink` and `APPLICANT_COOKIE`. Add `getApplicantIdentity` to that existing line rather than writing a second import from the same module.

Add both actions:

```ts
/**
 * Remove the applicant from consideration.
 *
 * Takes the cycle SLUG, never an applicationId. The service re-derives the
 * identity and resolves the application from (slug, identity), so no identifier
 * carried by the request can select another applicant's row.
 */
export async function withdrawApplicationAction(slug: string): Promise<void> {
  const identity = await getApplicantIdentity();
  if (!identity) redirect("/apply");
  try {
    const { kind } = await withdrawApplication(slug, identity);
    await captureEvent({
      distinctId: identity.personId ?? identity.email,
      event: "application_withdrawn",
      properties: { slug, kind },
      groups: await termGroupForCycleSlug(slug),
    });
  } catch (err) {
    // A refusal (already withdrawn, promoted, raced) is not exceptional: the
    // portal re-renders and the card already shows the true current state.
    if (!(err instanceof WithdrawError)) throw err;
  }
  revalidatePath("/apply");
}

/** Throw away an unsubmitted draft and its uploads. */
export async function discardDraftAction(slug: string): Promise<void> {
  const identity = await getApplicantIdentity();
  if (!identity) redirect("/apply");
  try {
    await discardDraft(slug, identity);
    await captureEvent({
      distinctId: identity.personId ?? identity.email,
      event: "application_draft_discarded",
      properties: { slug },
      groups: await termGroupForCycleSlug(slug),
    });
  } catch (err) {
    if (!(err instanceof WithdrawError)) throw err;
  }
  revalidatePath("/apply");
}
```

- [ ] **Step 2: Rebuild the status card**

Replace the whole of `src/app/apply/status-card.tsx` with:

```tsx
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, cardClasses } from "@/platform/ui/card";
import { cx } from "@/platform/ui/cx";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import type { ApplicantStatusView } from "@/modules/recruitment/services/portal-status";
import { ApplicationTracker } from "./application-tracker";
import { withdrawApplicationAction, discardDraftAction } from "./portal-actions";

/** Copy for each control, keyed by the server-computed withdraw kind. */
const CONTROL = {
  discard_draft: { label: "Discard draft", confirm: "Discard? This deletes your answers and any files." },
  withdraw: { label: "Withdraw application", confirm: "Withdraw? We will stop considering you this cycle." },
  decline_offer: { label: "Decline offer", confirm: "Decline this offer?" },
} as const;

/** The two-click destructive control, rendered only when the server said so.
 *  Eligibility lives in portal-status; this component never decides it. */
function WithdrawControl({ app }: { app: ApplicantStatusView }) {
  if (!app.withdraw) return null;
  const { label, confirm } = CONTROL[app.withdraw.kind];
  const action = app.withdraw.kind === "discard_draft" ? discardDraftAction : withdrawApplicationAction;
  return (
    <form action={action.bind(null, app.slug)} className="mt-3 flex justify-end border-t border-border-subtle pt-3">
      <ConfirmButton label={label} confirmLabel={confirm} size="sm" />
    </form>
  );
}

export function StatusCard({ app }: { app: ApplicantStatusView }) {
  // Drafts get a compact "continue" row rather than a tracker. The row is NOT a
  // whole-card link: a button nested inside an anchor is invalid markup and
  // unreliable for keyboard users, so the link is scoped to its own cue.
  if (app.state === "DRAFT" && app.canContinue) {
    return (
      <Card className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">{app.cycleTitle}</span>
            <span className="block truncate text-xs text-muted-foreground">{app.detail ?? "Continue your application"}</span>
          </span>
          <Link
            href={`/apply/${app.slug}`}
            className={cx(cardClasses({ interactive: true, pad: false }), "group inline-flex shrink-0 items-center gap-1 px-3 py-1.5 text-sm font-medium text-brand-fg")}
          >
            Continue
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
        </div>
        <WithdrawControl app={app} />
      </Card>
    );
  }

  return (
    <Card className="space-y-1">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{app.cycleTitle}</p>
          {app.detail && <p className="mt-0.5 text-xs text-muted-foreground">{app.detail}</p>}
        </div>
        <span className="shrink-0 rounded-full bg-brand-faint px-3 py-1 text-xs font-semibold text-brand-fg">{app.headline}</span>
      </div>
      <ApplicationTracker state={app.state} />
      <WithdrawControl app={app} />
    </Card>
  );
}
```

- [ ] **Step 3: Verify the tracker component accepts the new state**

Open `src/app/apply/application-tracker.tsx` and confirm its `state` prop is typed as `ApplicantStatusView["state"]` (so it widened automatically in Task 2) rather than a hand-written union. If it is a hand-written union, add `"WITHDRAWN"` to it. `trackerStageFor` already returns `showTracker: false` for that state, so the component renders nothing.

- [ ] **Step 4: Typecheck and lint**

```bash
npm run typecheck
npx eslint src e2e
```

Expected: clean. If `local/no-em-dash` fires, replace the character with a comma or a colon.

- [ ] **Step 5: Verify by hand**

Start the app with `npm run dev`, sign in to `/apply` as an applicant with a submitted application, and confirm: the card shows a "Withdraw application" button, one click arms it to the confirm label, a second click withdraws, and the card re-renders as "Withdrawn" with no tracker and no button.

- [ ] **Step 6: Commit**

```bash
git add src/app/apply/portal-actions.ts src/app/apply/status-card.tsx src/app/apply/application-tracker.tsx
git commit -m "feat(apply): applicants can withdraw or discard from the portal status card"
```

---

## Task 7: The two surfaces that do not filter on status

**Files:**
- Modify: `src/modules/recruitment/services/interviews.ts:224-232` (`myAssignedInterviews`)
- Modify: `src/app/(app)/recruitment/interviews/page.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/page.tsx:46`
- Test: `src/modules/recruitment/services/withdraw.test.ts`

**Interfaces:**
- Consumes: `WITHDRAWN` status (Task 1).
- Produces: `myAssignedInterviews` now selects `application.status`, so the page can badge it. No signature change.

- [ ] **Step 1: Write the failing regression tests**

Append to `src/modules/recruitment/services/withdraw.test.ts`:

```ts
import { listApplicantsForReview } from "./review";
import { pendingReviewCount } from "./review-digest";
import { myAssignedInterviews } from "./interviews";

it("drops a withdrawn application out of the review queue and the digest count", async () => {
  const { srr, cycle } = await seedCycle("w16", "reed@yale.edu");
  expect(await listApplicantsForReview(cycle.id, srr.id)).toHaveLength(1);
  expect(await pendingReviewCount(["SRHD"])).toBe(1);

  await withdrawApplication("w16", ID("reed@yale.edu"));

  expect(await listApplicantsForReview(cycle.id, srr.id)).toHaveLength(0);
  expect(await pendingReviewCount(["SRHD"])).toBe(0);
});

it("keeps a withdrawn applicant's interview visible to the panel, marked withdrawn", async () => {
  const { srr, app } = await seedCycle("w17", "reed@yale.edu");
  const panelist = await prisma.person.create({
    data: { name: "Pat Panel", status: "ACTIVE", contactEmail: "pat2@yale.edu" },
  });
  const iv = await prisma.interview.create({
    data: { applicationId: app.id, departmentCode: "SRHD", createdById: srr.id, scheduledAt: new Date() },
  });
  await prisma.interviewPanelist.create({ data: { interviewId: iv.id, personId: panelist.id } });

  await withdrawApplication("w17", ID("reed@yale.edu"));

  const mine = await myAssignedInterviews(panelist.id);
  expect(mine).toHaveLength(1);
  expect(mine[0].application.status).toBe("WITHDRAWN");
});
```

- [ ] **Step 2: Run them and expect both to PASS immediately**

Run: `npm test -- src/modules/recruitment/services/withdraw.test.ts`

Expected: PASS, both of them, with no production code written yet. This is the one task in the plan that is not red-green, and that is the correct outcome rather than a sign the tests are wrong:

- The review-queue test passes because `review.ts` and `review-digest.ts` already filter `status: "SUBMITTED"`. That falling-out-for-free behavior is the entire justification for modelling withdrawal as an enum value, so it needs a test pinning it down. Without one, somebody later relaxes a filter to `{ not: "DRAFT" }` and silently puts withdrawn applicants back in front of reviewers.
- The `myAssignedInterviews` test passes because the query uses `include` on `application`, which returns every scalar field, `status` among them.

If either test FAILS, stop: something about the queries differs from what this plan assumed, and the rest of the task needs rethinking.

- [ ] **Step 3: Document why myAssignedInterviews keeps withdrawn rows**

The query needs no change. Add the doc comment so the next person does not "optimize" the withdrawn rows away. In `src/modules/recruitment/services/interviews.ts`, replace `myAssignedInterviews` (line 224) with:

```ts
/** Interviews where this person sits on the panel.
 *  A withdrawn applicant's interview is deliberately still returned: silently
 *  dropping the row is how a panelist dials into a call that was cancelled. The
 *  status rides along so the page can mark it and free the slot. */
export async function myAssignedInterviews(personId: string) {
  return prisma.interview.findMany({
    where: { panelists: { some: { personId } } },
    include: {
      application: {
        include: { applicant: { select: { firstName: true, lastName: true } }, cycle: { select: { id: true, title: true } } },
      },
      evaluations: { where: { evaluatorId: personId } },
    },
    orderBy: { scheduledAt: "asc" },
  });
}
```

The body is byte-for-byte the existing implementation. Only the doc comment above it is new.

- [ ] **Step 4: Badge it on the page**

In `src/app/(app)/recruitment/interviews/page.tsx`, replace the Candidate cell so a withdrawn applicant is visibly marked:

```tsx
              <TD>
                <Link
                  className="font-medium text-foreground hover:text-brand-fg"
                  href={`/recruitment/interviews/${iv.id}`}
                >
                  {iv.application.applicant.firstName} {iv.application.applicant.lastName}
                </Link>
                {iv.application.status === "WITHDRAWN" && (
                  <Badge tone="warning" className="ml-2">Withdrawn</Badge>
                )}
              </TD>
```

`Badge` is already imported on line 9.

- [ ] **Step 5: Exclude withdrawn from the cycle-overview department counts**

In `src/app/(app)/recruitment/cycles/[id]/page.tsx`, change line 46 to:

```tsx
  // Withdrawn applications are excluded: this count warns staff how many
  // applicants a department removal would affect, and nobody will act on a
  // withdrawn one, so counting it overstates the consequence.
  const apps = await prisma.application.findMany({ where: { cycleId: id, status: { not: "WITHDRAWN" } }, select: { departmentChoices: true } });
```

Note: `{ not: "WITHDRAWN" }` on a non-nullable enum column is safe. The Prisma `not` gotcha only drops rows when the column is nullable, and `Application.status` is `ApplicationStatus @default(SUBMITTED)`, not optional.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- src/modules/recruitment/services/withdraw.test.ts`

Expected: PASS, all eighteen tests.

- [ ] **Step 7: Typecheck, lint, and commit**

```bash
npm run typecheck
npx eslint src e2e
git add src/modules/recruitment/services/interviews.ts "src/app/(app)/recruitment/interviews/page.tsx" "src/app/(app)/recruitment/cycles/[id]/page.tsx" src/modules/recruitment/services/withdraw.test.ts
git commit -m "feat(recruitment): mark withdrawn applicants on panel lists and drop them from cycle counts"
```

---

## Task 8: Staff can reopen a withdrawal

**Files:**
- Modify: `src/modules/recruitment/services/withdraw.ts`
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts`
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`
- Test: `src/modules/recruitment/services/withdraw.test.ts`

**Interfaces:**
- Consumes: `can(personId, permission)` from `@/platform/rbac/engine`; the module-local `bounce(cycleId, applicationId, opts)` helper in `actions.ts:16-23`.
- Produces: `export async function reopenWithdrawnApplication(applicationId: string, actorId: string): Promise<void>` and the server action `reopenWithdrawnAction(cycleId: string, applicationId: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/recruitment/services/withdraw.test.ts`:

```ts
import { reopenWithdrawnApplication } from "./withdraw";

it("reopens a withdrawn application back to SUBMITTED and clears the stamp", async () => {
  const { srr, app, cycle } = await seedCycle("w18", "reed@yale.edu");
  const manager = await personWithPermission("Morgan", "recruitment.manage_cycles");
  await withdrawApplication("w18", ID("reed@yale.edu"));

  await reopenWithdrawnApplication(app.id, manager.id);

  const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  expect(after.status).toBe("SUBMITTED");
  expect(after.withdrawnAt).toBeNull();
  expect(await listApplicantsForReview(cycle.id, srr.id)).toHaveLength(1);
});

it("refuses to reopen without recruitment.manage_cycles", async () => {
  const { app } = await seedCycle("w19", "reed@yale.edu");
  const nobody = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });
  await withdrawApplication("w19", ID("reed@yale.edu"));
  await expect(reopenWithdrawnApplication(app.id, nobody.id)).rejects.toBeInstanceOf(WithdrawError);
  expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).status).toBe("WITHDRAWN");
});

it("refuses to reopen an application that was never withdrawn", async () => {
  const { app } = await seedCycle("w20", "reed@yale.edu");
  const manager = await personWithPermission("Marley", "recruitment.manage_cycles");
  await expect(reopenWithdrawnApplication(app.id, manager.id)).rejects.toBeInstanceOf(WithdrawError);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- src/modules/recruitment/services/withdraw.test.ts`

Expected: FAIL, no exported member `reopenWithdrawnApplication`.

- [ ] **Step 3: Implement the service function**

In `src/modules/recruitment/services/withdraw.ts`, add the import:

```ts
import { can } from "@/platform/rbac/engine";
```

And the exported function:

```ts
/**
 * Undo a withdrawal. Staff-only: the applicant cannot reverse their own, so a
 * change of heart goes through a human and stays visible.
 *
 * Mirrors reopenDecision in routing.ts, but is narrower: it touches only status
 * and withdrawnAt. Acceptances, interviews, and contracts were never torn down
 * by the withdrawal, so there is nothing to rebuild.
 */
export async function reopenWithdrawnApplication(applicationId: string, actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) {
    throw new WithdrawError("You can't reopen withdrawn applications.");
  }
  const res = await prisma.application.updateMany({
    where: { id: applicationId, status: "WITHDRAWN" },
    data: { status: "SUBMITTED", withdrawnAt: null },
  });
  if (res.count !== 1) throw new WithdrawError("This application is not withdrawn.");

  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.application_withdraw_reopen",
    entityType: "Application",
    entityId: applicationId,
    before: { status: "WITHDRAWN" },
    after: { status: "SUBMITTED" },
  });
}
```

- [ ] **Step 4: Add the server action**

In `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts`, add the import:

```ts
import { reopenWithdrawnApplication, WithdrawError } from "@/modules/recruitment/services/withdraw";
```

And the action, next to `reopenDecisionAction`:

```ts
/** Undo an applicant's self-withdrawal. Gated on recruitment.manage_cycles in
 *  the service, so a reviewer without it gets the refusal message, not a crash. */
export async function reopenWithdrawnAction(cycleId: string, applicationId: string) {
  const person = await requirePersonSession();
  try {
    await reopenWithdrawnApplication(applicationId, person.personId);
  } catch (err) {
    if (err instanceof WithdrawError) {
      redirect(bounce(cycleId, applicationId, { error: err.message }));
    }
    throw err;
  }
  redirect(bounce(cycleId, applicationId, { saved: "reopened" }));
}
```

- [ ] **Step 5: Add the control to the applicant detail page**

In `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`, extend the existing action import on line 9 with `reopenWithdrawnAction`, then render a banner near the top of the page body (above the decision cards) that only appears for a withdrawn application:

```tsx
      {application.status === "WITHDRAWN" && (
        <Alert tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              This applicant withdrew themselves
              {application.withdrawnAt && <> on <DateTime value={application.withdrawnAt} /></>}. They are out of the
              review queue. Any acceptance or onboarding contract is untouched and still needs to be resolved
              separately.
            </span>
            {canManageCycles && (
              <form action={reopenWithdrawnAction.bind(null, id, applicationId)}>
                <ConfirmButton label="Reopen" confirmLabel="Reopen this application?" size="sm" />
              </form>
            )}
          </div>
        </Alert>
      )}
```

Read the top of the file first: it already resolves `id` and `applicationId` from params and loads the application. Confirm the local variable name for the loaded application (it may not be `application`) and for the manage-cycles permission flag (it may not be `canManageCycles`; the page already computes permission flags for its other controls). Reuse the existing names rather than introducing new ones, and add imports for `Alert` (`@/platform/ui/alert`), `ConfirmButton` (`@/platform/ui/confirm-button`), and `DateTime` (`@/platform/dates/display`) only if they are not already imported.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- src/modules/recruitment/services/withdraw.test.ts`

Expected: PASS, all twenty-one tests.

- [ ] **Step 7: Typecheck, lint, and commit**

```bash
npm run typecheck
npx eslint src e2e
git add src/modules/recruitment/services/withdraw.ts src/modules/recruitment/services/withdraw.test.ts "src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts" "src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx"
git commit -m "feat(recruitment): staff can reopen an applicant's self-withdrawal"
```

---

## Task 9: End-to-end pass

**Files:**
- Modify: `e2e/apply-portal.spec.ts`

**Interfaces:**
- Consumes: `applicantSessionCookie(email)` from `./portal-cookie`; `selectDepartments(page, codes)` from `./recruitment-helpers`.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Write the spec**

Append to `e2e/apply-portal.spec.ts`:

```ts
import { applicantSessionCookie } from "./portal-cookie";
import { selectDepartments } from "./recruitment-helpers";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("apply portal: an applicant can withdraw a submitted application", async ({ page, context }) => {
  await devLogin(page, "j.carney@yale.edu");

  // --- Build and publish a volunteer cycle ---
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Withdraw E2E");
  const slug = `withdraw-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await selectDepartments(page, ["SRHD"]);
  // Minimal identity-only form: the default form has required files and
  // subcommittee ranking, which the wizard loop below does not fill.
  await page.uncheck('input[name="seedDefaultForm"]');
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];

  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  // Anchor the badge match: a bare "OPEN" substring also matches "Opens".
  await expect(page.locator("span").filter({ hasText: /^OPEN$/ })).toBeVisible();

  // --- Submit as a verified portal applicant ---
  const applicantEmail = `e2e-withdraw-${Date.now()}@yale.edu`;
  const ctx = await context.browser()!.newContext();
  await ctx.addCookies([applicantSessionCookie(applicantEmail)]);
  const apply = await ctx.newPage();
  await apply.goto(`/apply/${slug}`);

  const submit = apply.getByRole("button", { name: "Submit application" });
  const continueBtn = apply.getByRole("button", { name: "Continue" });
  const firstNameField = apply.locator('input[name="first_name"]');
  for (let i = 0; i < 8; i++) {
    // Settle on the step before acting: a blind Continue click on the Review
    // step (where the button is already Submit) hangs the whole test.
    await expect(continueBtn.or(submit)).toBeVisible({ timeout: 45_000 });
    if (await submit.isVisible().catch(() => false)) break;
    if (await firstNameField.isVisible().catch(() => false)) {
      await firstNameField.fill("Wanda");
      await apply.fill('input[name="last_name"]', "Withdrawn");
      await apply.fill('input[name="email"]', applicantEmail);
    }
    await continueBtn.click();
  }
  await expect(submit).toBeVisible();
  await submit.click();
  await expect(apply.getByText(/your application was received/i)).toBeVisible();

  // --- Withdraw from the portal home ---
  await apply.goto("/apply");
  await expect(apply.getByText("Submitted")).toBeVisible();
  const withdrawBtn = apply.getByRole("button", { name: "Withdraw application" });
  await withdrawBtn.click(); // arms the two-click ConfirmButton
  await apply.getByRole("button", { name: /Withdraw\? We will stop considering you/ }).click();

  await expect(apply.getByText("Withdrawn")).toBeVisible();
  await expect(apply.getByRole("button", { name: "Withdraw application" })).toHaveCount(0);
  await ctx.close();

  // --- The applicant is gone from the review queue ---
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await expect(page.getByRole("link", { name: /Wanda/ })).toHaveCount(0);
});
```

Move the two new imports to the top of the file alongside the existing `import { expect, test } from "@playwright/test";` rather than leaving them mid-file.

- [ ] **Step 2: Run the spec**

Run: `npx playwright test e2e/apply-portal.spec.ts`

Expected: both tests PASS. Playwright starts the dev server per `playwright.config.ts`; the dev database must be running (`npm run db:up`) and seeded with the `SRHD` department, or `selectDepartments` will not find the option.

- [ ] **Step 3: Full verification sweep**

```bash
npm run typecheck
npx eslint src e2e
npm test
```

Expected: all clean. `npm test` runs the full unit and integration suite, which is what catches a regression in a surface this feature touched indirectly.

- [ ] **Step 4: Commit**

```bash
git add e2e/apply-portal.spec.ts
git commit -m "test(e2e): applicant withdraws a submitted application from the portal"
```

---

## Self-Review Notes

Checked against the spec. Every section maps to a task:

| Spec section | Task |
| --- | --- |
| Data model | 1 |
| Core rule: declares, does not tear down | 3 (asserted by the "leaves acceptances, contracts, and interviews untouched" test) |
| Drafts are deleted, not marked | 5 |
| Stage behavior table | 2 (eligibility) + 3 (write) + 4 (notification) |
| Notification | 4 |
| Surfaces needing explicit work | 7 |
| Staff-side undo | 8 |
| Portal UI | 2 + 6 |
| Authorization | 3 (`findOwnApplication`, plus the cross-applicant test in each of Tasks 3 and 5) |
| Concurrency | 3 (atomic claim, in-transaction promotion re-read, idempotency test) + 4 (single-notification test) |
| Testing | every task, plus 9 |

Two ambiguities the spec left open, resolved in Task 2 and flagged there:

- **`WAITLISTED`** keeps the withdraw control. Coming off a waitlist is a real intent, and the underlying status is `SUBMITTED`, so the service already permits it.
- **`NOT_SELECTED`** does not. The status is also `SUBMITTED` underneath, so the service would permit it, but offering "withdraw" to someone already told they were not selected is pointless. The suppression is in the eligibility table only, which is the right layer: it is a presentation judgment, not an invariant.
