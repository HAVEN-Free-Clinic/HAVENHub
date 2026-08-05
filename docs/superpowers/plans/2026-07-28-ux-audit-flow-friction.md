# UX Flow-Friction Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a ranked, ~~capped,~~ actionable backlog of experience problems in HAVEN Hub, weighted toward volunteers and applicants, ending in a committed audit document and a batch recommendation. *(Cap retired 2026-07-29; see "File structure" below and Task 12 Step 4.)*

**Architecture:** Bring up a local environment, enrich the seed to reach realistic states, walk ten tier-1 journeys in a browser recording findings into per-task fragment files, code-read tier-2 surfaces into more fragments, then rank and assemble everything into one document. Fragments keep each task independently reviewable and mean a rejected task does not invalidate its neighbors.

**Tech Stack:** Next.js App Router, Prisma, the native Postgres already listening on port 5434, NextAuth credentials login for local persona switching, Playwright MCP for the journey walks.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-ux-audit-flow-friction-design.md`. Read it before Task 1.
- No em-dashes anywhere, in prose or code. CI enforces this via the `local/no-em-dash` eslint rule.
- Finding cap is 40. Cuts are reported with count and subject, never silent.
- Ranking is severity times reach. A tier-1 "costs time" finding outranks a tier-2 "blocks" finding.
- Every finding names an observed consequence and a concrete fix. No "consider improving X".
- Out of scope: accessibility, contrast, and token-drift classes already burned down in the 2026-07-11 and 2026-07-17 audits.
- `prisma/seed.ts` is never modified. All fixture state goes in a separate script.
- **Database:** do NOT use Docker. A native Postgres already listens on port 5434 with role `haven` / password `haven_dev`, hosting the repo's per-worktree databases. This audit uses a dedicated database named `havenhub_uxaudit` on that instance. Never point at Neon.
- **Browser:** journey walks use Playwright MCP (`mcp__plugin_playwright_playwright__*`). The Chrome extension is not connected and must not be relied on.
- **Dev server lifecycle:** the controller session owns `npm run dev`. A subagent's background process does NOT survive its session, so no task can leave a server running for the next one. Before any browser work, verify the server with `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/login`, expecting `200`. If it is anything else, report NEEDS_CONTEXT and let the controller restart it. Do not start your own long-lived server.
- **Findings fragments are committed** to `docs/superpowers/audit-fragments/task-NN.md`, so every task produces a reviewable diff. Task 12 assembles them and deletes the directory in the same commit.
- Screenshots stay in the scratchpad and are never committed. Scratchpad root: `/private/tmp/claude-501/-Users-jcarney-Documents-Code-Projects-HAVENHub/50998891-9679-4045-b1d6-1284b4bcae24/scratchpad`
- Lint with `npx eslint src e2e` while iterating. Plain `npm run lint` walks a gitignored design-system directory and produces noise.

## Finding fragment format

Every journey and code-read task appends findings to its own committed fragment file at `docs/superpowers/audit-fragments/task-NN.md`, as a markdown table row. Task 12 concatenates, ranks, and then deletes the directory. One row per finding:

```markdown
| id | surface | lens | severity | reach | what is wrong | concrete fix | effort |
```

- `id`: `F-<task number>-<counter>`, for example `F-04-3`.
- `surface`: journey and step for tier 1, `file:line` for tier 2.
- `lens`: `flow`, `visual`, or `ia`.
- `severity`: `blocks`, `costs-time`, or `polish`.
- `reach`: who hits it and how often, in a short phrase, for example "every applicant, once per cycle".
- `what is wrong`: one or two sentences describing observed behavior, not a heuristic.
- `concrete fix`: what to change, specifically enough to implement.
- `effort`: `S` under an hour, `M` half a day, `L` multi-day.

Findings marked `L` also get a line in the fragment's "Needs its own brainstorm" section and are excluded from the shippable backlog.

## File structure

> **Completed 2026-07-29.** The plan below is kept as written for the record. Two things about it
> are now historical rather than current:
>
> - `docs/superpowers/audit-fragments/` no longer exists. All ten fragments were consolidated into
>   the deliverable and removed in commit `140b588b`, as Task 12 specified. Every reference to that
>   directory below describes what the tasks did at the time, not a path you will find on disk.
> - The deliverable shipped as `docs/full-app-ux-audit-2026-07-29.md`, dated to the day it was
>   assembled rather than the day this plan was written. The filename is corrected throughout.
>
> The finding cap named at line 15 was also retired by explicit user decision before Task 12 ran;
> no findings were cut and there is no cut list. See the deliverable's "How the count reconciles".

- Create: `scripts/seed-ux-audit-fixtures.ts` (committed, idempotent, dev-only fixture builder)
- Create: `docs/superpowers/audit-fragments/task-NN.md` (committed per task, deleted by Task 12)
- Create: `docs/full-app-ux-audit-2026-07-29.md` (the deliverable)
- Scratchpad only, never committed: `screenshots/`

---

### Task 1: Bring up the local environment

This is the gate. Every tier-1 task depends on it. If it cannot be completed, stop and report rather than silently degrading the audit to code reading.

Docker is NOT used. A native Postgres already listens on 5434 with role `haven` and password `haven_dev`. `npm run db:up` would fail to bind the port and must not be run.

**Files:**
- Create: `.env.local` entries pointing at the audit database (this file is gitignored)
- Create: `docs/superpowers/audit-fragments/task-01.md`

**Interfaces:**
- Produces: a dev server on `http://localhost:3000` backed by database `havenhub_uxaudit`, and confirmation that credential login works for all three seeded personas.

