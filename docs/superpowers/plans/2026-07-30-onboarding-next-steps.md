# Onboarding Next Steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell a newly onboarded volunteer what happens next and how to get into the app, and make revisiting the onboarding link a confirmation rather than an error.

**Architecture:** One shared next-steps content module feeding three consumers: the completion screen, the revisit page, and a per-cycle confirmation email. No change to what the contract collects or how acceptances are recorded.

**Tech Stack:** Next.js App Router, Prisma, Vitest, the recruitment cycle-email system.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-30-onboarding-next-steps-design.md`. Read it before Task 1, including its dated correction about which email pattern to use.
- Source finding: PR #474, item **R4** (F-04-3 + F-04-11 merged), ranked 4th of 88, tier 1.
- **No em-dashes anywhere, in prose or code.** CI enforces this via the `local/no-em-dash` eslint rule.
- **This is copy a volunteer reads once, at the moment they need it.** Every string is drafted to be edited in review. Do not invent Epic instructions, timelines, or claims about what directors do next. State only what the code and the cycle's stored fields support.
- **Write the next-steps content once.** Three consumers need it. The previous branch in this series spent two review rounds fixing drift on a sentence with only two consumers.
- `ContractStatus` is `PENDING | SUBMITTED | PROMOTED`. `OnboardingContract` carries `email` and `firstName` directly (`prisma/schema.prisma:1413-1416`).
- Lint with `npx eslint src`. Plain `npm run lint` walks a gitignored design-system directory and produces noise. Run `npm run typecheck` before each commit.
- `main` carries 7 pre-existing storage and blob-cleanup test flakes. They are not yours.

## File structure

- Create: a next-steps content module under `src/modules/recruitment/` (exact path per Task 1)
- Modify: `src/app/onboard/[token]/onboard-form.tsx:87` (the completion screen)
- Modify: `src/app/onboard/[token]/page.tsx:15` (the revisit branch)
- Modify: `src/modules/recruitment/email/render.ts:9-14` (`CYCLE_EMAIL_KEYS`) and wherever its defaults live
- Modify: `src/modules/recruitment/services/onboarding.ts` (queue the email in `submitContract`)

---

### Task 1: The shared next-steps content

**Files:**
- Create: the content module
- Test: alongside it

**Interfaces:**
- Produces: a function returning the next-steps content from the data the callers have. Tasks 2, 3, and 4 all consume it. Decide its shape and say why: returning structured data that each surface renders lets the email be text and the screens be JSX, whereas returning JSX forces the email to duplicate it.

- [ ] **Step 1: Decide the shape and the home**

The three consumers are a React server component (the revisit page), a React client component (the completion screen inside `onboard-form.tsx`), and an email body. **JSX cannot cross into the email.** Structured data that each surface renders is the shape most likely to work; confirm that before building, and state your reasoning.

Put it under `src/modules/recruitment/`. `src/app/onboard/[token]/training-date.ts` is a precedent for small route-local helpers, but this one is consumed by the service layer too, so a module path is likely better. Pick one and justify it.

- [ ] **Step 2: Assemble the content**

At minimum:

- **How to sign in, branched on email domain.** A Yale address gets "Sign in with your Yale NetID"; anything else gets "We will email you a sign-in link." This is not cosmetic: Yale addresses must use SSO and non-Yale members use an emailed magic link, so a generic "sign in here" is wrong for half the population. `OnboardingContract.email` is the address.
- **The in-person training date and location.** Already resolved server-side at `src/app/onboard/[token]/page.tsx:89-90` via `formatTrainingDate` and `formatTrainingLocation`. **Handle the null cases:** `training-date.ts:7` returns the literal string "the scheduled training date" when no date is set, and the location formatter returns an empty string.
- **The Epic directions the form promised.** The contract's Epic block says "We will set up your Epic account. Directions follow after you submit this form." Deliver whatever the code actually supports. If the codebase has no Epic directions to give, **say so in your report rather than inventing them**, and leave a placeholder for Jack. Inventing instructions for a hospital records system is worse than admitting there are none.
- **What happens next on the director's side**, only to the extent the code supports a claim.

- [ ] **Step 3: Test the branches**

```
- a yale.edu address produces the SSO sign-in line
- a non-yale address produces the emailed-link line
- a cycle with no training date and no location still produces sensible content
```

- [ ] **Step 4: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "feat(recruitment): add shared onboarding next-steps content"
```

---

### Task 2: Replace the completion dead end

**Files:**
- Modify: `src/app/onboard/[token]/onboard-form.tsx:87`

**Interfaces:**
- Consumes: Task 1's content module.

Current state is one line:

```tsx
if (result?.ok) {
  return <Alert tone="success" className="mt-8">Thanks, your onboarding is complete. We will be in touch with next steps.</Alert>;
}
```

Zero links, zero buttons, on the last screen before someone is expected to show up to a clinic shift.

- [ ] **Step 1: Render the next-steps screen**

Replace the bare `Alert` with a screen carrying Task 1's content. Keep a success acknowledgement; the problem is that the acknowledgement is *all* there is.

`onboard-form.tsx` is a client component. Whatever Task 1 produces must already be in its props: check what `ctx` already carries (`page.tsx:100-106` passes `firstName`, `orgName`, `trainingDate`, `trainingLocation`, `department`, `track`, `epicRequirement`, `storedEpicId`) and thread anything missing from the server page rather than importing server-only code into the client.

- [ ] **Step 2: Verify in a browser**

Environment: `.env.local` does not exist in this worktree. Copy it from `/Users/jcarney/Documents/Code-Projects/HAVENHub/.claude/worktrees/fix+hipaa-verification-wait/.env.local`, which points at `havenhub_uxaudit` on localhost:5434. It is gitignored; never commit it.

