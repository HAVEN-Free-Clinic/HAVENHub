# Training Quiz Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the makeup quiz certifying competency it did not test, and stop it blocking volunteers who never had a chance to pass.

**Architecture:** One shared "is this question graded" predicate in `src/platform/quiz/`, consumed by three guards (learner render, learner submit, cycle designation). The quiz result payload changes from an answer key to a per-question verdict, and the retry path consumes that verdict instead of wiping every answer.

**Tech Stack:** Next.js App Router, Prisma, React client components, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-30-training-quiz-integrity-design.md`. Read it before Task 1, including its two dated corrections (the verdict map replacing `wrongKeys`, and option shuffling being cut from scope).
- Source findings: PR #474, items **R5** (F-06-11), **R6** (F-06-1), **R20** (F-06-2), **R62** (F-09-2).
- **No em-dashes anywhere, in prose or code.** CI enforces this via the `local/no-em-dash` eslint rule.
- **`correctValue` must never reach the client.** It is the answer key. Count it, compare against it, derive verdicts from it, but never put it in a prop, a server-action return value, or a serialized payload.
- **The payload change and the review-screen change are one task on purpose.** Removing `correctByKey` and rewriting its only consumer cannot be reviewed apart: a reviewer cannot approve half of it, and the intermediate state does not typecheck. Do not split them.
- Lint with `npx eslint src e2e`. Plain `npm run lint` walks a gitignored design-system directory and produces noise. Run `npm run typecheck` before each commit.
- Tests need a database. `TEST_DATABASE_URL` points at a throwaway Postgres on :5434, never Neon. If Prisma reports drift or a stale client, that is an environment problem, not your change.
- `main` carries pre-existing storage and blob-cleanup test flakes. They are not yours. A failure in a file you touched **is** yours, even if it looks unrelated.

## File structure

- Create: `src/platform/quiz/graded.ts` (the shared predicate) plus its test
- Modify: `src/modules/recruitment/services/training.ts` (payload, both service guards, the learner-side count)
- Modify: `src/app/(app)/training/actions.ts:12-22,41-48` (the action's result type)
- Modify: `src/app/(app)/training/training-quiz.tsx` (review marking, retry, zero-graded card)
- Modify: `src/app/get-started/training/page.tsx:47-55` (thread the new prop)
- Modify: `src/app/(app)/recruitment/cycles/[id]/page.tsx:204-249` (the Training card link and count)
- Modify: `src/modules/recruitment/services/training.test.ts`, `src/modules/onboarding/services/onboarding.test.ts` (fixtures the new guard breaks)

---

### Task 1: Stop revealing the answer key, and keep what the learner got right

**Files:**
- Modify: `src/modules/recruitment/services/training.ts:20-30` (the `QuizSubmission` type) and `:339-342` (the return)
- Modify: `src/app/(app)/training/actions.ts:12-22` and `:41-48`
- Modify: `src/app/(app)/training/training-quiz.tsx`
- Test: `src/modules/recruitment/services/training.test.ts`

**Interfaces:**
- Produces: `QuizSubmission.verdictByKey: Record<string, "correct" | "wrong">`, replacing `correctByKey: Record<string, string>`. `QuizActionResult`'s `graded` variant carries the same field with the same name and type.

R5 and R20 both land here. The server stops returning the answer key, and the review screen and retry path are its only consumers, so all three move together. Commit in two steps if you like, but **the task is complete only when typecheck passes**; the intermediate state after the payload change alone does not compile.

- [ ] **Step 1: Change the type and the return**

In `training.ts`, replace the `correctByKey` field on `QuizSubmission`:

```ts
/** Graded question key -> whether the learner's answer was right. Ungraded
 *  questions (correctValue == null) are absent, so the review screen leaves
 *  them unmarked rather than implying they were scored. Never carries the
 *  correct value itself: a failed attempt precedes a retry. */
