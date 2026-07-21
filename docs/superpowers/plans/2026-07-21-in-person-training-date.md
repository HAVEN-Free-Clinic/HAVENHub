# In-Person Training Date (Gate the Makeup Quiz) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional in-person training date to a recruitment training cycle; the member makeup quiz becomes available only the day after that date (in Eastern time), enforced in the UI and server-side.

**Architecture:** One nullable `inPersonTrainingDate` column on `RecruitmentCycle`. A pure `makeupIsOpen(date, now, zone)` helper is the single source of truth. `updateQuizSettings` persists the date; `getMyTraining*` expose `inPersonTrainingDate` + a computed `makeupOpen`; `submitQuiz` rejects an early submission; the member pages hide the quiz before it opens.

**Tech Stack:** Next.js App Router (RSC + server actions), Prisma (+ one additive migration), Vitest against a local Postgres test DB.

## Global Constraints

- `inPersonTrainingDate` is nullable; **no date set = no gate** (behaves exactly as today). Backward-compatible.
- The makeup opens the **day after** `inPersonTrainingDate`, compared by day key **in the configured display zone** (Eastern by default) — never raw timestamps. `inPersonTrainingDate` is stored at **noon UTC** (calendar-date convention, like `Term.clinicDates`), so `isoDateKey` gives its intended day.
- The gate applies only to the member self-serve makeup quiz. Director attendance recording, lock/reset/attempt mechanics, pass %, and the answer key are unchanged.
- No em-dashes in code/comments (repo eslint `local/no-em-dash`). Modules import cross-module code only via `src/platform`. Run the FULL `npm run lint` before any push.
- Tests run against the local Postgres test DB (`havenhub_test` on `:5434`) with `resetDb()` in `beforeEach`. `new Date()` is fine in services (the purity lint only bans it in React render).

---

## File Structure

**Schema/infra:**
- `prisma/schema.prisma` — add `inPersonTrainingDate DateTime?` to `RecruitmentCycle`.
- `prisma/migrations/<ts>_cycle_in_person_training_date/migration.sql` — additive column.

**Create:**
- `src/modules/recruitment/services/makeup-window.ts` — `makeupIsOpen`, `makeupOpensOn`.
- `src/modules/recruitment/services/makeup-window.test.ts`.

**Modify:**
- `src/modules/recruitment/services/training.ts` — `updateQuizSettings` persists the date; `MyTraining` gains `inPersonTrainingDate` + `makeupOpen`; `submitQuiz` gate.
- `src/modules/recruitment/services/training.test.ts` — service tests.
- `src/app/(app)/recruitment/actions.ts` — `updateQuizSettingsAction` reads the date.
- `src/app/(app)/recruitment/cycles/[id]/page.tsx` — the date input in the TRAINING form.
- `src/app/(app)/training/page.tsx` and `src/app/get-started/training/page.tsx` — hide the quiz + show the in-person-session state before the makeup opens.

---

## Task 1: Schema + migration (in-person training date column)

> **Controller note:** run this task INLINE (schema + migration + `prisma generate` touch shared Neon/worktree infra). The local `haven` role can't create the shadow DB `migrate dev` needs, so generate the SQL with `migrate diff --from-url <local>`, TRIM any pre-existing drift, hand-write the migration, `migrate deploy` to the LOCAL test DB, and `prisma generate`. Do NOT let `migrate dev` auto-apply to the `.env` (Neon) DB.

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_cycle_in_person_training_date/migration.sql`

- [ ] **Step 1: Add the column to `RecruitmentCycle`**

In `prisma/schema.prisma`, in `model RecruitmentCycle`, next to `quizMaxAttempts`, add:

```prisma
  inPersonTrainingDate DateTime?
