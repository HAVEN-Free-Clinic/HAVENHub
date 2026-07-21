# Rescind an Emailed Acceptance Without an Interview: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an SRR a reachable "Rescind acceptance" control on the routed-decision applicant page, and make every error on that page appear next to the form that produced it.

**Architecture:** Two independent changes to one Next.js App Router page and its server-action file. The rescind control wraps the existing, already-tested `revokeAcceptance` service in a new server action that redirects back to the applicant page. The error work splits the page's single `?error=` query param into `error` / `routeError` / `scoreError` so each card renders only its own failure. No service-layer or schema changes.

**Tech Stack:** Next.js App Router (React Server Components, server actions), Prisma, Vitest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-21-rescind-acceptance-routed-decision-design.md`

**Branch:** `fix/rescind-acceptance-no-interview` (already created off `origin/main` at `6fbee1a6`, upstream deliberately unset).

## Global Constraints

- **No service-layer changes.** `revokeAcceptance` at `src/modules/recruitment/services/review.ts:195` already enforces every rule this feature needs. Do not relax line 210, 212, or 206.
- **Permission is SRR only.** The rescind button renders only under `scope.all`. A department director sees "Ask an SRR to rescind it first."
- **Copy is verbatim from the interview page** (`src/app/(app)/recruitment/interviews/[interviewId]/page.tsx:195-207`). Do not reword. The two rescind paths must read identically.
- **No em-dashes in any user-facing copy, comment, or commit message.** Use commas, colons, or semicolons.
- **Do not add an applicant-facing email.** Rescinding is silent by design; notifying the applicant stays a manual conversation.
- **Do not build onboarding-contract teardown.** If a contract exists, `revokeAcceptance` throws and the action surfaces its message. That dead end is deliberate and out of scope.
- **The DIRECTOR-track branch of the applicant page is untouched.** Only the VOLUNTEER branch changes.
- **Tests need the test database.** Run `npm run test:prepare` once per worktree before the first `vitest run`. This targets throwaway Postgres on port 5434, never Neon.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts` | Server actions for the applicant detail page | Add `rescindAcceptanceAction`; widen `bounce()`; reroute `routeAction` and `committeeScoreAction` error params |
| `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` | Applicant detail page (RSC) | Render the rescind control; move error alerts next to their forms |
| `src/app/(app)/recruitment/cycles/[id]/applicants/actions.test.ts` | Action-layer tests | Add a scoped director to `seed()`; add rescind tests; update the routeError assertion; add a scoreError test |

No new files. No test file for `page.tsx`: this codebase does not unit-test RSC page components, and the page changes are verified by typecheck, lint, and the action tests behind them.

---

### Task 1: `rescindAcceptanceAction` server action

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts` (import on line 7; new action appended after `reopenDecisionAction`, currently ending line 151)
- Test: `src/app/(app)/recruitment/cycles/[id]/applicants/actions.test.ts` (modify `seed()` at lines 29-41; append three tests)

**Interfaces:**
- Consumes: `revokeAcceptance(acceptanceId: string, actorId: string): Promise<void>` from `@/modules/recruitment/services/review`; the existing `bounce(cycleId, applicationId, opts?)` helper in this file.
- Produces: `rescindAcceptanceAction(cycleId: string, applicationId: string, acceptanceId: string): Promise<never>`. Always redirects, so it always throws `NEXT_REDIRECT` under the test mock. Task 2 binds all three arguments.

- [ ] **Step 1: Add a department-scoped director to the test seed**

`reviewScope` derives a director's departments from an ACTIVE `DIRECTOR` `TermMembership`, so the seed must capture the EDUC department row to link it. In `actions.test.ts`, replace `seed()` (lines 29-41) with:

```ts
async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const educ = await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  await prisma.department.create({ data: { code: "MDIC", name: "Medical" } });
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "SRR", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: lead.id, roleId: role.id } });
  // A director scoped to EDUC but WITHOUT review_all: reviewScope reads an ACTIVE
  // DIRECTOR TermMembership, so this person is in scope for the department yet
  // revokeAcceptance still refuses them once the acceptance has been emailed.
  const director = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: educ.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["EDUC", "MDIC"], createdById: lead.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email: "a@y.edu", emailLower: "a@y.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  vi.mocked(requirePersonSession).mockResolvedValue({ personId: lead.id } as never);
  return { lead, director, cycle, application };
}
```

Then add a shared helper directly below `seed()`, since all three new tests need the same emailed-acceptance state:

```ts
/** Route to EDUC, accept, and stamp the acceptance as emailed: the exact state
 *  that blocks both re-routing and a decision change. Returns the Acceptance row. */
