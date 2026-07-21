# Cross-Term Model: Current vs. Next Term (Foundation + Training/Onboarding)

Date: 2026-07-20
Status: Approved design, ready for implementation planning
Scope of this spec: the term-resolution **foundation** plus the **first subsystem** (training + onboarding). Scheduling, RBAC scope edges, learning, EHS, and the clearance roster are named follow-ups that reuse this foundation.

## 1. Goal and shape

HAVEN operates on overlapping timelines: recruitment, training, onboarding, and scheduling for the **next** term all happen while the **current** term is still live (e.g. in Summer 2026 the clinic recruits, trains, onboards, and schedules Fall 2026, then "flips" to Fall). The platform, however, has a single global `getActiveTerm()` pointer (the one `ACTIVE` term), and ~55 call sites resolve their term through it. Recruitment cycles are the only subsystem that is genuinely term-scoped (each cycle carries its own `termId`); everything else assumes "the term this work is for" equals "the one active term", so next-term training, onboarding, and scheduling are invisible or blocked until the flip.

The confirmed member-facing failure this slice fixes: a volunteer promoted into a next-term (`PLANNING`) membership cannot see or complete their training/onboarding, because `getMyTraining` and the onboarding gate resolve `getActiveTerm()` (the live term), for which the recruit has no membership. Worse, the recruit is marked `onboarded: true` for the live term (their next-term training step is silently dropped), so the requirement reappears only after the flip.

Operating reality (confirmed with the product owner):
- At any moment there are **exactly two** terms in play: one **live** term and one **next** term in preparation. Never three.
- **Staff** doing next-term work select the term explicitly (a working-term switcher). This lands with scheduling (Section 4), not this slice.
- **Members** see **one merged task list across every term they belong to**, each item labeled by term. No member-facing switcher.

### 1.1 Design decisions (locked)

- **Term model**: "live term" = the single `ACTIVE` term; "next term" = the single `PLANNING` term. No schema change.
- **How flows learn their term**: explicit term parameter (Approach A). Services stop calling `getActiveTerm()` internally and instead receive a `termId`; the caller (a page, or a per-person aggregator) decides. This is the direct cure for the silent-wrong-term bug and makes services pure and unit-testable. It matches recruitment cycles, the one subsystem that already works.
- **Gate vs. display**: the onboarding **gate** enforces blocking tasks for the **live term only**. Next-term tasks are shown and actionable but never block hub access until that term goes live.

### 1.2 In scope (this slice)

- Three new term resolvers (Section 2).
- `getMyTraining` and `submitQuiz` become term-explicit / multi-term (Section 3.1).
- Onboarding split into a live-term **gate** function and a multi-term **display** function (Section 3.2).
- Member surfaces updated: `/training`, `/get-started`, dashboard "Your status" + action cards (Section 3.3).

### 1.3 Out of scope (named follow-ups, same foundation)

