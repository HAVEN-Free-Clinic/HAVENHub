# Recruitment Plan 14: Volunteer Training + Quiz Design

**Date:** 2026-06-09
**Status:** Approved (brainstorm)
**Module:** `recruitment` (final sub-project of the Recruitment program)
**Builds on:** Plans 10 to 13 (stacked branch `plan-14/recruitment-training`)
**Program spec:** `docs/superpowers/specs/2026-06-08-recruitment-design.md` (see decomposition table, row 14)

Modeled on the Airtable "HAVEN Volunteer Recruitment" base (`appOq1yOiA1Lfzq8L`),
tables **Volunteer Training Attendence** (`tblFZNiYufv2JjkUd`) and **Makeup
training** (`tblYCz2mApTikDK90`). In Airtable, live attendees fill an intake form
(subcommittee interest, shift preferences, feedback) and staff tick "Added to
Compliance?"; volunteers who missed the session complete a multiple-choice
HIPAA/mission knowledge check on the Makeup table before being added to
compliance.

---

## 1. Goal and shape

Post-promotion, a volunteer is not fully **cleared** for the term until two
requirements hold together:

1. a valid HIPAA certificate (the existing, unchanged compliance computation), and
2. completed **training** for the term.

Training completes one of two ways:

- **Attendance:** a director records that the volunteer attended the live
  training session (no quiz).
- **Quiz:** a volunteer who did not attend logs in and passes a makeup
  knowledge-check quiz.

Each `Term` has exactly one **designated training cycle**: a volunteer
`RecruitmentCycle` that owns the quiz definition and the attendance roster. Every
active volunteer `TermMembership` in that term is gated against that cycle's
training. There is **no backfill**: volunteers already on the roster read
`PENDING` until they attend or pass the quiz this term.

The training requirement is folded into compliance as a combined **overall
clearance** that surfaces both dimensions (certificate and training) rather than
overwriting the certificate-specific states.

### 1.1 Scope

In scope:

- Mark a volunteer recruitment cycle as the term's designated training cycle (at
  most one per term).
- Author a per-cycle quiz with the existing form builder, extended so each
  question carries a correct answer.
- A self-serve training surface where a volunteer takes the quiz (when they did
  not attend) and submits the post-training intake.
- A director/SRR surface to record attendance, view training status, and reset a
  volunteer who has been locked out of the quiz.
- Fold training into a combined overall clearance shown on the existing
  compliance surfaces.

Out of scope (YAGNI):

- Scheduling logic. The intake captures shift preferences as free-form data
  mirroring Airtable; it does not feed the Schedule module in this plan.
- Director-track training. This plan covers the volunteer track only.
- Editing the seeded HIPAA/mission question content as a shared bank. Quiz
  content is authored per cycle in the builder.

---

## 2. Data model (additive migration)

### 2.1 `RecruitmentCycle` additions

| Field | Type | Notes |
|-------|------|-------|
| `isTermTraining` | `Boolean @default(false)` | Marks this cycle as the term's designated training source. At most one `true` per `termId`. |
| `quizPassPercent` | `Int @default(80)` | Passing threshold as a percentage of graded questions answered correctly. |
| `quizMaxAttempts` | `Int @default(3)` | Number of failing attempts allowed before the volunteer is locked and a director must reset. |

The single-designated-cycle-per-term invariant is enforced two ways: a service
guard inside the toggle transaction (clearing any prior designation for the term,
or rejecting), and a Postgres **partial unique index**
`CREATE UNIQUE INDEX ... ON "RecruitmentCycle"("termId") WHERE "isTermTraining"`
added via a raw SQL block in the Prisma migration (Prisma's `@@unique` cannot
express the partial predicate).

### 2.2 `FormSection` addition

| Field | Type | Notes |
|-------|------|-------|
| `purpose` | `FormPurpose @default(APPLICATION)` | enum `{ APPLICATION, QUIZ }`. APPLICATION sections behave exactly as Plan 10. QUIZ sections hold quiz questions and render on the training page, not the public application. |

New enum `FormPurpose { APPLICATION, QUIZ }`.

The Plan-10 conditional-supplement resolver (visibility by applicant type and
department) operates over **APPLICATION sections only**. QUIZ sections are never
part of `/apply/[slug]` and are excluded from `buildApplicationSchema`.

### 2.3 `FormField` addition

| Field | Type | Notes |
|-------|------|-------|
| `correctValue` | `String?` | For a graded quiz question (`SINGLE_SELECT` inside a QUIZ section), the `value` of the correct option. Null for application fields and for any non-graded field. |

Quiz questions are `SINGLE_SELECT`. A question with `correctValue == null` is
treated as non-graded (excluded from `total`); the builder warns but does not
block, so a draft quiz can be saved mid-authoring.