- [ ] **Step 1: Create the audit database**

```bash
PGPASSWORD=haven_dev createdb -h localhost -p 5434 -U haven havenhub_uxaudit
PGPASSWORD=haven_dev psql -h localhost -p 5434 -U haven -d havenhub_uxaudit -c "select current_database();"
```

Expected: prints `havenhub_uxaudit`. If the database already exists, `createdb` errors and that is fine; the `psql` check is what must pass.

- [ ] **Step 2: Point the app at it**

Read the existing `.env.local` first, then set both variables to the audit database. Prisma needs both; the unpooled URL is used by migrations.

```
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_uxaudit
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub_uxaudit
```

Verify the app is not pointed at Neon before continuing:

```bash
grep -E "DATABASE_URL" .env.local
```

Expected: both lines contain `localhost:5434/havenhub_uxaudit` and neither contains `neon.tech`.

- [ ] **Step 3: Apply migrations and seed**

```bash
npx prisma migrate deploy
npm run db:seed
```

Expected: migrations report as applied, seed prints `Seed complete.`

If `migrate deploy` reports drift, do not run `migrate dev`. That folds prior drift into a new migration. Report the drift instead.

If the Prisma client is stale (a P2011 or unknown-column error), run `npx prisma generate` and retry once.

- [ ] **Step 4: Confirm the dev server is serving**

The controller session owns the dev server, because a subagent's background process does not survive its session. Do not start a long-lived server yourself.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/login
```

Expected: `200`. If it is anything else, report NEEDS_CONTEXT so the controller can start it, then continue once it is up.

- [ ] **Step 5: Verify credential login for all three seeded personas**

Using Playwright MCP, navigate to `http://localhost:3000/login`. The page shows a "Local development" email form below the SSO button because `NODE_ENV !== "production"`.

Sign in as each of `j.carney@yale.edu`, `dev.director@yale.edu`, and `dev.volunteer@yale.edu` in turn, recording the landing URL for each.

Expected: each lands on the dashboard, not `/get-started`, because the seed gives all three a verified HIPAA cert and the director and volunteer a phone.

If any lands on `/get-started`, the seed did not complete; re-run Step 3.

- [ ] **Step 6: Record the environment state and commit**

Write into `docs/superpowers/audit-fragments/task-01.md`: the database name, the migration count applied, the three landing URLs, and the dev server port. Later tasks read this to know what already exists.

```bash
git add docs/superpowers/audit-fragments/task-01.md
git commit -m "docs(audit): record verified local environment state"
```

`.env.local` is gitignored and must not be committed. Confirm with `git status --short` before committing.

---

### Task 2: Baseline the seeded state and produce the fixture gap table

The seed creates three people and almost nothing else. This task establishes exactly what is missing per journey so Task 3 builds only what is needed.

**Files:**
- Create: `docs/superpowers/audit-fragments/task-02.md`

