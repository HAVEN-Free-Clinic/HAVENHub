# The training quiz certifies things it did not test (2026-07-30)

## Problem

The makeup quiz gates a volunteer's clearance. Passing it writes
`Training.status = COMPLETE` / `completedVia = QUIZ`, which the clearance map, the schedule
builder, and the director putting someone in front of a patient all read as "this person
demonstrated 80% competency on HIPAA, documentation language, and IPV-disclosure handling."

Three defects mean that record can be produced without demonstrating any of it, and a fourth means
some volunteers cannot produce it at all.

**A failed attempt hands over the entire answer key.** `submitQuiz` returns `correctByKey` for
every graded question, not just the missed ones, and the review UI marks the matching option
"Correct" on all fifteen. `tryAgain` then clears state with no cooldown, no reshuffle, and an
immediately submittable form. That review screen only renders on a failed, non-locking attempt,
because passing and locking both take the `router.refresh()` path. So it renders in exactly the
state that precedes another attempt. Walked by the audit: after scoring 0%, the page showed the
correct option for all fifteen questions, and one click returned a submittable form.

**"Try again" also discards every answer, including the correct ones.** `tryAgain` calls
`setAnswers({})`. The realistic failure is a near miss, since 12 of 15 is the 80% bar, so a
volunteer who got 11 right must re-answer all 15 rather than fix the 4 they missed. The same click
leaves the window near the bottom of a 5,332px page with focus on `<body>`, parking them below a
now-blank quiz.

**A quiz with no answer keys is unpassable, and nothing warns anyone.** `gradeQuiz` drops unkeyed
questions from `total` and returns `passed = total > 0 && rawPercent >= passPercent`, so zero keyed
questions makes `passed` permanently false. The learner-side "not ready yet" card and `submitQuiz`'s
own guard both fire only on `questions.length === 0`, so fifteen unkeyed questions render and submit
as a normal quiz. `setTrainingCycle` validates nothing before designating a cycle as term training.
The volunteer gets the fail banner three times, then "Your makeup quiz is locked after 3 attempts.
Contact your recruitment director to reset it." Neither screen mentions that passing was impossible.

Findings **R5** (F-06-11), **R20** (F-06-2), **R6** (F-06-1), and **R62** (F-09-2) from the
2026-07-29 audit, PR #474. The audit pairs them deliberately: R5 and R20 share a payload, and R62
is named as the plausible cause of R6.

## Goals

Stop the quiz certifying competency it did not test, and stop it blocking volunteers who never had
a chance to pass.

## Non-goals

- Changing the pass threshold, the attempt cap, or what the questions ask.
- Reworking how directors author quiz questions. R62 adds a pointer and a count to a card that
  already exists; it does not touch the question builder.
- **B1, the separate finding that a course completed once satisfies the learning gate in every
  later term.** Adjacent, still needs a decision from Jack, and no implementation here resolves it.

## Design

### 1. Never return the answer key

Change `submitQuiz` to return a per-question verdict and stop returning `correctByKey` entirely:

```ts
verdictByKey: Record<string, "correct" | "wrong">
```

The audit proposed dropping the key only on the failed-and-not-locked path. Dropping it on every
path is simpler and strictly safer: the review UI is the only consumer, and it renders only on that
path, because passing and locking both `router.refresh()`. If some consumer does need the key, that
will surface immediately as a type error rather than as a silent leak.

The review UI then marks **only the learner's own selection**, "Correct" or "Not correct", and marks
nothing at all on any other option. The learner still learns which questions to restudy without
being told what to pick.

**Corrected 2026-07-30, before planning.** The audit specified `wrongKeys: string[]`, and this spec
first repeated it. A map keyed by verdict is the right shape, because **a quiz can be partially
keyed.** R6's builder guard requires at least one keyed question, not that every question is keyed,
and `gradeQuiz` already drops unkeyed questions from the total. With a bare `wrongKeys` array, a
question nobody graded is indistinguishable from one the learner got right, so the review screen
would label the learner's answer "Correct" on a question that was never scored. That is the same
class of defect this branch exists to fix. A verdict map simply omits ungraded questions, and they
render unmarked.

**Cut from scope: per-attempt option shuffling.** The audit proposed shuffling `q.options` so
positional recall cannot substitute for knowledge. That made sense when a failed attempt handed over
the whole answer key: there was a correct position to memorise. Once the key is never returned, the
only thing a learner carries between attempts is which of *their own* choices was wrong, which is
the legitimate function of a review screen. Shuffling would obstruct the honest learner and protect
against nothing. Dropped deliberately, not overlooked.

