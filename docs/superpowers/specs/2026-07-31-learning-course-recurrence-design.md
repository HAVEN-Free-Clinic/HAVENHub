# A course completed once clears the learning gate forever (2026-07-31)

## Problem

`CourseProgress` has no term field, unlike its sibling `Training`, which carries `termId`.
`getMyCourses` (`src/modules/learning/services/enrollment.ts:110-121`) scopes *assignment* by term
via `assignedCourseIds(personId, termId)`, but its progress query filters on `personId` and
`courseId` only:

```ts
const progress = await prisma.courseProgress.findMany({
  where: { personId, courseId: { in: ids } },
  select: { courseId: true, lessonStatus: true },
});
```

So a two-year-old completion is returned as this term's status. `deriveLearningTaskState` then
returns COMPLETE, the checklist row goes green, and the blocking learning step clears without the
volunteer opening anything.

The surrounding system plainly evaluates per term. `computeOnboardingForTerm` computes every task
for a passed term, and its own doc comment records that learning was specifically changed to accept
a term id so the checklist and the schedule builder's clearance map would agree for a given term.
Learning is now the one input to that per-term decision that cannot vary by term, so it silently
answers "already done" for all of them.

Audit finding **B1** (F-06-12), PR #474, tier 1, `blocks`, reach "every returning volunteer, in
their second and every later term".

## Decisions

Jack ruled on these on 2026-07-31; they are settled and not up for re-litigation here.

- **`Course.recurrence` = `ONCE | PER_TERM`, defaulting to `ONCE`.** That makes today's behavior
  explicit rather than accidental. An `ANNUAL` option was considered and rejected: the app is
  organized around Terms, so a yearly cadence would need its own rule for which term a completion
  belongs to and when the year rolls over, which `PER_TERM` gets for free.
- **Flipping a live course to `PER_TERM` takes effect from the next term.** Current-term clearances
  stand. Nobody already cleared and rostered loses clearance mid-semester. "Immediate" was rejected
  because it would pull people off the schedule mid-term; "ask the admin at flip time" was rejected
  because it puts a consequential choice in a confirm box.

## Goals

Make the learning gate answer per term for courses that should recur, and leave every existing
course behaving exactly as it does today until someone deliberately changes it.

## Non-goals

- Deadlines for recurring courses. That is **B4** and folds in separately.
- Changing what assignment means. `assignedCourseIds` already scopes by term and is correct.
- Any change to SCORM packaging, upload, or the runtime's own semantics.

## Design

### 1. Schema

Add `Course.recurrence`, an enum defaulting to `ONCE`. Add `termId` to `CourseProgress`, mirroring
`Training`.

**The existing `@@unique([personId, courseId])` on `CourseProgress` must become
`@@unique([personId, courseId, termId])`.** Without that, a person can only ever hold one progress
row per course and per-term recurrence cannot exist. This is the constraint the whole feature turns
on, and changing it is the riskiest part of the migration because the SCORM runtime writes through
that exact key (below).

### 2. The latches are the hard part, and `ScoProgress` is the trap

`enrollment.ts:327-349` reads the existing row and **latches completion**:

> Latch course completion too (defense in depth alongside the per-SCO latch): a completed course
> never reverts on a later commit.

That latch is keyed on `(personId, courseId)`. Once `CourseProgress` is per-term the course-level
latch follows the new row, which is correct.

**But `ScoProgress` is `@@unique([personId, courseId, scoId])` and has its own per-SCO latch.** It is
not addressed by the audit's proposed fix. If it is left alone, then when a `PER_TERM` course
reopens next term, the SCO rows still report "completed", the rollup immediately recomputes the
course as complete, and the fresh `CourseProgress` row is created already-COMPLETE. **The feature
would appear to ship and do nothing**, which is worse than not shipping it, because the checklist
would show a green row that nobody earned and no test of the course-level logic would catch it.