**Interfaces:**
- Consumes: the running environment from Task 1.
- Produces: a gap table mapping each of the ten tier-1 journeys to the database state it requires and whether that state exists.

- [ ] **Step 1: Query the current row counts**

```bash
npx prisma studio
```

Or, preferred for a recordable result, run a one-off script:

```bash
npx tsx --env-file=.env -e '
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const counts = {
  person: await p.person.count(),
  termMembership: await p.termMembership.count(),
  hipaaCertificate: await p.hipaaCertificate.count(),
  recruitmentCycle: await p.recruitmentCycle.count(),
  applicant: await p.applicant.count(),
  application: await p.application.count(),
  acceptance: await p.acceptance.count(),
  course: await p.course.count(),
  courseProgress: await p.courseProgress.count(),
  shiftAssignment: await p.shiftAssignment.count(),
  shiftRequest: await p.shiftRequest.count(),
  incidentReport: await p.incidentReport.count(),
  techRequest: await p.techRequest.count(),
  notification: await p.notification.count(),
  training: await p.training.count(),
  onboardingContract: await p.onboardingContract.count(),
};
console.log(JSON.stringify(counts, null, 2));
await p.$disconnect();
'
```

Expected: `person: 3`, `hipaaCertificate: 3`, and zero or near-zero for everything from `recruitmentCycle` onward.

- [ ] **Step 2: Write the gap table**

For each of the ten tier-1 journeys in the spec, record: the journey, the database state it needs to be walkable, whether that state exists, and whether it can be created locally at all.

Three journeys are known in advance to be partially blocked, per the spec. Record them as such rather than rediscovering:

- Magic-link login depends on queued email delivery drained by `/api/cron/email`. The token can be read from `MemberLoginToken` or `ApplicantPortalToken` directly instead.
- SCORM package upload depends on Blob storage plus a real package zip.
- Yale SSO does not exist locally. Credential login substitutes.

- [ ] **Step 3: Commit the fragment**

```bash
git add docs/superpowers/audit-fragments/task-02.md
git commit -m "docs(audit): record task 02 findings"
```

Screenshots stay in the scratchpad and are never added.

---

### Task 3: Build the audit fixture script

**Files:**
- Create: `scripts/seed-ux-audit-fixtures.ts`

**Interfaces:**
- Consumes: the gap table from Task 2.
- Produces: an idempotent script creating the fixture personas and states listed below. Later journey tasks assume these exist by exactly these emails and slugs.

**Fixture contract.** These names are relied on by Tasks 4 through 8. Do not rename them.

| Fixture | Identifier | Needed by |
|---|---|---|
| Fresh volunteer, no cert, no phone | `ux.fresh@yale.edu` | Journey 3 (get-started gate), Journey 4 (compliance) |
| Volunteer with unverified cert | `ux.pending@yale.edu` | Journey 4 (verification-pending state) |
| Open recruitment cycle, default form | slug `ux-audit-cycle` | Journey 1 (apply) |
| Applicant with a half-finished draft | `ux.applicant@yale.edu` | Journey 1 (resume draft) |
| Accepted applicant, onboarding pending | `ux.accepted@yale.edu` | Journey 2 (onboard) |
| Course assigned to VADM, package actually ingested | title `UX Audit Course` | Journey 5 (learning) |
| Designated training cycle so `/training` renders | per Task 2's gap table | Journey 5 (training quiz) |
| Published shift assignments for `dev.volunteer@yale.edu` | across SU26 Saturdays | Journey 6 (schedule) |
| One incident report, one tech request, three notifications for `dev.volunteer@yale.edu` | n/a | Journeys 7, 8, 10 |

Two corrections from Task 2's gap analysis, which supersedes this table where they disagree:

- The course fixture is not satisfied by a bare `Course` row. `coursesForMember` requires `hasPackage`, so a package-less course is excluded from the learner's list and Journey 5 would show an empty state instead of a course. The package must actually be ingested.
- Blob storage is NOT required locally. `src/platform/storage.ts:22` falls back to disk when `BLOB_READ_WRITE_TOKEN` is unset, and the manage page renders a plain server-action upload form in that case. The only real obstacle to the SCORM journey is sourcing a valid package zip.

- [ ] **Step 1: Read the service entry points before writing any Prisma calls**