### 2.4 New model `VolunteerTraining`

One row per `(personId, termId)`. Training is "attend once per term", and the
quiz state (attempts, lock) is inherently per person-per-term, so the row is keyed
on the person and term rather than a single membership: a volunteer in two
departments trains once and clears both. Created **lazily** on the first training
action (attendance tick or first quiz attempt). Absence of a row means `PENDING`.

| Field | Type | Notes |
|-------|------|-------|
| `id` | `String @id @default(cuid())` | |
| `personId` | `String` | FK to `Person` (onDelete: Cascade). |
| `termId` | `String` | FK to `Term` (onDelete: Cascade). `@@unique([personId, termId])`. |
| `cycleId` | `String` | FK to the designated training `RecruitmentCycle` (onDelete: Restrict). |
| `status` | `TrainingStatus @default(PENDING)` | enum `{ PENDING, COMPLETE }`. |
| `completedVia` | `TrainingMethod?` | enum `{ ATTENDANCE, QUIZ }`. Null while PENDING. |
| `completedAt` | `DateTime?` | |
| `attendanceRecordedById` | `String?` | FK to `Person` (the director/SRR who ticked). |
| `attendanceRecordedAt` | `DateTime?` | |
| `locked` | `Boolean @default(false)` | True when quiz attempts are exhausted without a pass. |
| `lockResetAt` | `DateTime?` | Set when a director resets a lock. Attempts are counted against the cap only from this moment forward, so prior `QuizAttempt`s stay as history. |
| `subcommitteeInterest` | `String?` | Intake. |
| `additionalShiftAvailability` | `String?` | Intake. |
| `minShiftsWanted` | `String?` | Intake. |
| `feedback` | `String?` | Intake. |
| `createdAt` / `updatedAt` | `DateTime` | |

New enums `TrainingStatus { PENDING, COMPLETE }`, `TrainingMethod { ATTENDANCE, QUIZ }`.

Back-relation: `attempts QuizAttempt[]`.

### 2.5 New model `QuizAttempt`

One row per submitted attempt (supports retakes and an audit trail of scores).

| Field | Type | Notes |
|-------|------|-------|
| `id` | `String @id @default(cuid())` | |
| `trainingId` | `String` | FK to `VolunteerTraining` (onDelete: Cascade). |
| `answers` | `Json` | Object keyed by quiz `FormField.key`. |
| `score` | `Int` | Count of graded questions answered correctly. |
| `total` | `Int` | Count of graded questions (those with a `correctValue`). |
| `passed` | `Boolean` | `round(100 * score / total) >= cycle.quizPassPercent` (a quiz with `total == 0` cannot pass). |
| `takenAt` | `DateTime @default(now())` | |

### 2.6 Test reset list

`src/platform/test/db.ts` `resetDb()` TRUNCATE list gains `"VolunteerTraining"`
and `"QuizAttempt"` (placed before `"TermMembership"` so cascade ordering is
respected; `CASCADE` makes ordering forgiving but the list stays explicit).

---

## 3. Quiz authoring (builder extension)

The cycle builder (`/recruitment/cycles/[id]/builder`) gains a second tab,
**Training quiz**, beside the existing application form. Behavior:

- Quiz sections are `FormSection`s with `purpose = QUIZ`. They reuse the existing
  section/field add, reorder, and inline-edit controls.
- A quiz field is a `SINGLE_SELECT` with its options, plus a **correct answer**
  picker that writes `correctValue` (one of the option values). The picker is
  shown only inside QUIZ sections.
- The same Plan-10 lifecycle guard applies to structural edits after a cycle is
  OPEN, with one addition: changing a quiz question's `correctValue` is a **safe**
  edit (it does not invalidate stored answers; it only changes future grading).
- Designating the term's training cycle is a toggle, **Use as this term's
  training**, on the cycle overview page. Turning it on for one cycle clears it
  from any other cycle in the same term inside a single transaction (last writer
  wins), keeping the partial-unique invariant satisfied.
- `quizPassPercent` and `quizMaxAttempts` are edited on the cycle overview beside
  the toggle.

---

## 4. Completion model and clearance

### 4.1 Attendance path

A director (or SRR) records attendance for a volunteer from the training roster
(see 6.2). The service upserts the volunteer's `VolunteerTraining` to
`status = COMPLETE`, `completedVia = ATTENDANCE`, stamping
`attendanceRecordedById` / `attendanceRecordedAt` / `completedAt`. Intake is
**optional** for attendees: they may fill it later from their training page, but
it is not required for clearance. Recording attendance is idempotent (re-ticking
an already-complete attendee is a no-op).

### 4.2 Quiz path

A volunteer who did not attend opens `/training` (see 6.1). If their training is
not complete and they are not locked, the page renders the intake fields plus the
cycle's quiz sections. On submit:

1. The intake fields are saved to `VolunteerTraining` (row created lazily if
   absent).
2. The attempt is graded by the engine (section 5) and a `QuizAttempt` row is
   written.
3. If `passed`: `VolunteerTraining` becomes `status = COMPLETE`,
   `completedVia = QUIZ`, `completedAt = now`.
4. If not passed and the number of attempts now equals `cycle.quizMaxAttempts`:
   set `locked = true`. The page then shows a locked state directing the
   volunteer to contact their director.
5. Otherwise the page re-renders with the score and a retake option.

A volunteer who already attended (their training is COMPLETE via ATTENDANCE) does
not see the quiz; their training page shows cleared/complete and an editable
intake.

### 4.3 Overall clearance (the combined status)

A new pure function lives beside the existing certificate rules:

```ts
// src/platform/compliance/rules.ts (or a sibling module it re-exports)
export type TrainingState = "PENDING" | "COMPLETE";
export type OverallClearance = "CLEARED" | "NOT_CLEARED";

export function overallClearance(
  certStatus: ComplianceStatus,
  training: TrainingState,
): OverallClearance;
```

`CLEARED` iff `certStatus` is `COMPLIANT` or `EXPIRING_SOON` (the volunteer is
valid through the term bar today) **and** `training === "COMPLETE"`. Otherwise
`NOT_CLEARED`. The existing `ComplianceStatus` values are untouched; every
compliance surface now shows three things: certificate status, training state,
and the derived overall clearance with a per-dimension breakdown.

Training state for a member is resolved per `(personId, termId)`: `COMPLETE` if a
`VolunteerTraining` row exists with `status = COMPLETE`, else `PENDING` (this is
how "no backfill" yields `PENDING` for legacy volunteers with no row). A
membership row in a compliance view resolves its training state from its person
and the active term.

---

## 5. Grading engine (pure, `engine/`)

`src/modules/recruitment/engine/quiz-grading.ts`:

```ts
export type GradedQuestion = { key: string; correctValue: string | null };

export type QuizResult = {
  score: number;   // graded questions answered correctly
  total: number;   // graded questions (correctValue != null)
  percent: number; // round(100 * score / total), 0 when total == 0
  passed: boolean; // total > 0 && percent >= passPercent
};

export function gradeQuiz(
  questions: GradedQuestion[],
  answers: Record<string, unknown>,
  passPercent: number,
): QuizResult;
```

Pure and side-effect free. A question with `correctValue == null` is excluded
from `total`. A missing or non-matching answer scores zero for that question. A
quiz with `total == 0` returns `passed = false` (an unfinished quiz can never
clear a volunteer). The service supplies `questions` from the designated cycle's
QUIZ-section `SINGLE_SELECT` fields and `passPercent` from `cycle.quizPassPercent`.

Attempt-cap and lock are **service** responsibilities, not the engine's. The cap
counts only attempts in the **current allowance window**: `QuizAttempt`s with
`takenAt >= training.lockResetAt` (or all attempts when `lockResetAt` is null).
After writing a failing attempt, the service counts the window's attempts and sets
`locked = true` when that count reaches `cycle.quizMaxAttempts`. A director
**reset** sets `locked = false` and `lockResetAt = now`, which starts a fresh
window. Prior `QuizAttempt`s are never deleted, so the score history is preserved
as an audit trail while the cap stays a pure function of the current window's
attempt count.

---

## 6. Surfaces

### 6.1 Volunteer self-serve: `/training`

Authenticated route (standard hub auth: Entra login plus Person match). Resolves
the active term and the volunteer's active VOLUNTEER membership in it, then the
term's designated training cycle.

States rendered:

- **No designated training cycle for the term:** informational "training is not
  yet open" page (no gate failure for the volunteer to act on).
- **Already complete:** shows cleared/complete, `completedVia`, and an editable
  intake form.
- **Pending, not attended, not locked:** intake fields plus the quiz; submit
  grades inline and shows score and pass/fail.
- **Locked:** score history summary and a message to contact the director;
  no submit.

A card on **My Info** surfaces the volunteer's overall clearance (certificate plus
training) and links to `/training`. (Per the design discussion, the self-serve
surface is a standalone `/training` route with a My Info entry point, not folded
into My Info.)

### 6.2 Director and SRR: `/recruitment/cycles/[id]/training`

Available on the designated training cycle. Lists in-scope active volunteer
memberships for the cycle's term with, per row: name, department, certificate
status, training state, overall clearance, and controls to **record attendance**
and **reset** a locked volunteer. Scope follows `manageableDepartmentIds` for a
director (own departments plus one-hop delegations) or all departments for
`recruitment.review_all`. If the cycle is not the designated training cycle, the
page explains that and links to the overview toggle.