verdictByKey: Record<string, "correct" | "wrong">;
```

Update the type's doc comment above it, which currently says the payload carries "which option was correct". That is exactly what it must stop doing.

At `:339-342`, replace the `correctByKey` construction with:

```ts
const verdictByKey = Object.fromEntries(
  questions
    .filter((q) => q.correctValue !== null)
    .map((q) => [q.key, input.answers[q.key] === q.correctValue ? "correct" : "wrong"] as const)
);
```

Note `input.answers[q.key] === q.correctValue` mirrors `gradeQuiz`'s own comparison at `src/platform/quiz/grading.ts:23`. Keep them consistent; if you find yourself writing a different comparison, stop and reconcile.

- [ ] **Step 2: Thread it through the server action**

In `actions.ts`, replace `correctByKey` on the `"graded"` variant of `QuizActionResult` with the same `verdictByKey` field and type, and update the return at `:47`. Update the field's doc comment.

**Do not add a compatibility shim.** No `correctByKey` alongside the new field, no optional field. After this step typecheck fails at exactly one site, `training-quiz.tsx:186`, which Step 5 rewrites. If it fails anywhere else, stop and report that instead of fixing it silently.

- [ ] **Step 3: Update the existing test and add the ungraded case**

`training.test.ts:120` currently asserts `expect(r1.correctByKey).toEqual({ q1: "a", q2: "y" })`. That assertion, as written, is a test that the answer key leaks. Replace it:

```ts
expect(r1.verdictByKey).toEqual({ q1: "correct", q2: "wrong" });
```

The fixture at `:115` answers `{ q1: "a", q2: "x" }` against keys `q1: "a"`, `q2: "y"`, so q1 is right and q2 is wrong.

Then add a new test for the partially-keyed case, which is the reason the payload is a map:

```
- a quiz with one keyed and one unkeyed question returns a verdict only for the keyed one
```

Build it by extending the `addQuiz` pattern at `:102-108` with a third field carrying `correctValue: null`, then assert the returned `verdictByKey` has no entry for that key. Write it as its own test with its own fixture rather than editing `addQuiz`, which other tests depend on.

- [ ] **Step 4: Assert the answer key is gone**

Add a test that the returned object carries no correct-answer values at all:

```
- the submission payload contains no field holding a correct option value
```

Assert on the serialized shape (`JSON.stringify` the result and check the known correct values do not appear), not just on the absence of a property name. A future field could reintroduce the leak under a different name, and a property-name check would not catch it.

- [ ] **Step 5: Mark only the learner's own selection**

At `:184-205`, the current logic is:

```tsx
const sel = answers[q.key] === o.value;
const isCorrect = reviewing && graded!.correctByKey[q.key] === o.value;
const isWrong = reviewing && sel && !isCorrect;
```

`isCorrect` there means "this is the answer", which is why every option row on every question announces the answer. Replace with:

```tsx
const sel = answers[q.key] === o.value;
const verdict = reviewing ? graded!.verdictByKey[q.key] : undefined;
const isCorrect = sel && verdict === "correct";
const isWrong = sel && verdict === "wrong";
```

An option the learner did not pick is now never marked, and a question with no verdict (ungraded) is never marked at all.

Change the wrong-answer label at `:202` from `Your answer` to `Not correct`. Leave the correct label as `Correct`. `optionClass`, `dotClass`, and `dotFillClass` keep their signatures; only the meaning of `isCorrect` changes, from "this is the key" to "your pick was right".

- [ ] **Step 6: Keep the correct answers on retry**

`tryAgain` at `:89-93` calls `setAnswers({})`. Replace it so it clears only the wrong ones:

```tsx
function tryAgain() {
  const verdicts = graded?.verdictByKey ?? {};
  setGraded(null);
  setError(null);
  setAnswers((a) => {
    const next = { ...a };
    for (const [key, verdict] of Object.entries(verdicts)) {
      if (verdict === "wrong") delete next[key];
    }
    return next;
  });
  setRetryFocusKey(questions.find((q) => verdicts[q.key] === "wrong")?.key ?? null);
}
```

`answeredCount` at `:50` is derived from `answers`, so the progress bar, the "N of N answered" counter, and Submit's disabled state all follow with no further change. Confirm that when you verify.

- [ ] **Step 7: Land focus on the first question they have to redo**

Today the same click leaves the window near the bottom of a long page with focus on `<body>`. Add:

```tsx
const [retryFocusKey, setRetryFocusKey] = useState<string | null>(null);
const fieldsetRefs = useRef<Record<string, HTMLFieldSetElement | null>>({});