Prefer existing service functions over raw Prisma writes, so fixtures go through the same validation real users do. Read these files first:

- `src/modules/recruitment/services/cycles.ts` for `createCycle(input: CreateCycleInput, seedDefaultForm = false)`. `CreateCycleInput` is `{ track, termId, title, publicSlug, departments, acceptsRenewals, createdById }`. Pass `seedDefaultForm = true` so the cycle gets the full default template rather than the minimal three-field identity seed.
- `src/modules/recruitment/services/submissions.ts` for `submitApplication(slug, input)`. Read the `SubmitInput` type at the top of the file.
- `src/modules/recruitment/services/drafts.ts` for `saveDraft`, used for the half-finished draft fixture.
- `src/modules/learning/services/courses.ts` for the course creation entry point, and `packages.ts` for package ingestion (the course needs `hasPackage` true or the learner list excludes it).
- `src/modules/schedule/services/builder.ts` and `publication.ts` for creating and publishing shift assignments.
- The interview-decision and onboarding services for the `ux.accepted@yale.edu` fixture. Task 2's gap table names the exact files; read it first at `docs/superpowers/audit-fragments/task-02.md`, which supersedes this list where they disagree.

Where no service function exists for a fixture, write the Prisma create directly against the model definition in `prisma/schema.prisma`.

- [ ] **Step 2: Write the script with an idempotency guard**

Mirror the seed's style: upsert by a natural key, skip when the row already exists. The script must be safe to run repeatedly, because journey tasks will re-run it after resetting state.

Open the file with a header comment stating it is a dev-only audit fixture builder, that it is not part of `prisma db seed`, and that it may be deleted once the audit ships.

- [ ] **Step 3: Add an npm script**

In `package.json` scripts, add:

```json
"fixtures:ux": "tsx --env-file=.env scripts/seed-ux-audit-fixtures.ts"
```

- [ ] **Step 4: Run it**

```bash
npm run fixtures:ux
```

Expected: completes without error and prints a summary line per fixture created or skipped.

- [ ] **Step 5: Run it a second time to prove idempotency**

```bash
npm run fixtures:ux
```

Expected: completes without error, every line reports skipped rather than created.

- [ ] **Step 6: Verify the fixtures are reachable in the UI**

Sign in as `ux.fresh@yale.edu`. Expected: redirected to `/get-started`, because this person has no HIPAA cert and no phone.

Navigate to `http://localhost:3000/apply/ux-audit-cycle`. Expected: the application form renders with the default template sections, not a 404.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint scripts/seed-ux-audit-fixtures.ts
npm run typecheck
git add scripts/seed-ux-audit-fixtures.ts package.json
git commit -m "chore: add dev-only fixture builder for the UX audit"
```

---

### Task 4: Walk the applicant journeys

Covers spec journeys 1 (applicant applies) and 2 (accepted applicant onboards). These are grouped because they share the applicant persona and run back to back in reality.

**Files:**
- Create: `docs/superpowers/audit-fragments/task-04.md`

**Interfaces:**
- Consumes: fixtures `ux-audit-cycle`, `ux.applicant@yale.edu`, `ux.accepted@yale.edu` from Task 3.
- Produces: findings rows in the standard fragment format.

- [ ] **Step 1: Walk the cold apply path**

Open `http://localhost:3000/apply` signed out. Proceed through: landing, sign-in, wizard section by section, conditional questions, file upload, signature, review, submit, status tracker.

At every step record: how many clicks the step took, whether the next action was obvious without reading carefully, whether anything was lost on back-navigation, and whether the app confirmed what just happened.

Screenshot each distinct screen into `scratchpad/screenshots/j1-<step>.png`.

- [ ] **Step 2: Walk the resume-draft path**

Sign in as `ux.applicant@yale.edu` and resume the half-finished draft. Specifically test: does the wizard return to the step they left, is saved work visibly saved, and is there any indication of progress remaining.

- [ ] **Step 3: Walk the onboarding path**

Sign in as `ux.accepted@yale.edu`. Walk the onboarding contract: blocks, agreements, signature, Epic provisioning, completion. Record specifically what the app tells the user to do next after completion. The spec calls this out as the archetypal flow-friction failure.

