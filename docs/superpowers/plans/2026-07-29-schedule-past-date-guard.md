# Schedule Past-Date Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop offering, accepting, and approving schedule change requests for clinic dates that have already happened, and make a stale queued request visible to the director who has to dispose of it.

**Architecture:** One shared display-zone today-key, then three server guards in `requests.ts` and two display changes. The server guards are the substance; the display changes stop users meeting an error they could not have predicted.

**Tech Stack:** Next.js App Router, Prisma, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-schedule-past-date-guard-design.md`. Read it before Task 1.
- Source findings: PR #474, items **R3** (F-07-4 + F-07-5) and **R58** (F-09-1).
- **No em-dashes anywhere, in prose or code.** CI enforces this via the `local/no-em-dash` eslint rule.
- **The boundary is `>=`. Today counts as valid, not past.** A volunteer asking for a swap on the morning of a clinic day is a real case. Off by one in either direction is a defect and both directions get a test.
- **Never compute the day with a raw `isoDateKey(new Date())`.** That is a UTC key that rolls over around 8pm Eastern, so during the last hours of a clinic day it yields tomorrow. `src/modules/schedule/services/builder.ts:760-766` documents this. Task 1 extracts that implementation; every later task uses the extraction.
- `planApply` is not touched. This changes what is allowed, not how a valid swap is applied.
- Lint with `npx eslint src`. Plain `npm run lint` walks a gitignored design-system directory and produces noise. Run `npm run typecheck` before each commit.
- `main` carries 7 to 8 pre-existing storage and ordering test flakes (disk writes, blob cleanup). They are not yours. Compare against `main` before assuming you broke something.

## File structure

- Modify: `src/platform/dates/` (the shared today-key; exact file per Task 1 Step 1)
- Modify: `src/modules/schedule/services/builder.ts:760-766` (call the extraction)
- Modify: `src/modules/schedule/services/requests.ts` (three guards)
- Modify: `src/app/(app)/schedule/page.tsx` (past-shift card)
- Modify: `src/modules/schedule/components/pending-requests.tsx` (stale row)

---

### Task 1: Extract the display-zone today-key

**Files:**
- Modify: a file under `src/platform/dates/` (choose per Step 1)
- Modify: `src/modules/schedule/services/builder.ts:760-766`
- Test: alongside the chosen file's existing test

**Interfaces:**
- Produces: an async function returning the display-zone calendar day as a `YYYY-MM-DD` key. Tasks 2 and 3 both consume it. Name it for what it means, for example `displayTodayKey`.

- [ ] **Step 1: Choose where it lives**

`src/platform/dates/` contains `logic.ts` (pure, `isoDateKey` lives here), `format.ts` (`formatForDateInput`), `resolve.ts` (`getDisplayTimeZone`), and `zone.ts`.

The function needs `formatForDateInput` and `getDisplayTimeZone`, so it cannot go in `logic.ts` without giving that pure module a settings dependency. Read the four files and pick the home that does not introduce a new dependency direction. State your choice and why. If none fits cleanly, a new small module is acceptable; say so.

Check `src/platform/dates/index.ts` to see whether the module has a public surface you should export through.

- [ ] **Step 2: Write the failing test**

The behavior that matters is the one the `builder.ts` comment warns about: a late-evening Eastern instant must still yield **that** Eastern day, not the next UTC day.

Read the existing tests in the chosen file's test module for how they handle zones and fixed clocks. `zone.test.ts` and `format.test.ts` both exist; follow whichever convention fits. Do not invent a new clock-mocking approach if one is already used.

Assert at minimum:

```
- a mid-afternoon Eastern instant yields that Eastern calendar day
- a 9pm Eastern instant (which is the next day in UTC) still yields the Eastern day
```

That second case is the entire reason this function exists.

- [ ] **Step 3: Run it and watch it fail**

Run the focused test file. Expected: failure naming the missing export.

- [ ] **Step 4: Implement it**

Move the implementation from `builder.ts:764-766`, and **move the comment with it**. The comment is the reason the function exists; leaving it behind in `builder.ts` would strand the rationale away from the code.

- [ ] **Step 5: Have builder.ts call the extraction**

Replace the inline computation in `builder.ts` with a call. Behavior must be identical; this is a pure refactor. Confirm `currentClinicDateKey` still resolves the same way.

- [ ] **Step 6: Run the schedule suite**

```bash
npx vitest run src/modules/schedule src/platform/dates
```

Expected: green. `builder.test.ts` exercises `currentClinicDateKey`; if it fails, the refactor changed behavior and that must be understood, not worked around.

- [ ] **Step 7: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "refactor(dates): extract the display-zone today key"
```