async function seedEmailedAcceptance(applicationId: string, actorId: string) {
  await routeApplication(applicationId, "EDUC", actorId);
  await decideRoutedApplication(applicationId, "ACCEPT", actorId, null);
  await prisma.acceptance.updateMany({ where: { applicationId, departmentCode: "EDUC" }, data: { emailedAt: new Date() } });
  return prisma.acceptance.findFirstOrThrow({ where: { applicationId, departmentCode: "EDUC" } });
}
```

Update the import on line 18 to pull in only the actions this task uses. Do not add `committeeScoreAction` here; Task 3 adds it when it is first used, otherwise the unused import fails `npm run lint` at the end of Task 2:

```ts
import { routeAction, decideRoutedAction, rescindAcceptanceAction } from "./actions";
```

- [ ] **Step 2: Write the three failing tests**

Append to `actions.test.ts`:

```ts
it("lets an SRR rescind an emailed acceptance and redirects with saved=rescind", async () => {
  const { lead, cycle, application } = await seed();
  const acc = await seedEmailedAcceptance(application.id, lead.id);

  const err = await rescindAcceptanceAction(cycle.id, application.id, acc.id).catch((e) => e);
  expect(err.digest).toContain(`/recruitment/cycles/${cycle.id}/applicants/${application.id}?saved=rescind`);
  expect(await prisma.acceptance.findUnique({ where: { id: acc.id } })).toBeNull();
});

it("redirects a department director to an inline error rather than throwing", async () => {
  const { lead, director, cycle, application } = await seed();
  const acc = await seedEmailedAcceptance(application.id, lead.id);
  // Swap the session to the EDUC director: in scope for the department, but no
  // review_all, so revokeAcceptance refuses an already-emailed acceptance.
  vi.mocked(requirePersonSession).mockResolvedValue({ personId: director.id } as never);

  const err = await rescindAcceptanceAction(cycle.id, application.id, acc.id).catch((e) => e);
  expect(err.digest).toContain(`/recruitment/cycles/${cycle.id}/applicants/${application.id}?error=`);
  expect(decodeURIComponent(err.digest)).toContain("already notified");
  // The acceptance survives an unauthorized attempt.
  expect(await prisma.acceptance.findUnique({ where: { id: acc.id } })).not.toBeNull();
});

it("unblocks the decision change: REJECT is refused before the rescind and recorded after it", async () => {
  const { lead, cycle, application } = await seed();
  const acc = await seedEmailedAcceptance(application.id, lead.id);

  const blocked = await decideRoutedAction(cycle.id, application.id, form({ outcome: "REJECT" })).catch((e) => e);
  expect(decodeURIComponent(blocked.digest)).toContain("Rescind the acceptance before changing this decision");

  await rescindAcceptanceAction(cycle.id, application.id, acc.id).catch(() => {});

  const ok = await decideRoutedAction(cycle.id, application.id, form({ outcome: "REJECT" })).catch((e) => e);
  expect(ok.digest).toContain(`/recruitment/cycles/${cycle.id}/applicants/${application.id}?saved=decision`);
  const app = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
  expect(app.decision).toBe("REJECT");
});
```

The third test is the one that matters: it proves the dead end described in the spec is actually gone, not merely that a button exists.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm run test:prepare   # once per worktree
npx vitest run "src/app/(app)/recruitment/cycles/[id]/applicants/actions.test.ts"
```

Expected: the three new tests FAIL. The import of `rescindAcceptanceAction` is unresolved, so expect a module or type error naming `rescindAcceptanceAction`, not an assertion diff. The pre-existing re-routing test still passes.

- [ ] **Step 4: Implement the action**

In `actions.ts`, extend the review import on line 7 to include `revokeAcceptance`:

```ts
import { RecruitmentAuthError, AcceptanceError, revokeAcceptance } from "@/modules/recruitment/services/review";
```

Append after `reopenDecisionAction`:

```ts
// Rescind a notified acceptance from the applicant detail page. A routed decision
// taken without an interview has no interview screen, so before this existed the
// "rescind the acceptance first" guards pointed at a control the reviewer could not
// reach from anywhere in the app. revokeAcceptance self-authorizes: only review_all
// may delete an emailed acceptance, and an existing onboarding contract blocks it
// outright (deleting would cascade away signatures, DOB, and the HIPAA cert).
export async function rescindAcceptanceAction(cycleId: string, applicationId: string, acceptanceId: string) {
  const person = await requirePersonSession();
  try {
    await revokeAcceptance(acceptanceId, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof AcceptanceError) {
      redirect(bounce(cycleId, applicationId, { error: (err as Error).message }));
    }
    throw err;
  }
  redirect(bounce(cycleId, applicationId, { saved: "rescind" }));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run "src/app/(app)/recruitment/cycles/[id]/applicants/actions.test.ts"
```

Expected: PASS, 4 tests (3 new plus the pre-existing re-routing test).

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts" "src/app/(app)/recruitment/cycles/[id]/applicants/actions.test.ts"
git commit -m "fix(recruitment): add a rescind action for acceptances decided without an interview"
```

---

### Task 2: Rescind control on the applicant page

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` (imports at lines 8 and 19-21; warning block at lines 282-286; saved alerts at lines 259-260)

**Interfaces:**
- Consumes: `rescindAcceptanceAction(cycleId, applicationId, acceptanceId)` from Task 1; `emailedAcceptance` already computed at page lines 62-64, which is a full Prisma `Acceptance` row and therefore carries `.id`.
- Produces: no exports. This is the last piece that makes Task 1 reachable.

- [ ] **Step 1: Add the imports**

Extend the actions import on line 8:

```tsx
import { scheduleInterviewAction, committeeScoreAction, routeAction, decideRoutedAction, reopenDecisionAction, rescindAcceptanceAction } from "../actions";
```

Add the `ConfirmButton` import beside the other `@/platform/ui` imports (after line 19):

```tsx
import { ConfirmButton } from "@/platform/ui/confirm-button";
```

- [ ] **Step 2: Add the rescind success alert**

Directly below the `saved === "reopened"` alert (line 260), add:

```tsx
{saved === "rescind" && <Alert tone="success" className="mt-3">Acceptance rescinded.</Alert>}
```

- [ ] **Step 3: Replace the dead-end warning with the warning plus control**

Replace lines 282-286 (the `{emailedAcceptance && (...)}` block) with a copy of the interview page's block, adapted only in its bound arguments:

```tsx
{emailedAcceptance && (
  <div className="mt-3 space-y-3">
    <Alert tone="warning">
      This applicant has already been emailed their acceptance for {app.routedDepartmentCode}. Changing to Reject or Waitlist is blocked until the acceptance is rescinded.{" "}
      {scope.all ? "Rescind it below, then record the new decision." : "Ask an SRR to rescind it first."}
    </Alert>
    {scope.all && (
      <form action={rescindAcceptanceAction.bind(null, id, applicationId, emailedAcceptance.id)}>
        <ConfirmButton label="Rescind acceptance" size="sm" />
      </form>
    )}
  </div>
)}
```

The copy is intentionally identical to `interviews/[interviewId]/page.tsx:197-205` so the two rescind paths cannot drift in wording.

- [ ] **Step 4: Verify it compiles and lints**

```bash
npm run typecheck
npm run lint
```