- [ ] **Step 4: Record findings**

Write every finding into `docs/superpowers/audit-fragments/task-04.md` using the fragment format. Include a short "coverage notes" section stating which steps could not be walked and why.

- [ ] **Step 5: Commit the fragment**

```bash
git add docs/superpowers/audit-fragments/task-04.md
git commit -m "docs(audit): record task 04 findings"
```

Screenshots stay in the scratchpad and are never added.

---

### Task 5: Walk new-volunteer entry and compliance

Covers spec journeys 3 (first login) and 4 (clear compliance).

**Files:**
- Create: `docs/superpowers/audit-fragments/task-05.md`

**Interfaces:**
- Consumes: fixtures `ux.fresh@yale.edu` and `ux.pending@yale.edu` from Task 3.

- [ ] **Step 1: Walk the get-started gate as a brand-new volunteer**

Sign in as `ux.fresh@yale.edu`. Expected: the blocking `/get-started` gate. Walk it to completion.

Record: does the gate explain why it is blocking, is the finish line visible, and where does the user land afterward.

- [ ] **Step 2: Read the dashboard as a first-time user**

On the dashboard, evaluate the "Your status" clearance card and the ranked action feed. The specific question: after ten seconds of looking, is it clear what to do first.

- [ ] **Step 3: Walk certificate upload**

From the dashboard action card, go to `/my-info` and upload a HIPAA certificate. Record the feedback the app gives on success, which is directly relevant to the pre-seeded toast finding.

- [ ] **Step 4: Inspect the verification-pending state**

Sign in as `ux.pending@yale.edu`. Record whether the user can tell that their certificate is awaiting manager verification, and whether they can tell what happens next or how long it takes.

- [ ] **Step 5: Record findings into `docs/superpowers/audit-fragments/task-05.md`**

- [ ] **Step 6: Commit the fragment**

```bash
git add docs/superpowers/audit-fragments/task-05.md
git commit -m "docs(audit): record task 05 findings"
```

Screenshots stay in the scratchpad and are never added.

---

### Task 6: Walk learning and training

Covers spec journey 5.

**Files:**
- Create: `docs/superpowers/audit-fragments/task-06.md`

**Interfaces:**
- Consumes: fixture course `UX Audit Course` and the designated training cycle from Task 3.

**Persona note, corrected after Task 3.** Assigning a course and designating a training cycle add BLOCKING onboarding tasks to every matching volunteer. To keep `dev.volunteer@yale.edu` usable for Journeys 6 through 10, the fixture script marks that persona's training and course COMPLETE. Consequently `dev.volunteer@yale.edu` sees a completed state, not a from-zero one. Walk the completed state as that persona, and walk the from-zero state as `ux.fresh@yale.edu` through the gate routes named below.

- [ ] **Step 1: Walk the course list as a member who has finished**

Sign in as `dev.volunteer@yale.edu`, go to `/learning`. Record whether assigned courses, their deadlines, and their completion state are legible at a glance.

- [ ] **Step 2: Walk the SCORM player**

Blob storage is NOT a blocker locally. Task 2 verified the disk fallback at `src/platform/storage.ts:22` and Task 3 confirmed the player loads and completes the `LMSGetValue` handshake. Walk it, do not code-read it.

Walk the from-zero player as `ux.fresh@yale.edu` at `/get-started/learning`. Record whether a first-time learner can tell what the course expects, how long it will take, and whether progress is saved if they leave.

- [ ] **Step 3: Walk the training quiz from zero**

As `ux.fresh@yale.edu`, go to `/get-started/training?track=volunteer`. This is the same `TrainingQuiz` component the `(app)/training` route renders, so findings transfer. Do NOT use `dev.volunteer@yale.edu` here: that persona shows "Cleared for the term" and has no quiz to take.

The quiz is 15 questions and needs 80 percent to pass. Walk both paths. Record the failure path specifically: what a user sees when they fail, and whether the makeup gating (which depends on a per-cycle in-person training date) explains itself.

- [ ] **Step 4: Record findings into `docs/superpowers/audit-fragments/task-06.md`**

- [ ] **Step 5: Commit the fragment**

```bash
git add docs/superpowers/audit-fragments/task-06.md
git commit -m "docs(audit): record task 06 findings"
```