---

### Task 2: Close the three server guards

**Files:**
- Modify: `src/modules/schedule/services/requests.ts`
- Test: `src/modules/schedule/services/requests.test.ts`

**Interfaces:**
- Consumes: the today-key from Task 1.
- Produces: nothing later tasks import. Task 3 relies on these guards existing so its display changes are honest rather than cosmetic.

`RequestValidationError` already exists at `requests.ts:50`.

- [ ] **Step 1: Write the failing tests first**

Read `requests.test.ts` for its fixture conventions before writing anything: how it builds a term with clinic dates, a department, memberships, and assignments. Clinic dates are anchored at 12:00 UTC so they read as the intended Saturday in any US zone.

**A term whose clinic dates are all in the past or all in the future will not exercise the boundary.** Your fixture needs dates straddling today. Note the seeded term SU26 runs 2026-05-30 to 2026-09-26, so relative to a current date inside that range some Saturdays are past and some are future; check what the existing fixtures do and whether they hardcode dates.

Cover:

```
eligibleSwapPartners
- excludes a partner whose only free date is in the past
- includes a partner whose only free date is today            <- the >= boundary
- still includes a partner whose free date is in the future

createRequest
- throws RequestValidationError for a past requesterDateKey
- throws RequestValidationError for a past targetDateKey
- still accepts a valid future pair

approveRequest
- refuses a request whose requesterDate has passed
- refuses a request whose targetDate has passed
- still approves a valid one
- denying a stale request still works                          <- the escape hatch
```

That last one is not optional. The whole design depends on Deny remaining available for requests the guard makes unapprovable.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/modules/schedule/services/requests.test.ts`
Expected: the new cases fail; the existing suite still passes.

- [ ] **Step 3: Guard eligibleSwapPartners**

Add `isoDateKey(p.clinicDate) >= todayKey` to the existing `.filter()` (around `requests.ts:1090`, alongside the `activeMemberIds` and `actorBusyDateKeys` checks). Follow the surrounding comment style; that filter already documents why each clause exists.

The `swapPartners.length === 0` branch already renders "No eligible swap partners for this shift.", so the honest empty state needs no new code. It was simply unreachable.

- [ ] **Step 4: Guard createRequest**

The canonical clinic-date lookups are at `requests.ts:330-346`: `canonicalRequesterDate` and `canonicalTargetDate`, each throwing `RequestValidationError` when the key is not a clinic date for the term.

Add the past-date check immediately after those, so a date is proven to be a real clinic date before being judged past. Throw `RequestValidationError("That clinic date has already passed.")` for either a past requester key or a past target key.

- [ ] **Step 5: Guard approveRequest**

`approveRequest` checks `req.status !== "PENDING"` at `requests.ts:666-668`, then builds schedule rows and derives `requesterDateKey` / `targetDateKey` at `:672-673`.

Add the precondition after the derivation and before `validateRequest`, so the message is about the date rather than a downstream validation failure.

**The message must tell the director what to do instead**, because Deny is the correct disposition and Approve is now permanently unavailable for a stale request:

```
"This request is for a clinic date that has already passed. Deny it instead."
```

Do NOT add a guard to the deny path. Deny must keep working; a test in Step 1 covers it.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/modules/schedule`
Expected: green, including the pre-existing suite.

