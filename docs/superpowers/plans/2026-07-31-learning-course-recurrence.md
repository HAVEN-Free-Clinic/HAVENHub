# Per-Term Course Recurrence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the learning gate answer per term for courses that should recur, and leave every existing course behaving exactly as it does today until someone deliberately changes it.

**Architecture:** `Course.recurrence` (`ONCE | PER_TERM`, default `ONCE`) plus `termId` on `CourseProgress` and `ScoProgress`, mirroring `Training`. Readers scope by term for `PER_TERM` courses only. Existing rows are backfilled to the term containing their `completedAt`.

**Tech Stack:** Prisma, Postgres, Next.js App Router, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-31-learning-course-recurrence-design.md`. Read it fully before Task 1, especially the `ScoProgress` trap and the two settled decisions.
- Source finding: PR #474, item **B1** (F-06-12), tier 1, `blocks`.
- **No em-dashes anywhere, in prose or code.** CI enforces this via the `local/no-em-dash` eslint rule.
- **`ONCE` is the default and today's behavior must survive unchanged.** A `ONCE` course completed in a prior term still reads COMPLETE. That is not a nicety; it is the regression bar for the whole change.
- **Flipping a course to `PER_TERM` takes effect from the NEXT term.** A currently-complete volunteer stays complete for the current term. This is Jack's ruling, not an open question.
- Lint with `npx eslint src`. Plain `npm run lint` walks a gitignored design-system directory and produces noise. Run `npm run typecheck` before each commit.
- Tests need Postgres on :5434, **shared with every other worktree**. Check `pgrep -f "vitest run"` first. Do NOT create a Postgres schema to isolate yourself: the schema-guard tests query `pg_indexes` filtered on table name but not schema name, so a second schema breaks them repo-wide.
- `main` carries pre-existing storage and blob-cleanup flakes (`branding/assets`, `my-info` certificate disk writes, blob orphan cleanup). They are not yours. Anything in a file you touched is.
- Copy `.env.local` from another worktree under `.claude/worktrees/`; it is gitignored, never commit it.

## File structure

- Modify: `prisma/schema.prisma` (`Course`, `CourseProgress`, `ScoProgress`, new enum)
- Create: a migration under `prisma/migrations/`
- Modify: `src/modules/learning/services/enrollment.ts` (the SCORM write path and two readers)
- Modify: `src/modules/learning/services/dashboard.ts`, `src/modules/onboarding/services/clearance.ts`, `src/modules/learning/services/packages.ts`
- Modify: the `/learning/manage` course form and the learner course card
- Test: alongside each

---

### Task 1: Schema, migration, and backfill

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_course_recurrence/migration.sql`

**Interfaces:**
- Produces: `Course.recurrence`, `CourseProgress.termId`, `ScoProgress.termId`, and the new unique constraints every later task writes through.

- [ ] **Step 1: Add the enum and columns**

`CourseRecurrence` with `ONCE` and `PER_TERM`. `Course.recurrence` defaults to `ONCE`.

Add `termId` to **both** `CourseProgress` and `ScoProgress`, with the relation to `Term`, mirroring how `Training` does it. Read `Training`'s definition first and follow it rather than inventing a shape.

- [ ] **Step 2: Widen the unique constraints**

`CourseProgress` is `@@unique([personId, courseId])` and must become `@@unique([personId, courseId, termId])`. `ScoProgress` is `@@unique([personId, courseId, scoId])` and must become `@@unique([personId, courseId, scoId, termId])`.

**This is the highest-risk edit in the branch.** The generated Prisma compound-key identifier changes name (`personId_courseId` becomes `personId_courseId_termId`), and the SCORM runtime writes through it by name at `enrollment.ts:327` and `:346`. Task 2 owns those call sites; expect typecheck to fail there until it lands, and say so in your report rather than reaching into that file.

- [ ] **Step 3: Write the backfill**

Existing rows get the term containing their `completedAt`.