Screenshots stay in the scratchpad and are never added.

---

### Task 7: Walk the schedule

Covers spec journey 6.

**Files:**
- Create: `docs/superpowers/audit-fragments/task-07.md`

**Interfaces:**
- Consumes: published shift assignments for `dev.volunteer@yale.edu` from Task 3.

- [ ] **Step 1: Read "My schedule"**

Sign in as `dev.volunteer@yale.edu`, go to `/schedule`. Record whether the next shift is immediately obvious, and whether past and future shifts are distinguishable without reading dates carefully.

- [ ] **Step 2: Read the full schedule**

Go to `/schedule/full`. This is a dense table. Evaluate scannability, and whether a volunteer can find their own name without searching manually.

- [ ] **Step 3: File a shift request**

Go to `/schedule/requests` and submit a request. Record the confirmation behavior and whether the request's state is legible afterward.

- [ ] **Step 4: Record findings into `docs/superpowers/audit-fragments/task-07.md`**

- [ ] **Step 5: Commit the fragment**

```bash
git add docs/superpowers/audit-fragments/task-07.md
git commit -m "docs(audit): record task 07 findings"
```

Screenshots stay in the scratchpad and are never added.

---

### Task 8: Walk the service surfaces

Covers spec journeys 7 (incidents), 8 (support), 9 (clinic AVS), and 10 (notifications). Grouped because each is short.

**Files:**
- Create: `docs/superpowers/audit-fragments/task-08.md`

**Interfaces:**
- Consumes: the incident report, tech request, and notifications fixtures from Task 3.

- [ ] **Step 1: Walk incident reporting**

Go to `/incidents` as `dev.volunteer@yale.edu`, file a concern, then check `/incidents/mine`. This flow carries emotional weight; record specifically whether the form makes clear who will see the report and what happens next.

- [ ] **Step 2: Walk the support request flow**

Go to `/support/new`, submit a request, then `/support`. Record confirmation behavior and status legibility.

- [ ] **Step 3: Walk the AVS generator**

Go to `/clinic/avs`. Generate a summary in English, then in Spanish. Record whether the language switch is discoverable and whether the output is obviously correct before printing.

- [ ] **Step 4: Walk notifications**

Open the bell, then `/notifications`. Record whether read and unread are distinguishable and whether notifications lead anywhere useful.

- [ ] **Step 5: Check the empty states**

Sign in as `dev.director@yale.edu` and visit `/incidents/mine`, `/support`, and `/notifications` with no rows. Empty states are first-run experience and are in scope.

Do NOT use `ux.fresh@yale.edu` here. Task 2 established that an uncleared person is redirected to `/get-started` from every path outside `ONBOARDING_ALLOWLIST` (`src/platform/auth/onboarding-allowlist.ts:18`), so that persona can never reach these three pages. `dev.director@yale.edu` is cleared and the fixture script gives it no incident, tech request, or notification rows, so its empty states are genuine.

- [ ] **Step 6: Record findings into `docs/superpowers/audit-fragments/task-08.md`**

- [ ] **Step 7: Commit the fragment**

```bash
git add docs/superpowers/audit-fragments/task-08.md
git commit -m "docs(audit): record task 08 findings"
```

Screenshots stay in the scratchpad and are never added.

---

### Task 9: Code-read recruitment management and the schedule builder

Tier 2. Lower depth: structural flow, hierarchy, and IA only. Do not sweep for accessibility or token drift.

**Files:**
- Create: `docs/superpowers/audit-fragments/task-09.md`

- [ ] **Step 1: Read the recruitment management surfaces**

Read, in this order: `src/app/(app)/recruitment/cycles/[id]/page.tsx`, `builder/form-builder.tsx`, `speed-route/page.tsx`, `decisions/page.tsx`, `applicants/[applicationId]/page.tsx`, `emails/[key]/page.tsx`, `onboarding/page.tsx`, and `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx`.

For each, ask: is the primary action on this page obvious from its layout, does the page tell the user where they are in a multi-step process, and does anything require knowledge held outside the app.

- [ ] **Step 2: Read the schedule builder and attendings**

Read `src/app/(app)/schedule/builder/page.tsx` and `src/app/(app)/schedule/attendings/`. The builder is the largest page in the app; note specifically whether its size reflects genuine complexity or accumulated structure.