Expected: both exit 0. If `ConfirmButton` reports a missing prop, check its signature at `src/platform/ui/confirm-button.tsx` and match the interview page's usage exactly rather than inventing props.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx"
git commit -m "fix(recruitment): let an SRR rescind an acceptance from the applicant page"
```

---

### Task 3: Per-card error routing

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts` (`bounce()` at lines 13-18; `committeeScoreAction` at lines 24-38; `routeAction` catch at lines 59-61)
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` (searchParams type on line 26; destructure on line 28; score card ~line 173; routing card ~line 206; decision card lines 258, 263-273, 287)
- Test: `src/app/(app)/recruitment/cycles/[id]/applicants/actions.test.ts` (update the assertion at line 54; append one test)

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `bounce()` gains optional `routeError` and `scoreError` keys alongside `error` and `saved`. Precedence order is `error`, `routeError`, `scoreError`, `saved`; only one is ever set per call.

**Why the action and page changes are one task:** renaming the param without adding the matching alert would make `routeAction` failures vanish from the UI entirely. Splitting this task would ship a user-visible regression at the boundary.

- [ ] **Step 1: Update the existing routeError assertion and add the scoreError test**

First extend the actions import on line 18, which this task's new test needs:

```ts
import { routeAction, decideRoutedAction, committeeScoreAction, rescindAcceptanceAction } from "./actions";
```

Then change line 54 from `?error=` to `?routeError=`:

```ts
  expect(err.digest).toContain(`/recruitment/cycles/${cycle.id}/applicants/${application.id}?routeError=`);