**Rows with a null `completedAt` need an explicit rule, and the spec deliberately leaves the choice to you.** They are IN_PROGRESS attempts with no completion date to locate a term by. Pick one of: the person's active term at migration time, the term whose date range contains `createdAt` if the model has one, or leaving `termId` null. **State which you chose and why in your report.** A wrong choice silently strands a half-finished attempt in a term the person is not in.

If `termId` ends up nullable, say explicitly what null means to readers, because Task 3 has to honor it.

Follow the repo's migration conventions. My memory of this codebase: `prisma migrate dev` folds prior drift into a new migration, so inspect the generated SQL and trim anything unrelated before committing.

- [ ] **Step 4: Verify the migration applies cleanly**

```bash
TDB="postgresql://haven:haven_dev@localhost:5434/havenhub_test"
DATABASE_URL="$TDB" DATABASE_URL_UNPOOLED="$TDB" npx prisma migrate deploy
```

Then `npx prisma generate`.

- [ ] **Step 5: Commit**

```bash
npm run typecheck 2>&1 | tail -20
```

Typecheck **will fail** in `enrollment.ts` at the two compound-key sites, and nowhere else. If it fails anywhere else, report that instead of fixing it. Commit anyway; Task 2 closes it.

```bash
git add -A prisma
git commit -m "feat(learning): add per-term course recurrence columns"
```

---

### Task 2: The SCORM write path, and the latch that would make this inert

**Files:**
- Modify: `src/modules/learning/services/enrollment.ts` (the commit path, from roughly `:300`)
- Test: `src/modules/learning/services/enrollment.test.ts`

**Interfaces:**
- Consumes: Task 1's new keys.

**Read the spec's section 2 before writing anything.** This is the task where the feature either works or silently does not.

- [ ] **Step 1: Understand both latches before editing**

`enrollment.ts:327-334` reads the existing `CourseProgress` and latches completion: "a completed course never reverts on a later commit." There is a second, per-SCO latch on `ScoProgress`.

Once both tables are keyed per term, both latches naturally follow the current term's rows, which is the intended behavior. **Confirm that is actually true in the code rather than assuming it**, and write down in your report what makes it true.

The failure mode to avoid: a `PER_TERM` course reopens next term, the SCO rows from the prior term still report "completed", the rollup recomputes the course as complete, and the fresh `CourseProgress` row is created already-COMPLETE. Every course-level test would still pass. **The feature would ship inert.**

- [ ] **Step 2: Thread the term through the write path**