- [ ] **Step 3: Record findings into `docs/superpowers/audit-fragments/task-09.md`, citing `file:line`**

- [ ] **Step 4: Commit the fragment**

```bash
git add docs/superpowers/audit-fragments/task-09.md
git commit -m "docs(audit): record task 09 findings"
```

Screenshots stay in the scratchpad and are never added.

---

### Task 10: Code-read volunteers, incidents, support, and learning management

**Files:**
- Create: `docs/superpowers/audit-fragments/task-10.md`

- [ ] **Step 1: Read the volunteers surfaces**

`/volunteers` compliance, `/volunteers/master`, `/volunteers/ehs`, `/volunteers/spanish-review`, `/volunteers/offboarding` under `src/app/(app)/volunteers/`.

- [ ] **Step 2: Read incidents review and strikes**

`src/app/(app)/incidents/review/` and `src/app/(app)/incidents/strikes/`.

- [ ] **Step 3: Read support management**

`src/app/(app)/support/all/`, `src/app/(app)/support/epic/`, and `src/modules/support/components/epic-request-form.tsx`. The silent-clipboard finding at line 495 of the latter is already pre-seeded in the spec; confirm it still reproduces and note the line if it has moved.

- [ ] **Step 4: Read learning management**

`src/app/(app)/learning/manage/` and `src/app/(app)/learning/dashboard/`.

- [ ] **Step 5: Record findings into `docs/superpowers/audit-fragments/task-10.md`**

- [ ] **Step 6: Commit the fragment**

```bash
git add docs/superpowers/audit-fragments/task-10.md
git commit -m "docs(audit): record task 10 findings"
```

Screenshots stay in the scratchpad and are never added.

---

### Task 11: Code-read the admin module

**Files:**
- Create: `docs/superpowers/audit-fragments/task-11.md`

- [ ] **Step 1: Read all eleven admin pages**

Under `src/app/(app)/admin/`: overview, people, terms, roles, departments, subcommittees, contract, audit, email, notifications, settings.

The IA lens matters most here. Eleven flat nav items is a lot; record whether the grouping matches how the work is actually done, and whether any page is findable only by someone who already knows it exists.

- [ ] **Step 2: Record findings into `docs/superpowers/audit-fragments/task-11.md`**

- [ ] **Step 3: Commit the fragment**

```bash
git add docs/superpowers/audit-fragments/task-11.md
git commit -m "docs(audit): record task 11 findings"
```

Screenshots stay in the scratchpad and are never added.

---

### Task 12: Rank, ~~cap~~, and write the audit document (cap retired 2026-07-29; see Step 4)

**Files:**
- Create: `docs/full-app-ux-audit-2026-07-29.md`
- Delete: `docs/superpowers/audit-fragments/` (the whole directory, in the same commit)

**Interfaces:**
- Consumes: `docs/superpowers/audit-fragments/task-04.md` through `task-11.md`, plus the coverage notes in `task-01.md` and `task-02.md`.
- Produces: the committed deliverable.

- [ ] **Step 1: Concatenate every fragment and de-duplicate**

```bash
ls docs/superpowers/audit-fragments/
```

Read every fragment. The same underlying problem will appear in more than one journey. Merge those into one finding whose reach is the union, rather than counting it twice.

- [ ] **Step 2: Add the two pre-seeded findings**

From the spec: the toast notification system (staged as two items, system first and inline-Alert migration second) and the bottom-right overlay collision between `HelpLauncher` at `src/platform/ui/help/help-launcher.tsx:106` and the inactivity warning at `src/platform/auth/inactivity.tsx:62`.

Both were re-verified by the controller on 2026-07-29 and still reproduce: those two `fixed` positions still overlap, and no toast component exists anywhere in `src/platform/ui`.

**Do NOT file the "Copy email" silent no-op.** The spec originally cited it as the motivating example for the client-side toast API. Task 10 verified it was fixed in commit `f007277b` on 2026-07-11, before this audit began: `handleCopyEmail` at `src/modules/support/components/epic-request-form.tsx:157-169` now guards `navigator.clipboard`, awaits the write, and reports both outcomes through an `aria-live` region. Publishing it would ship a fixed bug as a live finding. The toast system item stands on its own without that example.