### 2. Keep the answers the learner got right

`tryAgain` should clear `graded` and `error`, and clear **only the answers whose verdict was
`"wrong"`**, leaving everything else pre-filled. Then scroll to and focus the first now-unanswered
question. Because `answeredCount` is derived from the answer map, the progress bar, the "N of 15
answered" counter, and the disabled state of Submit all follow for free.

This must consume R5's `verdictByKey`, not `graded.correctByKey`, which R5 removes. **The two land
in the same change or not at all**; a version of this that reads the old payload reintroduces the
leak.

### 3. Refuse to run an unpassable quiz, on both sides

**Learner side.** `getMyTrainingForTerm` already queries `FormField` for the quiz. Add
`correctValue: true` to that select, count the non-null ones into a new `gradedQuestionCount` on
`MyTraining`, and render the existing "not ready yet" card when it is zero. Throw the same
`TrainingStateError` in `submitQuiz` when no question is keyed.

**Do not send `correctValue` itself to the client.** Count it server-side and send the count.

**Builder side.** In `setTrainingCycle`, when `value` is true, count keyed `SINGLE_SELECT` fields in
the cycle's `QUIZ` sections and throw when the count is zero:

> This cycle's quiz has no answer keys, so nobody could pass it.

This is the guard that would have prevented the whole failure mode.

### 4. Tell the director where the questions live

R62. The Training card's quiz-settings form ends in "Save quiz settings" with nothing indicating
that the keyed questions live on a separate page reachable only from the cycle tab bar. A director
who fills in that card has a reasonable basis for believing the quiz is configured.

Add a link to the quiz question page and a count, so "0 questions" is visible from the page a
director actually lands on after creating a cycle.

## Consequences

**A director can no longer designate a cycle as term training until its quiz has at least one keyed
question.** That is the point, but it is a new refusal on an existing action and may surprise
someone mid-setup. The message says exactly what is wrong and what to do.

**Several existing tests designate a quiz-less cycle and will start failing.** `setTrainingCycle(id,
true, ...)` is called on cycles with no quiz in `training.test.ts` (`seed`-built `c1`/`c2`, and
`seedMember`) and in `onboarding.test.ts:13`. Those fixtures must seed a keyed question before
designating. This is the guard working, not collateral damage, and the fix is in the fixtures rather
than in the guard. Tests that write `isTermTraining: true` through Prisma directly
(`training-schema.test.ts`, `compliance.test.ts`) bypass the service and are unaffected.

**A volunteer mid-attempt when this ships** keeps their attempt history. Nothing about existing
`Training` rows changes.

**A director can still empty a designated cycle's quiz afterwards**, since the guard fires on
designation, not on question deletion. The learner-side guard is what covers that, which is why both
exist.

**Anyone who passed by reading the answer key already has a `COMPLETE` record.** This fix stops new
ones; it does not audit old ones. Whether to re-test anyone is an operational question, not a code
one.

## Testing

- `submitQuiz` returns a verdict for exactly the graded questions, and no field carrying correct
  answers, on the failed, passed, and locked paths.
- **A question with no `correctValue` gets no verdict**, so the review screen leaves it unmarked
  rather than calling the learner's answer correct.
- The review UI marks only the learner's own selection, and marks nothing on the options they did
  not pick.
- `tryAgain` preserves correct answers and clears only the wrong ones.
- `gradeQuiz` is unchanged; its existing behavior on zero keyed questions is what the new guards
  detect, not something to alter.
- The learner-side card renders when `gradedQuestionCount` is zero, and `submitQuiz` throws in the
  same state.
- `setTrainingCycle` throws when designating a cycle whose quiz has no keyed questions, and still
  succeeds when it has at least one.
- **`correctValue` never reaches the client.** Assert on the serialized payload, not just the type.

## Risks

- **The learner-side count and the builder-side guard must agree on what "keyed" means.** If one
  counts `SINGLE_SELECT` fields with a non-null `correctValue` and the other counts something
  slightly different, a cycle could pass the builder guard and still be unpassable. They share one
  exported predicate for exactly this reason.
- **A verdict map is a smaller leak than the answer key, not zero leak.** A learner who repeats an
  answer across attempts learns, by elimination, that the choice was wrong. That is the intended
  behavior: knowing which questions you missed is the point of a review screen. Worth stating so
  nobody mistakes it for an oversight.
- **The builder guard is a new refusal on a button directors already use.** If it turns out to
  obstruct a real setup order, the learner-side guard alone still prevents every volunteer-facing
  symptom, so the builder guard can be relaxed to a warning without reopening the defect.