The commit path needs the term the attempt belongs to. Work out where it comes from (the SCORM runtime's session, the active term, or the caller) and say which you chose. Do not guess: an attempt written against the wrong term is worse than the current bug, because it would clear a gate for a term the person never worked in.

- [ ] **Step 3: The test that proves it is not inert**

```
- a PER_TERM course whose ScoProgress rows are all complete from a PRIOR term
  does not auto-complete in the new term
```

Write this one first and watch it fail before you make it pass. It is the single most important test on the branch, and it is the one that a course-level-only test suite cannot catch.

Then:

```
- a PER_TERM course completed in a prior term reads NOT COMPLETE in the new term
- a ONCE course completed in a prior term still reads COMPLETE (today's behavior)
- committing an attempt writes rows carrying the current term
```

- [ ] **Step 4: Commit**

```bash
npx eslint src && npm run typecheck
TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test" npx vitest run src/modules/learning
git add -A src
git commit -m "fix(learning): key SCORM progress by term so a recurring course reopens"
```

---

### Task 3: Every reader, scoped consistently

**Files:**
- Modify: `src/modules/learning/services/enrollment.ts` (`getMyCourses` at `:110-121`, the rollup at `:160`)
- Modify: `src/modules/onboarding/services/clearance.ts:128-133`
- Modify: `src/modules/learning/services/dashboard.ts:56`, `:97`
- Modify: `src/modules/learning/services/packages.ts:167`

**Interfaces:**
- Consumes: Tasks 1 and 2.

- [ ] **Step 1: Scope by term, for PER_TERM courses only**

`getMyCourses` already receives `termId` and resolves it via `assignedCourseIds`. Its progress query currently filters on `personId` and `courseId` only. Scope it by term **for `PER_TERM` courses**, and leave `ONCE` courses unscoped so their behavior is untouched.

- [ ] **Step 2: Do the same for clearance, and prove the two agree**

`clearance.ts` already has `termId` in scope (`:45`), so this is mechanical. But it is the reader that must not diverge: it feeds the schedule builder's clearance map, and the whole reason learning takes a term id today is so the checklist and that map agree for a given term.

**Write a test that asserts the two against each other**, for the same person and term, for both recurrence values. Not two independent tests: one test comparing them. If one becomes term-aware and the other does not, this change creates exactly the contradiction it exists to remove.

- [ ] **Step 3: Handle the remaining three deliberately**

`dashboard.ts:56` is a director's per-course roster; work out whether it has a term in scope and what it should show if not. `dashboard.ts:97` and `packages.ts:167` are **deletes** (`deleteMany` on `personId`/`courseId`), which are a different question: does resetting a learner clear every term's rows or only the current one? Decide, say why, and note that a reset that wipes history destroys a compliance artifact.

- [ ] **Step 4: Commit**

```bash
npx eslint src && npm run typecheck
TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test" npx vitest run src/modules/learning src/modules/onboarding
git add -A src
git commit -m "fix(learning): scope progress reads by term for recurring courses"
```

---

### Task 4: Make the setting visible to both sides

**Files:**
- Modify: the `/learning/manage` course form
- Modify: the learner course card

- [ ] **Step 1: The director's control**

Add recurrence to the course form. **The copy must say the change takes effect next term**, because that is the ruling and a director who expects it to apply immediately will think it is broken.

- [ ] **Step 2: The learner's card**

Render "Retake each term" on a `PER_TERM` course, so the person it affects can see it rather than only the director who set it.

- [ ] **Step 3: Verify in a browser if you can reach it**

If assembling the state costs more than a few minutes, say so and rely on the unit tests. Do not leave a dev server running.

- [ ] **Step 4: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "feat(learning): surface course recurrence to directors and learners"
```

---

### Task 5: Whole-branch check

- [ ] **Step 1: Prove today's behavior survived**

The regression bar: a `ONCE` course completed in a prior term still reads COMPLETE, on every reader. Report per-reader, as a list.

- [ ] **Step 2: Prove the feature is not inert**

Re-state the `ScoProgress` result from Task 2 Step 3 and confirm it still holds at branch HEAD.

- [ ] **Step 3: Full suite, lint, typecheck**

```bash
TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test" npx vitest run
npx eslint src e2e && npm run typecheck
```

Compare failures against the pre-existing storage and blob flakes named in the Global Constraints.

- [ ] **Step 4: Check the e2e suite**

Playwright cannot run locally. Read the learning specs and report whether any assert on a completion that this change now scopes by term. **Report; do not edit specs speculatively.**

---

## Self-review notes

**Spec coverage.** Spec section 1 (schema) is Task 1. Section 2 (the latches and the `ScoProgress` trap) is Task 2. Section 3 (readers) is Task 3. Section 4 (backfill) is Task 1 Step 3. Section 5 (surfaces) is Task 4. The spec's testing list is distributed across Tasks 2, 3, and 5, with the "ships inert" case appearing twice on purpose: as the first test written in Task 2 and as a branch-level re-check in Task 5.

**Ordering.** Task 1 first because everything keys off the new constraints, and it deliberately leaves typecheck failing at two known sites. Task 2 before Task 3 because a reader scoped by term is meaningless while the writer still latches across terms. Task 4 is independent once the model exists.

**Task 1 leaves a known-broken intermediate**, bounded to two call sites named by file and line, with an instruction to report any other failure rather than fix it. The alternative was folding the SCORM rewrite into the migration task, which would have put the riskiest edit in the branch behind the same review gate as a column addition.

**Four steps hand a judgment call to the implementer with the information to settle it:** Task 1 Step 3 (the null-`completedAt` backfill rule), Task 2 Step 2 (where the term for an attempt comes from), Task 3 Step 3 (whether a reset clears one term or all), and Task 4 Step 3 (whether browser verification is worth the setup).

**Not covered: deadlines for recurring courses.** That is B4 and the spec scopes it out.