```

- [ ] **Step 2: Generate the additive SQL (local, no shadow DB), trim drift, write the migration**

```bash
LOCAL='postgresql://haven:haven_dev@localhost:5434/havenhub_test'
npx prisma migrate diff --from-url "$LOCAL" --to-schema-datamodel prisma/schema.prisma --script
```
The output may include pre-existing drift (unrelated ALTERs). Create `prisma/migrations/<YYYYMMDDHHMMSS>_cycle_in_person_training_date/migration.sql` containing ONLY:

```sql
-- AlterTable
ALTER TABLE "RecruitmentCycle" ADD COLUMN "inPersonTrainingDate" TIMESTAMP(3);
```

- [ ] **Step 3: Apply to the LOCAL test DB + regenerate client**

```bash
LOCAL='postgresql://haven:haven_dev@localhost:5434/havenhub_test'
DATABASE_URL="$LOCAL" DATABASE_URL_UNPOOLED="$LOCAL" npx prisma migrate deploy
npx prisma generate
```
Expected: the new migration applies; generate succeeds; `RecruitmentCycle.inPersonTrainingDate` exists (verify: `node -e "const{PrismaClient}=require('@prisma/client');new PrismaClient().recruitmentCycle.fields; console.log('ok')"` or a quick `psql` column check).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(recruitment): add inPersonTrainingDate to RecruitmentCycle"
```

---

## Task 2: `makeupIsOpen` pure helper

**Files:**
- Create: `src/modules/recruitment/services/makeup-window.ts`
- Test: `src/modules/recruitment/services/makeup-window.test.ts`

**Interfaces:**
- Consumes: `isoDateKey`, `formatForDateInput` from `@/platform/dates`.
- Produces: `makeupIsOpen(inPersonTrainingDate: Date | null, now: Date, zone: string): boolean`; `makeupOpensOn(inPersonTrainingDate: Date): Date` (the noon-UTC day-after, for display).

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/services/makeup-window.test.ts
import { expect, it } from "vitest";
import { makeupIsOpen, makeupOpensOn } from "./makeup-window";
import { isoDateKey } from "@/platform/dates";

const ET = "America/New_York";
// Training day: 2026-08-15 (stored noon UTC).
const trainingDate = new Date(Date.UTC(2026, 7, 15, 12, 0, 0));

it("is open when no date is set (no gate)", () => {
  expect(makeupIsOpen(null, new Date(), ET)).toBe(true);
});

it("is closed before and on the training day, open the day after (ET)", () => {
  // Day before, ET afternoon.
  expect(makeupIsOpen(trainingDate, new Date(Date.UTC(2026, 7, 14, 20, 0, 0)), ET)).toBe(false);
  // The training day itself, late ET evening (still 2026-08-15 in ET; 03:00Z next day).
  expect(makeupIsOpen(trainingDate, new Date(Date.UTC(2026, 7, 16, 3, 0, 0)), ET)).toBe(false);
  // The day after, ET morning.
  expect(makeupIsOpen(trainingDate, new Date(Date.UTC(2026, 7, 16, 14, 0, 0)), ET)).toBe(true);
});