### 6.3 Compliance integration

`departmentCompliance` and `masterCompliance` in
`src/modules/volunteers/services/compliance.ts` add, per member row: the
training state (resolved per 4.3) and the `overallClearance`. The existing
certificate column and statuses are unchanged. Sorting keeps certificate status
as the primary key; overall clearance is a derived display column. This is a read
extension: the volunteers module reads `VolunteerTraining` via prisma (it does not
import the recruitment module), consistent with the module-boundary rule.

---

## 7. Permissions

No new permission is declared. Mapping:

- **Author the quiz, set `quizPassPercent` / `quizMaxAttempts`, designate the
  term training cycle:** `recruitment.manage_cycles` (the SRR builder role).
- **Record attendance, view the training roster, reset a lock:** department-scoped
  via `manageableDepartmentIds`, or `recruitment.review_all`, mirroring how
  `departmentCompliance` already scopes director access. Recording attendance for
  a volunteer outside the actor's scope is rejected with `TrainingAuthError`.
- **Take the quiz / submit intake:** an authenticated session whose Person owns
  the membership. The capability is "being that volunteer"; no management
  permission is required, and a session may only act on its own membership.

---

## 8. Error handling and boundaries

Typed service errors map to friendly states rather than 500s:

- `TrainingAuthError`: actor lacks scope to record attendance or reset, or a
  session tries to submit a quiz for a membership it does not own.
- `QuizLockedError`: a submit arrives while `locked = true`.
- `TrainingStateError`: submit against a term with no designated training cycle,
  a non-OPEN/closed designated cycle, a quiz with no graded questions, or a
  membership that is not an active volunteer membership.

A React error boundary already wraps the recruitment module; `/training` carries a
minimal boundary of its own. Module boundary is preserved: training services write
`VolunteerTraining` / `QuizAttempt` and read `TermMembership` / `HipaaCertificate`
directly via prisma, never importing another module; the volunteers compliance
read does the same in reverse.

---

## 9. Testing strategy

**Engine (pure, unit):**

- `gradeQuiz`: all-correct, partial, all-wrong, missing answers, non-graded
  questions excluded from `total`, `total == 0` never passes, percentage rounding
  at the threshold boundary (for example pass at exactly `quizPassPercent`).
- `overallClearance`: the matrix of `ComplianceStatus` cross `TrainingState`;
  `CLEARED` only for valid cert plus COMPLETE; EXPIRING_SOON counts as valid;
  EXPIRED / NO_CERTIFICATE / UNKNOWN_DATE never CLEARED regardless of training.

**Services (integration, real DB):**

- Designate-training-cycle: setting it on one cycle clears it from a prior cycle
  in the same term; two cycles in the same term cannot both be designated.
- Attendance path: tick creates a COMPLETE/ATTENDANCE row; idempotent re-tick;
  out-of-scope actor rejected.
- Quiz path: lazy row creation; pass flips COMPLETE/QUIZ and saves intake; failing
  attempts accumulate; reaching `quizMaxAttempts` sets `locked`; submit while
  locked raises `QuizLockedError`; director reset clears the lock, stamps
  `lockResetAt`, and lets the volunteer attempt again while prior attempts stay in
  history; a session cannot submit for another membership.
- Training-state resolution: a person with no row resolves PENDING (no
  backfill); a COMPLETE row resolves COMPLETE; completing once clears every active
  volunteer membership the person holds in the term.
- Compliance read extension: `departmentCompliance` rows carry training state and
  overall clearance, scoped to manageable departments.

**e2e (Playwright):**

Sign in as `j.carney@yale.edu` → create/confirm a volunteer cycle, author a short
quiz (a couple of graded questions), set it as the term's training cycle → as a
volunteer with a valid cert but no training, open `/training`, fail the quiz once,
then pass it, and confirm overall clearance flips to CLEARED on the compliance
surface → for a second volunteer, record attendance from the roster and confirm
they clear via the attendance path without a quiz.

---

## 10. Done-criteria

- A term can have exactly one designated volunteer training cycle, set from the
  cycle overview, owning a builder-authored quiz with correct answers and
  configurable pass threshold and attempt cap.
- Every active volunteer membership in that term reads PENDING training until it
  completes via a director attendance tick or a passed quiz; no backfill.
- The quiz auto-grades, supports retakes up to the cap, locks on exhaustion, and a
  director can reset a locked volunteer.
- Compliance surfaces show certificate status, training state, and a combined
  overall clearance (CLEARED only when the certificate is valid and training is
  complete).
- Module boundary, permissions, and the full test matrix (engine unit, service
  integration, e2e) are green; CI (lint including module-boundary, typecheck,
  tests) passes.