- [ ] **Step 3: Rank on severity times reach**

Tier-1 findings outrank tier-2 findings at equal severity. Within a tier, `blocks` outranks `costs-time` outranks `polish`.

- [ ] **Step 4: Keep every finding. The cap is retired.**

**Superseded 2026-07-29 by explicit user decision.** The original 40-finding cap and its "Cut for cap" section no longer apply. Do NOT drop findings and do NOT write a cut list.

The cap existed to prevent padding. That job was done better by the per-task review gates: every one of the 87 findings was verified against source by an independent reviewer, several were rejected or re-severitied, one handed-down finding was retracted as already fixed, and one was reproduced from raw database data rather than trusted. Cutting verified findings to honor a number chosen before any of them existed would discard the most expensive part of this work.

Instead, make the document usable at its full length:

- Rank everything by severity times reach, as specified.
- Open with a **"Ship these first"** section: the highest-ranked items whose combined effort fits one focused piece of work. A reader should be able to stop after this section and still act correctly.
- Group the remainder by severity band so the long tail stays skimmable.

- [ ] **Step 5: Split out the L-effort findings**

Move every `L` finding into a "Needs its own brainstorm" appendix. These are not backlog items.

- [ ] **Step 6: Write the document**

Structure: purpose and method, coverage table including what could not be walked and why, the ranked findings, ~~the cut list~~ (retired 2026-07-29, see Step 4), the brainstorm appendix, and a proposed first batch.

The proposed first batch should be the highest-ranked items whose combined effort fits one focused piece of work, with the toast system included since it was the originating request.

- [ ] **Step 7: Verify no em-dashes**

```bash
grep -n "—\|–" docs/full-app-ux-audit-2026-07-29.md || echo "CLEAN"
```

Expected: `CLEAN`.

- [ ] **Step 8: Commit**

The fragments are working notes that the assembled document supersedes. Remove them in the same commit so the branch does not ship two overlapping records of the same findings.

```bash
git rm -r docs/superpowers/audit-fragments
git add docs/full-app-ux-audit-2026-07-29.md
git commit -m "docs: whole-app UX flow-friction audit"
```

Verify the deliverable survived and the fragments are gone:

```bash
git status --short && ls docs/full-app-ux-audit-2026-07-29.md
```

- [ ] **Step 9: Update the audit history memory**

Append a line to `/Users/jcarney/.claude/projects/-Users-jcarney-Documents-Code-Projects-HAVENHub/memory/audit-history.md` recording this as the 12th audit, with the date, the UX flow-friction scope, and the finding count. Do not add a line to `MEMORY.md`; the index memory already covers it.

---

### Task 13: Present the batch for selection

**Files:** none.

- [ ] **Step 1: Summarize the audit to the user**

Report: total findings, the split across the three lenses, ~~how many were cut for the cap~~ (cap retired 2026-07-29; nothing was cut), which journeys had incomplete coverage and why, and the proposed first batch with its combined effort.

- [ ] **Step 2: Ask which batch to ship**

The user picks. That batch gets its own spec and plan per the design document. Do not begin implementation in this session without that selection.

---

## Self-review notes

**Spec coverage.** Every spec section maps to a task: lenses and coverage into Tasks 4 through 11; the finding model into the fragment format and Task 12; the pre-seeded toast and overlay findings into Task 12 Step 2; environment and fixture-gap method into Tasks 1 through 3; the evidence rule into the journey tasks; the deliverable and verification into Task 12.

**Known deviation from the spec.** The spec described the fixture script as throwaway. This plan commits it as `scripts/seed-ux-audit-fixtures.ts` with an npm script, because a reproducible fixture builder is worth more than a scratch file when a follow-up batch needs the same states, and because the journey tasks depend on exact fixture identifiers that must not drift. The header comment marks it deletable once the audit ships.

**Unresolved at plan time.** Task 3 Step 1 directs the implementer to read five service files before writing fixture code. The signatures for `createCycle` and `submitApplication` are verified and stated inline; the learning and schedule entry points are named by file but not by signature, because writing invented field shapes for eight Prisma models would produce confidently wrong code. Reading a named file is a concrete instruction, not a placeholder, but it is the one place this plan defers detail.