- [ ] **Step 7: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "fix(schedule): refuse change requests for clinic dates that have passed"
```

---

### Task 3: Say so on the card and in the approval queue

**Files:**
- Modify: `src/app/(app)/schedule/page.tsx` (around `:279` and the disclosure at `:326`)
- Modify: `src/modules/schedule/components/pending-requests.tsx`

**Interfaces:**
- Consumes: the today-key from Task 1, and relies on Task 2's guards so these changes are honest rather than decorative.

- [ ] **Step 1: The volunteer's card**

`src/app/(app)/schedule/page.tsx:279` already computes `const dateKey = isoDateKey(shift.clinicDate)` per shift. Compute `isPast` alongside it using the shared today-key, resolved once for the page rather than per shift.

Replace the `<details>` disclosure at `:326` with a muted "This shift has passed." line when `isPast`. Leave the disclosure exactly as-is otherwise.

Do not remove the pending-request display for a past shift. A volunteer who already filed one needs to keep seeing its state.

- [ ] **Step 2: The director's queue**

`src/modules/schedule/components/pending-requests.tsx` renders `requesterDateLabel` as a bare `displayDate(...)` with no past or future framing, and the Approve and Deny controls identically regardless of date.

Compare the request's dates to the shared today-key. For a stale request:

- render a clear marker on the row, so it is distinguishable at a glance rather than by reading dates
- make Approve unavailable, since Task 2's guard will refuse it anyway

A director must not click Approve, receive an error, and have to work out why. Deny must remain available and obvious; it is the correct disposition.

Note this component is a client component; the today-key resolution is async and server-side, so it needs to arrive as a prop. Check how the component is mounted at `src/app/(app)/schedule/builder/page.tsx:991-997` and thread it from there. Report how you did it.

- [ ] **Step 3: Verify in a browser**

Environment: `.env.local` does not exist in this worktree. Copy it from `/Users/jcarney/Documents/Code-Projects/HAVENHub/.claude/worktrees/fix+hipaa-verification-wait/.env.local`, which points at `havenhub_uxaudit` on localhost:5434. It is gitignored; never commit it.

`dev.volunteer@yale.edu` has five published shifts across SU26, some past and some future relative to today, which is exactly the state this fix is about. The audit also left two CANCELLED `ShiftRequest` rows in that database, so the "Recent decisions" panel will have content.

Start your own dev server with `run_in_background: true`; it dies with your session, which is fine. Use Playwright MCP; the Chrome extension is not connected.

Confirm: a past shift card shows "This shift has passed." with no disclosure; a future shift card still offers the full change form; and a future shift's swap dropdown no longer offers past dates, or shows the honest empty state if no valid partner exists.

- [ ] **Step 4: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "fix(schedule): mark past shifts and stale requests instead of offering impossible actions"
```

---

## Self-review notes

**Spec coverage.** Design section 0 maps to Task 1; sections 1, 2, and 3 to Task 2; sections 4 and 5 to Task 3. The spec's testing list maps to Task 1 Step 2 (the timezone boundary) and Task 2 Step 1 (every guard plus the deny escape hatch). The spec's named risk, the `>=` boundary, is covered by the explicit "includes a partner whose only free date is today" case.

**Ordering is deliberate.** The extraction lands first so no task retypes the timezone logic. The server guards land before the display changes so the display is never claiming a restriction the API does not enforce. If the tasks were reversed, an intermediate commit would show "This shift has passed." while the API still accepted the request.

**Two steps leave a decision to the implementer**, each with the information needed: Task 1 Step 1 (which `dates` module can host an async settings-dependent helper without inverting a dependency) and Task 3 Step 2 (how the today-key reaches a client component). Both would be worse guessed than read.

**Not covered: stale rows already in the database.** After this ships they are deniable, not approvable. That is intended and stated in the spec's Consequences. No migration, no state change.
