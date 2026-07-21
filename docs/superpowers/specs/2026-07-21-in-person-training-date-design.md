# In-Person Training Date: Gate the Makeup Quiz Until After the Session

Date: 2026-07-21
Status: Approved design, ready for implementation planning
Branch: `worktree-in-person-training-date` (off `main`, which now has the cross-term + scheduling work)

## 1. Goal and shape

The recruitment training makeup quiz is for members who **missed** the in-person training session. Today it is available to any member as soon as the cycle has quiz questions, so a member could take the makeup before the session even happens (skipping the live session). This adds an optional **in-person training date** to the training cycle; the makeup quiz becomes available only **after** that date has passed. Setting the date also tells members when their session is.

The gate is entirely additive and backward-compatible: a cycle with no date set behaves exactly as today.

### 1.1 Locked decisions

- **Boundary (Q1=A):** the makeup quiz opens the **day after** `inPersonTrainingDate`, compared in the clinic's configured display timezone (Eastern by default). The training date itself is "attend the live session" day; nobody can pre-empt the session by taking the makeup earlier that day.
- **Pre-open member experience (Q2=A):** before the makeup opens, the quiz form is **hidden**; the section leads with the in-person session and the date, directing the member to attend. The quiz appears only once it is open.
- **No date set = no gate:** fully backward-compatible; the quiz behaves as it does today.
- **Scope:** the gate applies only to the member self-serve makeup quiz. Director attendance recording, the lock/reset/attempt mechanics, pass %, and the answer key are all unchanged.

## 2. Data model

Additive, nullable field on `RecruitmentCycle`:

```prisma
inPersonTrainingDate DateTime?
```

Stored as a **calendar date anchored at noon UTC**, matching the convention `Term.clinicDates` already use, so a timezone rollover never shifts the day. `null` means no in-person date is set (no gate). One additive migration, no backfill.

Per training cycle, so Volunteer training and Director training (separate cycles) each carry their own date.

## 3. The gate rule + helper

A single source of truth for "is the makeup open":

```
makeupIsOpen(inPersonTrainingDate: Date | null, now: Date, zone: string): boolean
```
- Returns `true` when `inPersonTrainingDate` is `null` (no gate) OR the current day key (in `zone`) is **strictly greater than** the `inPersonTrainingDate` day key (i.e. today is at least the day after).
- Pure and unit-tested. Compares by `isoDateKey`-style day keys in the display zone (mirrors the existing Eastern-time date handling, e.g. `src/platform/dates`), never raw timestamps.

The makeup date the member sees ("opens [date + 1 day]") is derived from `inPersonTrainingDate`.

## 4. Service changes (`src/modules/recruitment/services/training.ts`)

- **`updateQuizSettings`** gains `inPersonTrainingDate: Date | null` in its input and persists it (alongside `quizPassPercent` / `quizMaxAttempts`). Same `recruitment.manage_cycles` gate and audit entry.
- **`MyTraining` type** gains two fields the member surfaces consume:
  - `inPersonTrainingDate: Date | null`
  - `makeupOpen: boolean` (computed via `makeupIsOpen` for the resolved cycle at read time)
  `getMyTrainingForTerm` / `getMyTraining` populate them from the cycle.
- **`submitQuiz`** rejects a submission when the makeup is not open, before any grading, throwing a typed `TrainingStateError` (e.g. "The makeup quiz isn't open yet."). This is the server-side enforcement; it uses the same `makeupIsOpen` helper against the cycle's date. (The existing `COMPLETE` / `locked` / attempt-cap checks are unchanged and continue to run.)

## 5. Surfaces

### 5.1 Staff: the cycle-page TRAINING section
`src/app/(app)/recruitment/cycles/[id]/page.tsx` — the TRAINING card that already renders Pass % / Max attempts / "Save quiz settings". Add an **"In-person training date"** date input to that same form; the `updateQuizSettingsAction` reads it and passes it (or `null` when cleared) to `updateQuizSettings`. Clearable (empty = no gate). Shown only to `canManage` (same as the other quiz settings).

### 5.2 Member: `/training` and `/get-started/training`
`src/app/(app)/training/page.tsx` (and the onboarding step `src/app/get-started/training/page.tsx`, which renders the same `TrainingQuiz`). Branch on `my.makeupOpen` for a pending, not-locked, cycle-present training:
- **`makeupOpen === true` (or no date set):** unchanged — "two ways to complete," the `TrainingQuiz` form renders.
- **`makeupOpen === false`:** hide the `TrainingQuiz` form. Lead with the in-person session: e.g. *"Your in-person training is on {inPersonTrainingDate}. Attend the live session and your director marks you complete. Missed it? The makeup quiz opens {inPersonTrainingDate + 1 day}."* Path 1 (attend) is the call to action; Path 2's card shows the makeup as locked until that open date.

The `COMPLETE`, `locked`, and `!cycle` states are unaffected (a completed or locked training never reaches the makeup-open branch).

## 6. Edge cases

- **Date in the past when set:** `makeupIsOpen` is immediately `true` (today is already after it) — the quiz opens right away. Correct.
- **No date set:** no gate anywhere; identical to today.
- **Attendance before the date:** a director recording live-session attendance is independent of this gate and still completes training at any time.
- **Timezone:** all comparisons use the configured display zone by day key, so there is no UTC-midnight rollover bug (a member near midnight ET sees a consistent day).

## 7. Testing

- **`makeupIsOpen` (pure):** null date → open; today before / on / after the date (in-zone day keys) → closed / closed / open respectively; the day-after boundary is exercised explicitly.
- **`submitQuiz`:** rejects with `TrainingStateError` when the makeup is not open (date set, today ≤ date); succeeds once open; a cycle with no date behaves as today.
- **`getMyTraining` / `getMyTrainingForTerm`:** `makeupOpen` and `inPersonTrainingDate` are populated correctly for open / not-open / no-date cycles.
- **`updateQuizSettings`:** persists the date and clears it (null); still gated on `recruitment.manage_cycles`.
- **Pages** (RSC, no unit test): verified by `tsc` + full lint; the pre-open hidden-quiz state and the staff date input are Playwright/manual (e2e can't run locally).

## 8. Done criteria

- A recruitment lead can set (and clear) an in-person training date in the cycle TRAINING section.
- With a date set, a member cannot start or submit the makeup quiz until the day after that date; before then they see the in-person session details and the makeup's open date.
- `submitQuiz` rejects an early submission server-side.
- A cycle with no date set behaves exactly as today (no gate).
- Director attendance recording and all existing quiz mechanics are unchanged.
- New tests cover `makeupIsOpen`, the `submitQuiz` gate, and the `MyTraining` fields.