So `ScoProgress` needs the same per-term treatment, or an explicit reset when a `PER_TERM` course
opens in a new term. There is precedent for the reset shape: `packages.ts` already has an
`opts.resetProgress` path that wipes `CourseProgress` and orphaned `ScoProgress` in a transaction
when a package is re-ingested. Prefer the per-term key over a reset, for the same reason
`CourseProgress` gets one: a reset destroys the prior term's record, and this is a compliance
artifact.

### 3. Reads

`getMyCourses` scopes its progress lookup by `termId` **for `PER_TERM` courses only**, and leaves it
unscoped for `ONCE` courses so their behavior is unchanged.

Every other reader has to be checked against the same rule, not just this one. The known set:
`enrollment.ts:160` (rollup), `enrollment.ts:327` (the SCORM upsert), `dashboard.ts:56` and `:97`,
`clearance.ts:129`, and `packages.ts:167`. **`clearance.ts` is the one that must not diverge**: it
feeds the schedule builder's clearance map, and the entire reason learning takes a term id today is
so the checklist and that map agree. If one of the two becomes term-aware and the other does not,
this fix creates exactly the contradiction it exists to remove.

### 4. Backfill

Existing `CourseProgress` rows get the term containing their `completedAt`.

**Rows with a null `completedAt` need an explicit rule**, which the audit's sketch does not give.
They are IN_PROGRESS attempts with no completion date to locate a term by. The options are the
person's active term at migration time, the term whose date range contains the row's creation, or
leaving `termId` null and treating null as "belongs to whatever term asks". Pick one deliberately
and write it into the migration, because a wrong choice silently strands someone's half-finished
attempt in a term they are not in.

### 5. Surfaces

Add the setting to the `/learning/manage` course form, and render "Retake each term" on the learner
card so the recurrence is visible to the person it affects rather than only to the director who set
it. Ship **R47** alongside so staleness is visible.

## Consequences

**Nothing changes for anyone on deploy.** Every existing course is `ONCE`, which is what they
already effectively are. The first behavioral change happens when a director flips a course, and
even then not until the next term.

**A director can now make a volunteer redo work.** That is the point, but it is a new power on a
blocking gate, so the manage-form copy should say plainly that it takes effect next term.

**This is a compliance-relevant record.** Per-term rows mean "did this person complete this course
in this term" becomes answerable, which it currently is not. That is a real gain beyond the defect.

## Testing

- A `ONCE` course completed in a prior term still reads COMPLETE this term. **This is the
  regression test for the whole change**, because it is today's behavior and must survive.
- A `PER_TERM` course completed in a prior term reads NOT COMPLETE this term, and the blocking
  learning step does not clear.
- **A `PER_TERM` course whose SCO rows are all complete from a prior term does not auto-complete in
  the new term.** This is the `ScoProgress` trap above; without this test the feature can ship
  inert.
- Flipping a course to `PER_TERM` mid-term leaves a currently-complete volunteer complete for the
  current term, and requires a retake in the next one.
- `clearance.ts` and the onboarding checklist return the same answer for the same person and term,
  for both recurrence values. Assert them against each other, not just individually.
- The backfill assigns each existing row a term, including the null-`completedAt` case.

## Risks

- **The `ScoProgress` latch can make this ship inert**, passing every course-level test while the
  learner is auto-completed by stale SCO rows. Named here because the audit's own fix sketch misses
  it.
- **Changing a `@@unique` that the SCORM runtime upserts through** is the highest-risk edit in the
  migration. The upsert at `enrollment.ts:346` uses `personId_courseId` by name; that identifier
  changes shape and every call site must move with it.
- **A partial rollout across readers is worse than no rollout.** If `clearance.ts` and the checklist
  disagree, a volunteer is cleared on one screen and blocked on another, which is harder to diagnose
  than the current consistent-but-wrong behavior.
- **The backfill is not reversible in practice.** Once rows carry a term, reconstructing the
  original ambiguity is not possible. Worth a dry run against a copy before it runs anywhere real.
