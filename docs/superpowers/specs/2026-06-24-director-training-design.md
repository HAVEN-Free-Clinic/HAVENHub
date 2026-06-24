# Director training design

## Problem

Training in HAVEN Hub is volunteer-only. A `RecruitmentCycle` with
`track = VOLUNTEER` is designated as the term's training cycle
(`isTermTraining`), volunteers complete it via quiz or recorded attendance,
and completion is stored in a `VolunteerTraining` row keyed by
`(personId, termId)`. `submitQuiz` and `recordAttendance` reject anyone without
an active `VOLUNTEER` membership, and (after PR #53) the clearance gate,
dashboard status rail, and My Info clearance card all treat training as
required only for active volunteers.

HAVEN wants directors to complete their own training when a director training
cycle is run for the term. This is net-new: there is no modeled concept of
director training today (the original recruitment-training spec explicitly
deferred it as out of scope).

## Goals

- When a term has a designated **director** training cycle, members holding an
  active `DIRECTOR` membership must complete it to be cleared.
- A person who is **both** a director and a volunteer in the same term (and both
  cycles are running) must complete **both** trainings, tracked separately.
- The clearance UI (gate, dashboard rail, My Info) shows separate, clearly
  labeled rows — "Volunteer training" and/or "Director training" — for only the
  trainings that apply to that person.
- Director training **mirrors** volunteer training mechanically: a
  `DIRECTOR`-track recruitment cycle designated as the term's director training,
  completed through the same quiz / recorded-attendance flow, with maximum reuse
  of the existing code path.

## Non-goals

- Different training *content rules* for directors (same quiz/attendance engine,
  just a different cycle and its own questions).
- Changing how volunteer training works for volunteers.
- Retroactively requiring director training in terms where no director cycle is
  designated — the requirement only exists when a director cycle is run.

## Design

### Data model (generalize `VolunteerTraining` → `Training`)

Rename the model so it is no longer volunteer-specific and can hold one record
per person **per track** per term.

- `model VolunteerTraining` → `model Training`.
- Add `track TrainingTrack` where `TrainingTrack` is a new enum `{ VOLUNTEER, DIRECTOR }`.
  (A dedicated enum rather than reusing `RecruitmentTrack` keeps training's own
  vocabulary independent of recruitment, though the values mirror it.)
- Change `@@unique([personId, termId])` → `@@unique([personId, termId, track])`.
- Rename relations that point at the model:
  - `QuizAttempt.training` relation and its `@relation` name.
  - `Person.volunteerTrainings` (both the participant and attendance-recorder
    back-relations) → `trainings` / suitably renamed.
  - `Term.volunteerTrainings` → `trainings`.
  - `RecruitmentCycle.trainings` (already named `trainings`) — unchanged name,
    now typed `Training[]`.

**Migration** (single migration, run via the unpooled `directUrl` migrate-on-deploy
path used for Neon):

1. Rename table `VolunteerTraining` → `Training` (data preserved).
2. Add column `track` with default `VOLUNTEER` so existing rows backfill, then
   keep the default for new volunteer rows (director rows set it explicitly).
3. Drop the `(personId, termId)` unique index, add `(personId, termId, track)`.

### Cycle designation: one training cycle per term **per track**

Today the invariant is "one training cycle per term" and `setTrainingCycle`
rejects non-volunteer cycles.

- `getTrainingCycleForTerm(termId, track)` becomes track-aware (filters
  `isTermTraining: true` **and** the cycle's `track`).
- `setTrainingCycle(cycleId, value, actorId)`:
  - Drops the `cycle.track !== "VOLUNTEER"` rejection — a `DIRECTOR` cycle may now
    be designated.
  - Scopes its "clear the others" sweep to the **same track** as the cycle being
    designated, so a term can simultaneously have one volunteer training cycle and
    one director training cycle.
- Admin: the recruitment cycle page's "designate as term training" toggle now
  works for `DIRECTOR`-track cycles as well; no new screen needed.

### The unifying rule: `requiredTrainingTracks`

A new helper generalizes the `isActiveVolunteer` check introduced in PR #53:

```
requiredTrainingTracks(personId, termId): TrainingTrack[]
  result = []
  for (kind, track) in [(VOLUNTEER, VOLUNTEER), (DIRECTOR, DIRECTOR)]:
    hasMembership = active TermMembership(personId, termId, kind) exists
    cycleExists   = getTrainingCycleForTerm(termId, track) != null
    if hasMembership and cycleExists: result.push(track)
  return result
```

Behavior matrix:

| Person | Volunteer cycle | Director cycle | Required trainings |
|--------|-----------------|----------------|--------------------|
| Volunteer-only | yes | – | Volunteer |
| Director-only | – | no | none (cleared on cert alone) |
| Director-only | – | yes | Director |
| Director + volunteer | yes | yes | Volunteer **and** Director |

`isActiveVolunteer` is removed; all of its PR #53 call sites move to
`requiredTrainingTracks`.

### Service layer (track-aware, single code path)

- `getMyTraining(personId)` returns the training(s) the person must take this
  term — one entry per track in `requiredTrainingTracks`, each carrying its own
  cycle, quiz questions, attempt count, lock state, completion, and intake. The
  return shape becomes a list (or a small per-track map). The `/training` page and
  `/get-started/training` render one section per entry.
- `resolveTrainingState(personId, termId, track)` gains the `track` argument and
  looks up the `(personId, termId, track)` row.
- `submitQuiz(personId, { track, answers, intake })` and
  `recordAttendance(personId, termId, track, actorId)` take the track and verify
  the **matching** membership kind (`VOLUNTEER` track ⇒ `VOLUNTEER` membership,
  `DIRECTOR` track ⇒ `DIRECTOR` membership) instead of hard-coding `VOLUNTEER`.
  Grading, locking, attempt caps, and audit logging are unchanged.
- `completeTraining` and the upsert paths key on `(personId, termId, track)`.

### Clearance, gate, dashboard, My Info

- **Onboarding engine** emits a training task **per required track**. Add a
  `directorTraining` task key (alongside `training`) with its own copy
  ("Director training" / "Finish this term's director training to be cleared for
  shifts"). The service emits a task only for tracks in `requiredTrainingTracks`,
  so `deriveTrainingTaskState` is only ever called for a required track — its
  PR #53 `isVolunteer` flag becomes vestigial and is removed (it reverts to
  `(state, attemptsUsed) -> COMPLETE | IN_PROGRESS | INCOMPLETE`). The gate
  sub-route `/get-started/training` selects the track via a `?track=` query param;
  each task row links to its own track.
- **`overallClearance(certStatus, allRequiredTrainingsComplete)`** is cleared when
  the cert is valid **and** `allRequiredTrainingsComplete` is true. The caller
  computes that flag from the person's required tracks (true when none are
  required). This replaces the PR #53 `(certStatus, training, trainingRequired)`
  form. Volunteer rosters and recruitment, which compute per-volunteer clearance,
  pass `training === "COMPLETE"` for the single volunteer track.
- **My Info `ClearanceCard`** and the **dashboard status rail** render one row per
  required track, each linking into the training flow. A director+volunteer sees
  both rows; a director-only (with a director cycle) sees only "Director training";
  a volunteer-only sees only "Volunteer training".

### Testing

- **Unit** — `requiredTrainingTracks` across the four-cell matrix above;
  `overallClearance` with zero, one, and two required trainings (cleared only when
  all complete and cert valid); onboarding engine emitting per-track tasks.
- **Service** — a director can complete director training (quiz + attendance); a
  director-only person with no director cycle stays exempt; the quiz/attendance
  guards accept the matching membership kind and reject the wrong one; a
  director+volunteer must complete both before clearance.
- **Schema** — the `(personId, termId, track)` uniqueness allows two rows for one
  person/term and rejects a duplicate within a track.

## Relationship to PR #53

This feature **extends** PR #53 (which made training role-conditional via
`isActiveVolunteer`); it does not revert it. PR #53 should merge first, or this
branches off it. The `isActiveVolunteer` helper and the `trainingRequired` flag
introduced there are generalized into `requiredTrainingTracks` and a
multi-track clearance check.

## Rollout

- No behavior change for any term until an admin designates a `DIRECTOR`-track
  cycle as that term's director training. Until then, `requiredTrainingTracks`
  returns exactly what PR #53 produced.