- **Scheduling** term-awareness, and with it the staff `<TermSwitcher>` UI + its page wiring (Section 4). The `getWorkingTerm` resolver itself is built and tested in this slice; only its UI consumer defers.
- **RBAC incoming-director scope**: `manageableDepartmentIds` / `reviewScope` derive department scope only from live-term directorships, so a brand-new incoming director has empty scope. Deferred: SRR/`review_all` and continuing directors already work, so the common operator is not blocked.
- **Learning, EHS, clearance roster, compliance reminders**: adopt `getPersonTerms` later. Reminders stay live-term-only for now (do not nag about next-term training before it is a member's term).

## 2. The term-resolution core

No database migration. Three resolvers are added next to the existing `getActiveTerm()` in `src/platform/terms/`. `getActiveTerm()` already *is* the live-term resolver and keeps its name and all current call sites unchanged.

### 2.1 `getNextTerm()`

```
getNextTerm(): Promise<Term | null>
```
The single `PLANNING` term (newest by `startDate` if more than one ever exists), React-`cache()`-memoized like `getActiveTerm`. Returns `null` when no term is in preparation (the normal state for most of the year). Co-located: `src/platform/terms/next-term.ts`.

### 2.2 `getWorkingTerm(selectedId?)`

```
getWorkingTerm(selectedId?: string): Promise<Term | null>
```
For staff forward-looking pages. If `selectedId` matches the live or next term, return that term; otherwise fall back to the live term. This is the guardrail that makes an invalid or stale `?term=<id>` fall back safely rather than error. It is a small pure resolver, so it is **built and unit-tested in this slice** even though its only UI consumer (the `<TermSwitcher>` and its page wiring) ships with scheduling (see Section 4). Co-located: `src/platform/terms/working-term.ts`.

### 2.3 `getPersonTerms(personId)`

```
getPersonTerms(personId: string): Promise<Term[]>
```
The terms a person is currently a member of that are live or in preparation: terms `T` where `T.status IN (ACTIVE, PLANNING)` and the person holds an `ACTIVE` `TermMembership` in `T`. Ordered live-term-first, then next term. This is the set the merged member views iterate over. `ARCHIVED` terms and terms the person is not an active member of are excluded, so old terms never clutter a member's list. Co-located: `src/platform/terms/person-terms.ts`. React-`cache()`-memoized.

### 2.4 The gating rule (live-term-only)

The onboarding gate (`enforceOnboarding` in `src/platform/auth/session.ts`) enforces blocking tasks for the **live term only**, unchanged in mechanism. It keeps calling the live-term onboarding-status function (Section 3.2). Next-term tasks never reach the gate. At the flip, the next term becomes the live term and the same gate begins enforcing its blocking tasks with no code path change: only the term underneath moved.

Rationale: without this rule a returning volunteer could be locked out of doing their current-term shifts because they had not finished next-term training. With it, "getting ahead" is always optional until it is actually your term, and a new recruit onboards at their own pace during prep and is hard-gated only once their term is live.

## 3. Member-facing conversion

### 3.1 Training (`src/modules/recruitment/services/training.ts`)

- Extract today's single-term body of `getMyTraining` into `getMyTrainingForTerm(personId, term)`.
- `getMyTraining(personId)` iterates `getPersonTerms(personId)` and concatenates the per-term results. Each `MyTraining` already carries `term: { id, name }`, so no shape change is needed for labeling.
- `submitQuiz` takes an explicit term instead of resolving the active term:
  ```
  submitQuiz(personId, { termId, track, answers, intake })
  ```
  It validates that the person holds an `ACTIVE` membership in `termId` + `track` (the existing membership check, now against the passed term), then resolves the designated training cycle for that term+track and proceeds unchanged. `recordAttendance` already uses the cycle's term and needs no change.

### 3.2 Onboarding (`src/modules/onboarding/services/onboarding.ts`)

Split the current single-term computation into a shared per-term helper, then a gate function and a display function:

- Extract the body of the current `getOnboardingStatus` into `computeOnboardingForTerm(personId, term)` returning that term's tasks + `{ onboarded, cleared }`.
- **`getOnboardingStatus(personId)` stays live-term-only** (resolves `getActiveTerm()`, runs `computeOnboardingForTerm` for it, returns dormant `onboarded: true` when there is no live term). It continues to drive `enforceOnboarding` and any hard clearance decision. Minimal change.
- **New `getMyOnboarding(personId)`** runs `computeOnboardingForTerm` across `getPersonTerms(personId)` and returns the tasks **grouped by term** (each term with its own completion counts and `onboarded`/`cleared`). React-`cache()`-memoized.

### 3.3 Surfaces

- **`/training`** (`src/app/(app)/training/page.tsx`): render trainings grouped by term with a term heading/badge, each group using the existing `TrainingQuiz` component and its own state. The submit action passes the group's `termId` into `submitQuiz`.
- **`/get-started`** and **`/get-started/training`**: show the merged, term-grouped checklist from `getMyOnboarding`. The gate still only blocks on live-term tasks, but the page shows next-term tasks so recruits can get ahead.
- **Dashboard** (`src/app/(app)/page.tsx`): "Your status" rail and the training/onboarding action cards read `getMyOnboarding` / `getMyTraining`, so counts and links include next-term tasks, each labeled by term.

### 3.4 The bug, fixed as a side effect

A Fall-only recruit (no live-term membership) during prep:
- Gate: live-term (Summer) onboarding has no tasks for them (no Summer membership), so they are **not blocked** during prep. Correct.
- Display: `getMyOnboarding` / `getMyTraining` surface their Fall onboarding and training via `getPersonTerms`, so it is **visible and completable**. Fixed.
- After the flip: the same gate now resolves Fall as the live term and enforces their Fall blocking tasks normally. No silent false-clear, no invisibility.

## 4. Staff side and switcher sequencing

The staff working-term switcher has **no consumer inside this slice**. The staff-facing training surface (`/recruitment/cycles/[id]/training`) is cycle-scoped and already term-correct via `cycle.termId`; the empty-roster symptom was data (no promoted members in the cycle's term), not a missing term seam. So this slice adds **no new staff-facing code**.

The `getWorkingTerm` resolver (Section 2.2) is built and tested in this slice, but the `<TermSwitcher>` component (reusing the existing `buildTermOptions` logic in `src/modules/admin/components/term-options.ts`, selection driven by `?term=<id>`) and the page wiring that reads `?term` and calls `getWorkingTerm` are **built in the scheduling spec**, where the schedule builder is the first surface that genuinely needs to target a term other than the live one. Building the switcher now, with nothing for it to switch, would be speculative.

## 5. Edge cases and degradation

- **No next term** (normal most of the year): `getNextTerm()` is `null`, `getPersonTerms` returns just the live term, and every multi-term path collapses to exactly today's single-term behavior. This is why the change is safe to ship mid-term, before any overlap.
- **No live term** (between archive and activate): gate stays dormant (`onboarded: true`) as today; merged views show only next-term tasks, if any. No lockouts.
- **Membership in an `ARCHIVED` term**: excluded by `getPersonTerms`.
- **Returning member** (member of both terms): appears in both, merged. **New recruit** (next-term only): appears for the next term only.
- **More than one `PLANNING` term** (should not happen given "exactly two"): `getNextTerm` takes the newest by `startDate`. An explicit "next" designation can be added later if this ever becomes real. YAGNI now.
- **Invalid/stale `?term`**: `getWorkingTerm` falls back to the live term (relevant when the switcher ships).

## 6. Rollout and migration

- No schema migration, no data backfill.
- Fully backward-compatible: identical behavior whenever only one term is in flight, which is the steady state. It can ship well before the August overlap.
- Blast radius: three new resolvers, two refactored services (`training.ts`, `onboarding.ts`), and ~three updated surfaces (`/training`, `/get-started`, dashboard status/cards).

## 7. Testing strategy

- **Resolvers**: `getNextTerm` returns the `PLANNING` term and `null` when none. `getPersonTerms` returns live + next where the person is an active member, excludes `ARCHIVED` and non-member terms, orders live-first.
- **`getMyTraining`**: returning member (live + next memberships) gets trainings for both, labeled; new recruit (next-only) gets next-term training; degrades to single-term when no next term exists.
- **Onboarding gate vs. display**: the gate (`getOnboardingStatus`) blocks only on live-term blocking tasks even when next-term tasks are incomplete; `getMyOnboarding` shows both terms. The exact bug scenario: a Fall-only recruit is not gated on Summer and their Fall tasks are visible; after a simulated activation of Fall, the gate enforces their Fall tasks.
- **`submitQuiz`**: accepts a next-term submission while the live term differs; rejects a term the person is not an active member of.
- Update existing training/onboarding unit tests to the new signatures.

## 8. Operational precondition (not code)

The online makeup quiz cannot grade a pass until a lead sets the answer key on the next-term cycle ("Edit quiz" -> per-question `correctValue`); the default template seeds the 15 questions with no answer key. This is an operational step, called out here so it is not mistaken for a code defect (it was one of the two reasons the quiz looked unused).

## 9. Done criteria

- `getNextTerm`, `getPersonTerms`, and `getWorkingTerm` exist and are unit-tested (the `<TermSwitcher>` UI that consumes `getWorkingTerm` ships later, with scheduling).
- A member promoted into a next-term membership sees and can complete their next-term training and onboarding while the live term is different, with tasks grouped by term.
- The onboarding gate blocks only on live-term blocking tasks; next-term incompleteness never locks a member out.
- No member is ever silently marked cleared for work they have not done; the requirement surfaces before the flip and gates after it.
- Behavior is unchanged when only one term is in flight.
- Existing tests pass; new tests cover the multi-term and gate-vs-display paths.