it("makeupOpensOn returns the calendar day after the training date", () => {
  expect(isoDateKey(makeupOpensOn(trainingDate))).toBe("2026-08-16");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/makeup-window.test.ts`
Expected: FAIL (cannot find module `./makeup-window`).

- [ ] **Step 3: Implement the helper**

```ts
// src/modules/recruitment/services/makeup-window.ts
import { isoDateKey, formatForDateInput } from "@/platform/dates";

/**
 * Whether the self-serve makeup quiz is available. The makeup is for members who
 * missed the in-person session, so it opens the day AFTER inPersonTrainingDate:
 * true when no date is set (no gate), or when "today" in the display zone is
 * strictly past the training day. All comparison is by calendar day key in
 * `zone`, never raw timestamps, so there is no UTC-midnight rollover.
 */
export function makeupIsOpen(inPersonTrainingDate: Date | null, now: Date, zone: string): boolean {
  if (!inPersonTrainingDate) return true;
  const trainingKey = isoDateKey(inPersonTrainingDate); // noon-UTC anchored -> its calendar day
  const todayKey = formatForDateInput(now, zone); // zone-local YYYY-MM-DD
  return todayKey > trainingKey;
}

/** The calendar day the makeup opens (the day after the training date), noon-UTC anchored. */
export function makeupOpensOn(inPersonTrainingDate: Date): Date {
  return new Date(inPersonTrainingDate.getTime() + 86_400_000);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/makeup-window.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/makeup-window.ts src/modules/recruitment/services/makeup-window.test.ts
git commit -m "feat(recruitment): makeupIsOpen helper (makeup opens the day after the in-person session)"
```

---

## Task 3: Service wiring — persist the date, expose it, gate `submitQuiz`

**Files:**
- Modify: `src/modules/recruitment/services/training.ts`
- Test: `src/modules/recruitment/services/training.test.ts`

**Interfaces:**
- Consumes: `makeupIsOpen` (Task 2); `getDisplayTimeZone` from `@/platform/dates/resolve`.
- Produces: `updateQuizSettings(cycleId, { quizPassPercent, quizMaxAttempts, inPersonTrainingDate: Date | null }, actorId)`; `MyTraining` gains `inPersonTrainingDate: Date | null` and `makeupOpen: boolean`; `submitQuiz` rejects when the makeup is not open.

- [ ] **Step 1: Write the failing test**

Add to `src/modules/recruitment/services/training.test.ts` (it has a `seedMember()` helper with an active volunteer + designated cycle `c1`; and `addQuiz`, `updateQuizSettings`, `submitQuiz`, `getMyTraining` are imported). Add:

```ts
it("gates the makeup quiz until the day after the in-person training date", async () => {
  const { term, srr, vol, c1 } = await seedMember();
  await addQuiz(c1.id);
  // Set an in-person date in the future -> makeup not open yet.
  const future = new Date(Date.now() + 7 * 86_400_000);
  await updateQuizSettings(c1.id, { quizPassPercent: 100, quizMaxAttempts: 3, inPersonTrainingDate: future }, srr.id);

  const beforeOpen = await getMyTraining(vol.id);
  expect(beforeOpen[0]!.inPersonTrainingDate?.getTime()).toBe(future.getTime());
  expect(beforeOpen[0]!.makeupOpen).toBe(false);

  await expect(
    submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: {} }),
  ).rejects.toBeInstanceOf(TrainingStateError);

  // Move the date to the past -> makeup open, submission works.
  const past = new Date(Date.now() - 2 * 86_400_000);
  await updateQuizSettings(c1.id, { quizPassPercent: 100, quizMaxAttempts: 3, inPersonTrainingDate: past }, srr.id);
  const afterOpen = await getMyTraining(vol.id);
  expect(afterOpen[0]!.makeupOpen).toBe(true);
  const r = await submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: {} });
  expect(r.passed).toBe(true);
});