```

Append a new test. It uses the early validation branch, so no service failure needs staging:

```ts
it("sends a committee-score failure to scoreError so it renders in the score card", async () => {
  const { cycle, application } = await seed();

  const err = await committeeScoreAction(cycle.id, application.id, form({ score: "9" })).catch((e) => e);
  expect(err.digest).toContain(`/recruitment/cycles/${cycle.id}/applicants/${application.id}?scoreError=`);
  expect(decodeURIComponent(err.digest)).toContain("Score must be 1 to 5.");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run "src/app/(app)/recruitment/cycles/[id]/applicants/actions.test.ts"
```

Expected: 2 FAIL. The re-routing test fails asserting `?routeError=` against a digest containing `?error=`; the new score test fails the same way. The three Task 1 tests still pass.

- [ ] **Step 3: Widen `bounce()`**

Replace lines 13-18 of `actions.ts`:

```ts
// Each form on the applicant page carries its own error param so a failure renders
// in the card that produced it. A single shared `error` used to dump routing and
// scoring failures into the Department decision card, far from the button clicked.
function bounce(cycleId: string, applicationId: string, opts?: { error?: string; routeError?: string; scoreError?: string; saved?: string }) {
  const base = `/recruitment/cycles/${cycleId}/applicants/${applicationId}`;
  if (opts?.error) return `${base}?error=${encodeURIComponent(opts.error)}`;
  if (opts?.routeError) return `${base}?routeError=${encodeURIComponent(opts.routeError)}`;
  if (opts?.scoreError) return `${base}?scoreError=${encodeURIComponent(opts.scoreError)}`;
  if (opts?.saved) return `${base}?saved=${encodeURIComponent(opts.saved)}`;
  return base;
}
```

- [ ] **Step 4: Point the two actions at their own params**

In `committeeScoreAction`, change both the early validation redirect (line 25) and the catch (line 36):

```ts
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    redirect(bounce(cycleId, applicationId, { scoreError: "Score must be 1 to 5." }));
  }
```

```ts
    if (err instanceof RecruitmentAuthError || err instanceof CommitteeScoreError) redirect(bounce(cycleId, applicationId, { scoreError: err.message }));
```

In `routeAction`, change the catch (line 60):

```ts
      redirect(bounce(cycleId, applicationId, { routeError: err.message }));
```

Leave `decideRoutedAction`, `reopenDecisionAction`, and `scheduleInterviewAction` on `error`. They already render in the correct card.

- [ ] **Step 5: Run the action tests to verify they pass**

```bash
npx vitest run "src/app/(app)/recruitment/cycles/[id]/applicants/actions.test.ts"
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Read the new params on the page**

In `page.tsx`, widen the searchParams type on line 26:

```tsx
export default async function ApplicationDetailPage({ params, searchParams }: { params: Promise<{ id: string; applicationId: string }>; searchParams: Promise<{ error?: string; routeError?: string; scoreError?: string; saved?: string }> }) {
```

And the destructure on line 28:

```tsx
  const { error, routeError, scoreError, saved } = await searchParams;
```

- [ ] **Step 7: Render each error above its own form**

In the Committee score card, inside the `{canScore && (` block and immediately above `<form action={committeeScoreAction...}>` (line 174):

```tsx
          {scoreError && <Alert tone="error" className="mt-3">{scoreError}</Alert>}
```

In the Routing card, immediately above `<form action={routeAction...}>` (line 207):

```tsx
          {routeError && <Alert tone="error" className="mt-3">{routeError}</Alert>}
```

In the Department decision card, delete the card-top alert on line 258:

```tsx
          {error && <Alert tone="error" className="mt-3">{error}</Alert>}
```

Then place it next to each control instead. In the not-routed-and-decided branch, between the summary paragraph and the Reopen form (after line 267):

```tsx
                {error && <Alert tone="error">{error}</Alert>}
```

And in the `canDecideRouted` branch, immediately above `<form action={decideRoutedAction...}>` (line 287):

```tsx
              {error && <Alert tone="error" className="mt-3">{error}</Alert>}
```

Leave the DIRECTOR branch's alert on line 228 exactly as it is. `scheduleInterviewAction` is its only error producer and already renders in the right card.

The decision card's third branch, "Routed to X. Waiting on the department to decide.", deliberately gets no alert. Reaching it means `canDecideRouted` is false, so the viewer is neither SRR nor the routed department's director and therefore cannot invoke `decideRoutedAction` or `reopenDecisionAction` at all. No `error` can orphan there. This is a reasoned omission, not a missed case.

- [ ] **Step 8: Verify the page compiles and lints**

```bash
npm run typecheck
npm run lint
```

Expected: both exit 0.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts" "src/app/(app)/recruitment/cycles/[id]/applicants/actions.test.ts" "src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx"
git commit -m "fix(recruitment): report routing and scoring errors in their own cards"
```

---

### Task 4: Full verification before push

**Files:** none modified. This task only runs checks and reports honestly.

- [ ] **Step 1: Run the recruitment service tests**

The rescind path leans entirely on `revokeAcceptance`, so confirm its existing coverage still passes untouched:

```bash
npx vitest run src/modules/recruitment/services/review.test.ts src/modules/recruitment/services/routing.test.ts
```

Expected: PASS. If anything here fails, the change broke a service contract and Tasks 1-3 need revisiting, since neither task was supposed to alter service behavior.

- [ ] **Step 2: Run the full unit suite**

```bash
npm run test
```

Expected: PASS. A stale Prisma client is the usual cause of spurious failures here; if the errors mention unknown fields, regenerate with `npx prisma generate` and rerun before assuming a real break.

- [ ] **Step 3: Typecheck and lint the whole repo**

```bash
npm run typecheck
npm run lint
```

Expected: both exit 0. Run `npm run lint` across the whole repo, not just changed files: the ESLint boundary rules do not surface under typecheck or the test suite.

- [ ] **Step 4: Report results honestly**

State the actual command output. If a check fails, say so and show it rather than describing the work as complete. Do not claim the Playwright e2e suite passes: it runs comprehensively in CI and cannot run locally against this worktree. The rescind button is additive and the error changes are query-string only, so exposure reads as low, but that is an expectation, not a verified result.

- [ ] **Step 5: Push and open a PR**

Only after every check above passes, and only when the user asks for it:

```bash
git push -u origin HEAD
```

The branch's upstream was deliberately unset when it was created off `origin/main`, so `-u origin HEAD` is required. A bare `git push` would otherwise have targeted main.

---

## Manual verification checklist

Automated tests cover the actions; these confirm the page renders as intended. Run against a local dev server with an applicant in the blocked state (VOLUNTEER cycle, routed, ACCEPT decided, acceptance emailed).

- [ ] As an SRR, the Department decision card shows the warning plus a "Rescind acceptance" button that asks for confirmation.
- [ ] Clicking it succeeds and the page returns with "Acceptance rescinded."
- [ ] Recording Reject afterwards now succeeds instead of erroring.
- [ ] As a director scoped to the routed department, the warning ends "Ask an SRR to rescind it first." and no button renders.
- [ ] Clicking Route with a blocked re-route shows the error inside the Routing card, next to the Route button.
- [ ] A blocked decision change shows its error directly above the Outcome dropdown, not at the top of the card.
- [ ] For an applicant who has started onboarding, the rescind attempt reports "Remove the onboarding contract before revoking the acceptance." This dead end is expected and out of scope.