// After Try again clears the missed answers, land the reader on the first question
// they have to redo. Without this, focus falls to <body> near the bottom of a very
// long page and the next Tab starts from the top of the document.
useEffect(() => {
  if (!retryFocusKey) return;
  const el = fieldsetRefs.current[retryFocusKey];
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
  el?.focus();
  setRetryFocusKey(null);
}, [retryFocusKey]);
```

Give the `<fieldset>` at `:176` `ref={(el) => { fieldsetRefs.current[q.key] = el; }}`, `tabIndex={-1}`, and `outline-none` in its className, matching how `resultHeadingRef` is handled at `:132`.

Handle `retryFocusKey === null` cleanly: it means nothing was wrong, which the pass path already covers, so simply do nothing.

- [ ] **Step 8: Verify in a browser**

Environment: `.env.local` does not exist in this worktree. Copy it from `/Users/jcarney/Documents/Code-Projects/HAVENHub/.claude/worktrees/fix+hipaa-verification-wait/.env.local`, which was confirmed present when this plan was written. It is gitignored; never commit it.

Do not start a long-lived dev server and hand it off. Start it yourself with `run_in_background: true`, confirm it answers with `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/`, and use Playwright MCP. The Chrome extension is not connected.

Reaching this screen needs a member with a required track, a designated training cycle whose makeup window is open, and an unlocked training row. If you cannot assemble that state in reasonable time, **say so in your report and rely on the unit tests** rather than burning the task on fixture archaeology. Report what you did or did not see.

What to confirm if you get there: a failed attempt marks only your own selections, a question you got right stays filled in after Try again, and Try again lands you on the first question you have to redo.

- [ ] **Step 9: Run, verify green, and commit**

```bash
npx vitest run src/modules/recruitment/services/training.test.ts
npx eslint src && npm run typecheck
```

**Typecheck must pass before you commit.** If it does not, the payload migration is half done; finish it rather than committing a broken tree.

```bash
git add -A src
git commit -m "fix(training): stop revealing the quiz answer key and keep correct answers on retry"
```

---

### Task 2: A quiz with no answer keys never reaches a volunteer

**Files:**
- Create: `src/platform/quiz/graded.ts`
- Test: `src/platform/quiz/graded.test.ts`
- Modify: `src/modules/recruitment/services/training.ts` (`setTrainingCycle` at `:40-53`, `submitQuiz` at `:305-306`, `getMyTrainingForTerm` at `:246-254`, `MyTraining` at `:208-224`)
- Modify: `src/app/get-started/training/page.tsx:47-55`
- Modify: `src/app/(app)/training/training-quiz.tsx:67-82`
- Modify: `src/modules/recruitment/services/training.test.ts`, `src/modules/onboarding/services/onboarding.test.ts`

**Interfaces:**
- Produces: `countGradedQuestions(questions: { correctValue: string | null }[]): number` from `src/platform/quiz/graded.ts`. Used by all three guards. Also `MyTraining.gradedQuestionCount: number` and a `gradedQuestionCount` prop on `TrainingQuiz`.

`gradeQuiz` returns `passed = total > 0 && rawPercent >= passPercent`, so a quiz with zero keyed questions can never be passed. Today nothing detects that: the learner sees a normal quiz, fails three times, and is told to contact their director, with neither screen mentioning that passing was impossible.

- [ ] **Step 1: Write the failing test for the shared predicate**

```ts
import { describe, expect, it } from "vitest";
import { countGradedQuestions } from "./graded";