it("makeupOpen is true and submit works when no in-person date is set (backward compatible)", async () => {
  const { term, vol, c1 } = await seedMember();
  await addQuiz(c1.id);
  const my = await getMyTraining(vol.id);
  expect(my[0]!.inPersonTrainingDate).toBeNull();
  expect(my[0]!.makeupOpen).toBe(true);
  const r = await submitQuiz(vol.id, { termId: term.id, track: "VOLUNTEER", answers: { q1: "a", q2: "y" }, intake: {} });
  expect(r.passed).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/training.test.ts -t "gates the makeup quiz"`
Expected: FAIL (updateQuizSettings has no `inPersonTrainingDate`; `MyTraining` has no `makeupOpen`; no gate).

- [ ] **Step 3: Add the import**

At the top of `training.ts`, add:

```ts
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { makeupIsOpen } from "./makeup-window";
```

- [ ] **Step 4: `updateQuizSettings` persists the date**

Change its signature and the `data`:

```ts
export async function updateQuizSettings(
  cycleId: string,
  input: { quizPassPercent: number; quizMaxAttempts: number; inPersonTrainingDate: Date | null },
  actorId: string
): Promise<RecruitmentCycle> {
  // ... unchanged permission + bounds checks ...
  const updated = await prisma.recruitmentCycle.update({
    where: { id: cycleId },
    data: { quizPassPercent: input.quizPassPercent, quizMaxAttempts: input.quizMaxAttempts, inPersonTrainingDate: input.inPersonTrainingDate },
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.training_quiz_settings", entityType: "RecruitmentCycle", entityId: cycleId, after: input });
  return updated;
}
```

- [ ] **Step 5: `MyTraining` gains the two fields; `getMyTrainingForTerm` populates them**

Add to the `MyTraining` type (after `passPercent`):

```ts
  inPersonTrainingDate: Date | null;
  makeupOpen: boolean;
```

In `getMyTrainingForTerm`, resolve the zone once at the top of the function (before the loop):

```ts
  const zone = await getDisplayTimeZone();
  const now = new Date();
```

and in the `out.push({ ... })` object add:

```ts
      inPersonTrainingDate: cycle?.inPersonTrainingDate ?? null,
      makeupOpen: makeupIsOpen(cycle?.inPersonTrainingDate ?? null, now, zone),
```

- [ ] **Step 6: `submitQuiz` gate**

In `submitQuiz`, right after the `isMember` check (and before `quizQuestions`), add:

```ts
  const zone = await getDisplayTimeZone();
  if (!makeupIsOpen(cycle.inPersonTrainingDate, new Date(), zone)) {
    throw new TrainingStateError("The makeup quiz isn't open yet.");
  }
```

- [ ] **Step 7: Run the training suite**

Run: `npx vitest run src/modules/recruitment/services/training.test.ts`
Expected: PASS (new tests + existing; existing `updateQuizSettings(...)` test calls must add `inPersonTrainingDate: null` to their input object).

- [ ] **Step 8: Commit**

```bash
git add src/modules/recruitment/services/training.ts src/modules/recruitment/services/training.test.ts
git commit -m "feat(recruitment): persist in-person date, expose makeupOpen, gate submitQuiz"
```

---

## Task 4: Staff — the date input in the cycle TRAINING form

**Files:**
- Modify: `src/app/(app)/recruitment/actions.ts` (`updateQuizSettingsAction`)
- Modify: `src/app/(app)/recruitment/cycles/[id]/page.tsx` (the TRAINING form)

UI wiring; deliverable is `tsc` + full lint clean.

- [ ] **Step 1: `updateQuizSettingsAction` reads the date**

In `src/app/(app)/recruitment/actions.ts`, in `updateQuizSettingsAction`, parse the date field (a `<input type="date">` posts `YYYY-MM-DD` or empty) into a noon-UTC Date or null, and pass it:

```ts
export async function updateQuizSettingsAction(cycleId: string, formData: FormData) {
  const person = await requirePermission("recruitment.manage_cycles");
  const quizPassPercent = Number(formData.get("quizPassPercent"));
  const quizMaxAttempts = Number(formData.get("quizMaxAttempts"));
  const rawDate = (formData.get("inPersonTrainingDate") as string | null) ?? "";
  // Anchor at noon UTC so the calendar day is timezone-stable (matches clinicDates).
  const inPersonTrainingDate = rawDate ? new Date(`${rawDate}T12:00:00Z`) : null;
  await runAction({
    work: () => updateQuizSettings(cycleId, { quizPassPercent, quizMaxAttempts, inPersonTrainingDate }, person.personId),
    domainErrors: [TrainingStateError],
    errorRedirect: (m) => `/recruitment/cycles/${cycleId}?error=${encodeURIComponent(m)}`,
    revalidate: `/recruitment/cycles/${cycleId}`,
  });
}
```

- [ ] **Step 2: Add the date input to the TRAINING form**

In `src/app/(app)/recruitment/cycles/[id]/page.tsx`, the `updateQuizSettingsAction`-bound form renders Pass % and Max attempts inputs. Add an "In-person training date" field to the same `flex flex-wrap items-end gap-3` form, before the Save button. The page already resolves `zone` (`getDisplayTimeZone`) and imports `formatForDateInput` is available from `@/platform/dates`; use it for the default value:

```tsx
                <div className="w-44">
                  <Field label="In-person training date">
                    <Input
                      name="inPersonTrainingDate"
                      type="date"
                      defaultValue={cycle.inPersonTrainingDate ? formatForDateInput(cycle.inPersonTrainingDate, zone) : ""}
                    />
                  </Field>
                </div>
```

Add `formatForDateInput` to the page's `@/platform/dates` import if not present. (Leaving the field empty and saving clears the date -> no gate.)

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/recruitment/actions.ts" "src/app/(app)/recruitment/cycles/[id]/page.tsx"`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/recruitment/actions.ts" "src/app/(app)/recruitment/cycles/[id]/page.tsx"
git commit -m "feat(recruitment): set the in-person training date in the cycle TRAINING form"
```

---

## Task 5: Member — hide the quiz until the makeup opens

**Files:**
- Modify: `src/app/(app)/training/page.tsx`
- Modify: `src/app/get-started/training/page.tsx`

UI wiring; deliverable is `tsc` + full lint clean.

- [ ] **Step 1: `/training` — branch on `makeupOpen`**

In `src/app/(app)/training/page.tsx`, the pending branch renders `PathCards` + the "Makeup quiz" heading + `TrainingQuiz`. Gate the quiz on `my.makeupOpen`. When the makeup is NOT open, render an in-person-session notice instead of the quiz. Import `makeupOpensOn` from `@/modules/recruitment/services/makeup-window` and `formatDateOnly` (already imported). Replace the `{pending && ( ... )}` block's quiz portion with:

```tsx
              {pending && (
                <>
                  <PathCards my={my} />
                  {my.makeupOpen ? (
                    <>
                      <SectionHeader level="title" className="mb-3.5 mt-7">Makeup quiz</SectionHeader>
                      <TrainingQuiz
                        termId={my.term.id}
                        track={my.track}
                        questions={my.questions}
                        passPercent={my.passPercent}
                        maxAttempts={my.maxAttempts}
                        attemptsUsed={my.attemptsUsed}
                        intake={my.intake}
                      />
                    </>
                  ) : (
                    <Card pad={false} className="mt-7 px-5 py-5">
                      <SectionHeader className="mb-1.5">Attend the in-person session</SectionHeader>
                      <p className="text-sm leading-relaxed text-foreground-soft">
                        Your in-person training is on{" "}
                        <span className="font-semibold text-foreground">{formatDateOnly(my.inPersonTrainingDate, zone)}</span>.
                        Attend the live session and your director marks you complete. Missed it? The makeup quiz opens{" "}
                        <span className="font-semibold text-foreground">{formatDateOnly(makeupOpensOn(my.inPersonTrainingDate!), zone)}</span>.
                      </p>
                    </Card>
                  )}
                </>
              )}
```

(When `makeupOpen` is false, `inPersonTrainingDate` is always non-null by construction, so `my.inPersonTrainingDate!` is safe.)

- [ ] **Step 2: `/get-started/training` — same gate**

In `src/app/get-started/training/page.tsx`, which renders `TrainingQuiz` for the resolved live-term training, wrap the `TrainingQuiz` in the same `my.makeupOpen` check: when false, render an `Alert`/notice with the same "attend on {date}, makeup opens {date+1}" copy (using `makeupOpensOn` + the page's date formatter / display zone) instead of the quiz. Read the file first to match its existing `Alert`/shell style (it already branches on `!my.cycle` and `my.locked`).

- [ ] **Step 3: Typecheck + full lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/training/page.tsx" "src/app/get-started/training/page.tsx"
git commit -m "feat(training): hide the makeup quiz until the in-person session has passed"
```

---

## Final verification

- [ ] **Run the affected suites**

Run: `npx vitest run src/modules/recruitment/services/makeup-window.test.ts src/modules/recruitment/services/training.test.ts`
Expected: PASS.

- [ ] **Full typecheck + lint (pre-push gate)**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Manual smoke (optional, if a dev DB is available):** set an in-person date in the future on a training cycle; as a member, `/training` shows "attend the in-person session on [date]" with no quiz; move the date to the past; the quiz appears and submits. Clear the date; the quiz is available with no gate (as today).