**The `ux.accepted@yale.edu` fixture's contract was consumed by an earlier audit walk and is now SUBMITTED.** A `PENDING` contract is needed to walk the submission. Re-running `npm run fixtures:ux` will NOT restore it: the script reuses any existing contract regardless of status. Reset the row's status to `PENDING`, or create a fresh contract, and say which you did.

Start your own dev server with `run_in_background: true`; it dies with your session, which is fine. Use Playwright MCP; the Chrome extension is not connected.

Confirm the completion screen renders actionable content, and check the sign-in line for both a Yale and a non-Yale address.

- [ ] **Step 3: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "fix(onboarding): replace the completion dead end with next steps"
```

---

### Task 3: Make revisiting the link a confirmation

**Files:**
- Modify: `src/app/onboard/[token]/page.tsx:15`

**Interfaces:**
- Consumes: Task 1's content module.

Current state:

```tsx
if (!contract || contract.status !== "PENDING") { ...renders "This onboarding form is not available"... }
```

So a volunteer who bookmarked the link, or reopens the email to check what they signed, reads a failure and is told to contact IT about their own success.

- [ ] **Step 1: Branch on status**

- `SUBMITTED` and `PROMOTED`: a confirmation ("You completed this on {date}") plus Task 1's content.
- No contract, or an expired token: keep the existing error.

**Check what `PROMOTED` means before assuming the same content is correct for it.** It likely means the contract has been converted into a Person or membership, in which case some next-steps copy ("we will email you a sign-in link") may already be stale. If it differs materially, branch it and say why.

The submitted date is on the contract row; verify the field name rather than guessing.

- [ ] **Step 2: Test the branches**

```
- a SUBMITTED contract renders the confirmation, not the error
- an unknown token still renders the error
- an expired PENDING token still renders the error
```

- [ ] **Step 3: Verify in a browser**

Reopen a submitted contract's link and confirm it reads as a confirmation.

- [ ] **Step 4: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "fix(onboarding): a completed link reads as a confirmation, not a failure"
```

---

### Task 4: Queue the confirmation email

**Files:**
- Modify: `src/modules/recruitment/email/render.ts:9-14` and the defaults it resolves
- Modify: `src/modules/recruitment/services/onboarding.ts` (`submitContract`, from `:285`)
- Test: `src/modules/recruitment/services/onboarding.test.ts`

**Interfaces:**
- Consumes: Task 1's content module.

**Use the cycle-email pattern, not the platform one.** The spec carries a dated correction explaining why. `onboarding.ts:186-196` already sends the onboarding link via `renderCycleEmail(cycle.id, "recruitment.onboarding", ...)` then `queueEmail`. Follow that. Do NOT add a `NOTIFICATION_TYPES` entry or use `notify()`.

- [ ] **Step 1: Add the cycle-email key**

Add a key to `CYCLE_EMAIL_KEYS` (`src/modules/recruitment/email/render.ts:9-14`) with a default subject and body, alongside `recruitment.acceptance`, `recruitment.interview_invite`, and `recruitment.onboarding`. Read how those defaults are stored and resolved before adding yours.

The template engine supports only `{{#if}}`, `{{var}}`, and `{{{raw}}}`. **It does NOT support `{{#each}}`.** If the next-steps content is a list, precompute it into a string rather than reaching for a loop.

- [ ] **Step 2: Queue it in submitContract**

`submitContract` starts at `onboarding.ts:285` and already guards `status !== "PENDING"` at `:291`, so it cannot run twice for one contract. Queue the email after the contract is durably submitted.

**Failure isolation:** the contract is already saved and audited by then. A mail failure must not surface to the volunteer as a failed submission. Wrap in try/catch, log, continue, exactly as `saveCertificate` wraps its manager alerts in `src/modules/my-info/services/my-info.ts`.

- [ ] **Step 3: Test**

```
- submitContract queues exactly one confirmation email
- a second submit does not queue another (the PENDING guard should make this impossible; prove it)
- a mail failure does not fail the submission
```

Read `onboarding.test.ts` for its fixture conventions first. The HIPAA branch's equivalent double-send test caught a real risk, so do not skip the second case even though the status guard looks sufficient.

- [ ] **Step 4: Run the recruitment suites**

```bash
npx vitest run src/modules/recruitment src/app/onboard
```

If a test asserts the length of `CYCLE_EMAIL_KEYS` or enumerates its members, update it rather than loosening it.

- [ ] **Step 5: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "feat(recruitment): confirm onboarding completion by email"
```

---

## Self-review notes

**Spec coverage.** The spec's "one content module, three consumers" maps to Task 1; section 1 to Task 2; section 3 to Task 3; section 2, including its dated correction on the email pattern, to Task 4. The spec's testing list is distributed across Tasks 1, 3, and 4, and its failure-isolation requirement is Task 4 Step 2.

**Ordering.** Task 1 first so no consumer invents its own copy. Tasks 2, 3, and 4 are independent of each other and could be done in any order after it.

**Three steps hand a decision to the implementer**, each with the information to settle it: Task 1 Step 1 (the content's shape, constrained by the fact that JSX cannot reach the email), Task 1 Step 2 (whether the codebase has real Epic directions, with explicit permission to report their absence rather than invent them), and Task 3 Step 1 (whether `PROMOTED` needs different copy from `SUBMITTED`).

**A known fixture trap is called out in Task 2 Step 2.** The `ux.accepted@yale.edu` contract is already SUBMITTED and the fixture script will not restore it, because it reuses any existing contract regardless of status. That cost a downstream task time on an earlier branch.

**Not covered: the applicant portal's "Onboarding in progress" card.** It is a related gap named in the audit, but a different surface, and the spec scopes it out.