describe("countGradedQuestions", () => {
  it("counts only questions with an answer key", () => {
    expect(countGradedQuestions([{ correctValue: "a" }, { correctValue: null }])).toBe(1);
  });
  it("is zero for an empty list and for an all-unkeyed list", () => {
    expect(countGradedQuestions([])).toBe(0);
    expect(countGradedQuestions([{ correctValue: null }, { correctValue: null }])).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/platform/quiz/graded.test.ts`
Expected: FAIL, cannot resolve `./graded`.

- [ ] **Step 3: Write the predicate**

```ts
/** How many quiz questions carry an answer key. A quiz with zero can never be
 *  passed (`gradeQuiz` returns passed = false when total is 0), so this is the
 *  single definition of "ready to grade" shared by the designation guard, the
 *  submit guard, and the learner-facing render. Structural parameter type so
 *  every caller can pass its own row shape without a mapping step. */
export function countGradedQuestions(questions: { correctValue: string | null }[]): number {
  return questions.filter((q) => q.correctValue !== null).length;
}
```

The three guards must not each write their own filter. That divergence is the risk the spec names: a cycle that passes the designation guard and is still unpassable.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/platform/quiz/graded.test.ts`
Expected: PASS.

- [ ] **Step 5: Guard the designation**

In `setTrainingCycle`, after the `if (!cycle)` check at `:45` and before the transaction, when `value` is true:

```ts
if (value && countGradedQuestions(await quizQuestions(cycleId)) === 0) {
  throw new TrainingStateError(
    "This cycle's quiz has no answer keys, so nobody could pass it. Add questions with a correct answer on the cycle's Quiz tab first."
  );
}
```

`quizQuestions` is the module-private helper at `:199-206` and already selects `correctValue`. Reuse it rather than writing a second query.

No action-layer change is needed. `setTrainingCycleAction` at `src/app/(app)/recruitment/actions.ts:158-167` already lists `TrainingStateError` in `domainErrors` and redirects with the message as `?error=`, so a throw here reaches the director as page copy. Verified before this plan was written; if you find otherwise, report it rather than working around it.

- [ ] **Step 6: Guard the submit**

At `training.ts:305-306`, the current guard is `if (questions.length === 0)`. Widen it to cover the unkeyed case with one message that is true in both:

```ts
const questions = await quizQuestions(cycle.id);
if (countGradedQuestions(questions) === 0) {
  throw new TrainingStateError("This training's quiz is not ready yet. Contact your coordinator.");
}
```

- [ ] **Step 7: Surface the count to the learner's page**

In `getMyTrainingForTerm` at `:248-252`, add `correctValue: true` to the `select`. Compute `const gradedQuestionCount = countGradedQuestions(fields)` and add it to the returned object and to the `MyTraining` type.

**Then build `questions` without it.** The mapping at `:253` must keep producing `{ key, label, options }` and nothing more. `MyTraining.questions` is passed straight to a client component, so an added `correctValue` would ship the answer key to the browser. This is the single most important line in the task.

Thread `gradedQuestionCount={my.gradedQuestionCount}` into `<TrainingQuiz>` at `src/app/get-started/training/page.tsx:47-55`.

- [ ] **Step 8: Render the not-ready card in both cases**

In `training-quiz.tsx`, add `gradedQuestionCount: number` to the props, and widen the early return at `:67`:

```tsx
if (questions.length === 0 || gradedQuestionCount === 0) {
```

Update that card's copy so it is true whether the quiz has no questions or has questions nobody keyed. The learner cannot tell those apart and should not have to:

```tsx
<p className="text-base font-bold text-foreground">Makeup quiz not ready yet</p>
<p className="mt-0.5 text-sm text-foreground-soft">
  This training&apos;s quiz has not been finished yet, so there is nothing to take. Please contact
  your coordinator so they can complete it, then check back here.
</p>
```

Also update the comment above the guard at `:63-66`, which explains the zero-questions case only.

- [ ] **Step 9: Fix the fixtures the new guard breaks**

These call `setTrainingCycle(id, true, ...)` on cycles with no quiz and will now throw:

- `src/modules/recruitment/services/training.test.ts:29`, `:31` (the first test, on `seed`-built `c1` and `c2`)
- `src/modules/recruitment/services/training.test.ts:63` (inside `seedMember`, which most later tests depend on)
- `src/modules/onboarding/services/onboarding.test.ts:13`

Seed a keyed question on each affected cycle before designating. `training.test.ts` already has `addQuiz(cycleId)` at `:102-108` creating a 2-question keyed quiz; it is a hoisted function declaration, so `seed`/`seedMember` can call it despite appearing later in the file. Reuse it rather than writing a second quiz builder. `onboarding.test.ts` needs its own minimal equivalent; check whether it already has a form-field helper before adding one.

**Fix the fixtures, not the guard.** If a test seems to require designating a quiz-less cycle, that test is asserting the behavior this task removes: report it rather than weakening the guard.

Tests that write `isTermTraining: true` directly through Prisma (`training-schema.test.ts:11,19`, `compliance.test.ts:958,986`) bypass the service and need no change. Leave them alone.

- [ ] **Step 10: Test the two service guards**

```
- setTrainingCycle throws TrainingStateError when the cycle's quiz has no keyed questions
- setTrainingCycle succeeds once the cycle has at least one keyed question
- setTrainingCycle(id, false) still works on a quiz-less cycle (clearing is always allowed)
- submitQuiz throws when every question is unkeyed, not only when there are none
```

The third case matters: a cycle designated before this shipped must still be un-designatable.

- [ ] **Step 11: Run the affected suites and commit**

```bash
npx vitest run src/platform/quiz src/modules/recruitment src/modules/onboarding
npx eslint src && npm run typecheck
git add -A src
git commit -m "fix(training): refuse to run a quiz with no answer keys"
```

---

### Task 3: Tell the director where the quiz questions live

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/page.tsx:204-249`

**Interfaces:**
- Consumes: `countGradedQuestions` from Task 3.

The Training card holds pass percent, max attempts, training date, and location, and ends in "Save quiz settings". Nothing on it indicates that the keyed questions live at `/recruitment/cycles/<id>/builder/quiz`, reachable only from the cycle tab bar. A director who fills this card in has a reasonable basis for believing the quiz is configured. This is the plausible cause of the R6 failure, which is why it ships alongside it.

- [ ] **Step 1: Read the page's existing conventions first**

Read `src/app/(app)/recruitment/cycles/[id]/page.tsx` in full and the quiz builder page at `src/app/(app)/recruitment/cycles/[id]/builder/quiz/page.tsx`. Match how this page already fetches and how it already links. **Use `Link`, not a raw anchor**: a native `<a href>` to an internal route triggers a full reload, which this codebase deliberately avoids.

- [ ] **Step 2: Show the count and link to the questions**

Inside the Training card, above or beside "Save quiz settings", add a line stating how many keyed questions the cycle has and linking to the quiz builder. Query the count on the server with `countGradedQuestions`, matching `quizQuestions`'s filter (`type: "SINGLE_SELECT"`, `section: { purpose: "QUIZ" }`, scoped to this `cycleId`).

The zero case is the one that matters, and it should read as a problem rather than as a neutral stat, because at zero the quiz cannot be passed. Draft the copy in the codebase's existing voice; two examples of the shape:

- zero: "No quiz questions with an answer key yet. Volunteers cannot pass this quiz until you add some." plus a link reading "Add quiz questions".
- non-zero: "12 quiz questions with an answer key." plus a link reading "Edit quiz questions".

**Do not add a second warning surface.** Task 3 already blocks designation and explains why. This card is the pointer that makes the block unnecessary, not a duplicate alarm.

- [ ] **Step 3: Verify it renders**

Load a cycle detail page as a user with `recruitment.manage_cycles` and confirm both the zero and non-zero states, and that the link navigates without a full reload. If you cannot reach the page, report NEEDS_CONTEXT rather than guessing.

- [ ] **Step 4: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "feat(recruitment): show the keyed question count on the cycle training card"
```

---

### Task 4: Whole-branch check

**Files:** none, unless something is found.

- [ ] **Step 1: Prove the answer key does not reach the client**

Grep the whole tree for `correctValue` and `correctByKey`. Every surviving `correctValue` reference must be server-side: the Prisma schema, the grader, `quizQuestions`, the new predicate, the `getMyTrainingForTerm` count, the builder's own authoring UI (where a director legitimately sets the key), and tests. Zero references may remain in `src/app/(app)/training/` or in anything reachable from a `"use client"` component's props. `correctByKey` must be gone entirely.

Report what you found as a list, not as a claim that it is clean.

- [ ] **Step 2: Run the full unit suite**

```bash
npx vitest run
```

Compare failures against the pre-existing storage and blob-cleanup flakes named in the Global Constraints. **A failure in a file this branch touched is this branch's, however unrelated it looks.** Do not classify a failure as pre-existing without checking it against `git stash`-free evidence: run the same test on `origin/main` if you are unsure.

- [ ] **Step 3: Full lint and typecheck**

```bash
npx eslint src e2e && npm run typecheck
```

- [ ] **Step 4: Check the e2e suite for assertions this branch breaks**

`e2e/recruitment-training.spec.ts` exercises this flow and cannot be run locally. Read it and report whether anything it asserts changed: the "Your answer" label is now "Not correct", the not-ready card's copy changed, and any e2e path that designates a training cycle through the UI now needs a keyed question first. **Report what you find; do not edit e2e specs speculatively.**

---

## Self-review notes

**Spec coverage.** Spec section 1 (never return the answer key) is Task 1 Steps 1 to 5. Section 2 (keep correct answers on retry) is Task 1 Steps 6 and 7. Section 3 (refuse an unpassable quiz, both sides) is Task 2. Section 4 (tell the director where questions live) is Task 3. The spec's testing list is distributed across Tasks 1, 2, and 4, with the "`correctValue` never reaches the client" requirement appearing twice on purpose: as an assertion in Task 1 Step 4 and as a tree-wide grep in Task 4 Step 1.

**Ordering.** Task 1 is first because it is the security-relevant change. Task 2 is independent of it. Task 3 depends on Task 2 only for the shared predicate. Task 4 is the sweep.

**Task 1 is deliberately nine steps rather than two tasks.** Removing `correctByKey` and rewriting its only consumer cannot be reviewed apart: after the payload change alone the tree does not typecheck, and a reviewer approving that half would be approving a broken build. The task boundary follows what a reviewer can meaningfully accept or reject, so both live in one task with one gate.

**Two steps hand a judgment call to the implementer with the information to settle it:** Task 1 Step 8 (whether the browser state is reachable in reasonable time, with explicit permission to fall back to unit tests and say so) and Task 3 Step 2 (the copy, with the zero case's intent stated and two shape examples rather than mandated strings).

**The fixture ripple is called out with exact file and line numbers** in Task 2 Step 9, along with the rule that the fixtures move and the guard does not. Four call sites break, three of them in one file, and one of them (`seedMember`) is depended on by most of that file's later tests.

**Not covered: B1**, the separate finding that a course completed once satisfies the learning gate in every later term. The spec scopes it out; it needs a decision from Jack, not an implementation.
