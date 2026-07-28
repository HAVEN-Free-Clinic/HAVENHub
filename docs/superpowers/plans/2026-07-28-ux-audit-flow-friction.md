# UX Flow-Friction Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a ranked, capped, actionable backlog of experience problems in HAVEN Hub, weighted toward volunteers and applicants, ending in a committed audit document and a batch recommendation.

**Architecture:** Bring up a local environment, enrich the seed to reach realistic states, walk ten tier-1 journeys in a browser recording findings into per-task fragment files, code-read tier-2 surfaces into more fragments, then rank and assemble everything into one document. Fragments keep each task independently reviewable and mean a rejected task does not invalidate its neighbors.

**Tech Stack:** Next.js App Router, Prisma, Postgres 16 in Docker on port 5434, NextAuth credentials login for local persona switching, Chrome browser automation for the journey walks.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-ux-audit-flow-friction-design.md`. Read it before Task 1.
- No em-dashes anywhere, in prose or code. CI enforces this via the `local/no-em-dash` eslint rule.
- Finding cap is 40. Cuts are reported with count and subject, never silent.
- Ranking is severity times reach. A tier-1 "costs time" finding outranks a tier-2 "blocks" finding.
- Every finding names an observed consequence and a concrete fix. No "consider improving X".
- Out of scope: accessibility, contrast, and token-drift classes already burned down in the 2026-07-11 and 2026-07-17 audits.
- `prisma/seed.ts` is never modified. All fixture state goes in a separate script.
- Screenshots stay in the scratchpad and are not committed.
- Scratchpad root for fragments and screenshots: `/private/tmp/claude-501/-Users-jcarney-Documents-Code-Projects-HAVENHub/50998891-9679-4045-b1d6-1284b4bcae24/scratchpad`
- Lint with `npx eslint src e2e` while iterating. Plain `npm run lint` walks a gitignored design-system directory and produces noise.

## Finding fragment format

Every journey and code-read task appends findings to its own fragment file as a markdown table row. Task 12 concatenates and ranks them. One row per finding:

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

- Create: `scripts/seed-ux-audit-fixtures.ts` (committed, idempotent, dev-only fixture builder)
- Create: `docs/full-app-ux-audit-2026-07-28.md` (the deliverable)
- Scratchpad only, not committed: `fragments/task-NN.md`, `screenshots/`

---

### Task 1: Bring up the local environment

This is the gate. Every tier-1 task depends on it, and it is the spec's named single point of failure. If it cannot be completed, stop and report rather than silently degrading the audit to code reading.

**Files:** none created or modified.

**Interfaces:**
- Produces: a running dev server on `http://localhost:3000`, a seeded database on port 5434, and confirmation that credential login works.

- [ ] **Step 1: Start Docker and the database**

```bash
open -a Docker
# Wait for the daemon, then:
docker ps
npm run db:up
```

Expected: `docker ps` lists a `postgres:16-alpine` container publishing `5434->5432`.

If Docker Desktop is not installed or will not start, stop here and report. Do not proceed to Task 2.

- [ ] **Step 2: Apply migrations and seed**

```bash
npx prisma migrate deploy
npm run db:seed
```

Expected: migrations report as applied, seed prints `Seed complete.`

If `migrate deploy` reports drift, do not run `migrate dev`. That folds prior drift into a new migration. Report the drift instead.

- [ ] **Step 3: Start the dev server**

```bash
npm run dev
```

Expected: server ready on `http://localhost:3000`.

- [ ] **Step 4: Verify credential login**

Navigate to `http://localhost:3000/login`. The page shows a "Local development" form below the SSO button because `NODE_ENV !== "production"`. Sign in as `dev.volunteer@yale.edu`.

Expected: lands on the dashboard, not `/get-started`, because the seed gives every dev person a verified HIPAA cert and a phone.

Record the observed landing URL. If it is `/get-started`, the seed did not complete; re-run Step 2.

- [ ] **Step 5: Commit nothing, record state**

No commit. Write the confirmed environment state (container id, migration count, landing URL for each of the three seeded emails) into `scratchpad/fragments/task-01.md` as plain notes. Later tasks read this to know what already exists.

---

### Task 2: Baseline the seeded state and produce the fixture gap table

The seed creates three people and almost nothing else. This task establishes exactly what is missing per journey so Task 3 builds only what is needed.

**Files:**
- Create: `scratchpad/fragments/task-02.md`

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

- [ ] **Step 3: Commit nothing**

The gap table is scratchpad-only input to Task 3.

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
| Course assigned to VADM | title `UX Audit Course` | Journey 5 (learning) |
| Published shift assignments for `dev.volunteer@yale.edu` | across SU26 Saturdays | Journey 6 (schedule) |
| One incident report, one tech request, three notifications for `dev.volunteer@yale.edu` | n/a | Journeys 7, 8, 10 |

- [ ] **Step 1: Read the service entry points before writing any Prisma calls**

Prefer existing service functions over raw Prisma writes, so fixtures go through the same validation real users do. Read these files first:

- `src/modules/recruitment/services/cycles.ts` for `createCycle(input: CreateCycleInput, seedDefaultForm = false)`. `CreateCycleInput` is `{ track, termId, title, publicSlug, departments, acceptsRenewals, createdById }`. Pass `seedDefaultForm = true` so the cycle gets the full default template rather than the minimal three-field identity seed.
- `src/modules/recruitment/services/submissions.ts` for `submitApplication(slug, input)`. Read the `SubmitInput` type at the top of the file.
- `src/modules/recruitment/services/drafts.ts` for `saveDraft`, used for the half-finished draft fixture.
- `src/modules/learning/services/courses.ts` for the course creation entry point.
- `src/modules/schedule/services/builder.ts` and `publication.ts` for creating and publishing shift assignments.

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
- Create: `scratchpad/fragments/task-04.md`

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

Write every finding into `scratchpad/fragments/task-04.md` using the fragment format. Include a short "coverage notes" section stating which steps could not be walked and why.

- [ ] **Step 5: No commit**

Fragments are scratchpad-only until Task 12.

---

### Task 5: Walk new-volunteer entry and compliance

Covers spec journeys 3 (first login) and 4 (clear compliance).

**Files:**
- Create: `scratchpad/fragments/task-05.md`

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

- [ ] **Step 5: Record findings into `scratchpad/fragments/task-05.md`**

- [ ] **Step 6: No commit**

---

### Task 6: Walk learning and training

Covers spec journey 5.

**Files:**
- Create: `scratchpad/fragments/task-06.md`

**Interfaces:**
- Consumes: fixture course `UX Audit Course` from Task 3.

- [ ] **Step 1: Walk the course list**

Sign in as `dev.volunteer@yale.edu`, go to `/learning`. Record whether assigned courses, their deadlines, and their completion state are legible at a glance.

- [ ] **Step 2: Attempt the SCORM player**

Open the fixture course. If Blob storage is unavailable locally, the player will not load. Record that as a coverage gap rather than a finding, and code-read `src/app/(app)/learning/[courseId]/ScormPlayer.tsx` for flow and hierarchy issues instead.

- [ ] **Step 3: Walk the training quiz**

Go to `/training`. Walk the quiz. Record the failure path specifically: what a user sees when they fail, and whether the makeup gating (which depends on a per-cycle in-person training date) explains itself.

- [ ] **Step 4: Record findings into `scratchpad/fragments/task-06.md`**

- [ ] **Step 5: No commit**

---

### Task 7: Walk the schedule

Covers spec journey 6.

**Files:**
- Create: `scratchpad/fragments/task-07.md`

**Interfaces:**
- Consumes: published shift assignments for `dev.volunteer@yale.edu` from Task 3.

- [ ] **Step 1: Read "My schedule"**

Sign in as `dev.volunteer@yale.edu`, go to `/schedule`. Record whether the next shift is immediately obvious, and whether past and future shifts are distinguishable without reading dates carefully.

- [ ] **Step 2: Read the full schedule**

Go to `/schedule/full`. This is a dense table. Evaluate scannability, and whether a volunteer can find their own name without searching manually.

- [ ] **Step 3: File a shift request**

Go to `/schedule/requests` and submit a request. Record the confirmation behavior and whether the request's state is legible afterward.

- [ ] **Step 4: Record findings into `scratchpad/fragments/task-07.md`**

- [ ] **Step 5: No commit**

---

### Task 8: Walk the service surfaces

Covers spec journeys 7 (incidents), 8 (support), 9 (clinic AVS), and 10 (notifications). Grouped because each is short.

**Files:**
- Create: `scratchpad/fragments/task-08.md`

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

Sign in as `ux.fresh@yale.edu` and visit `/incidents/mine`, `/support`, and `/notifications` with no rows. Empty states are first-run experience and are in scope.

- [ ] **Step 6: Record findings into `scratchpad/fragments/task-08.md`**

- [ ] **Step 7: No commit**

---

### Task 9: Code-read recruitment management and the schedule builder

Tier 2. Lower depth: structural flow, hierarchy, and IA only. Do not sweep for accessibility or token drift.

**Files:**
- Create: `scratchpad/fragments/task-09.md`

- [ ] **Step 1: Read the recruitment management surfaces**

Read, in this order: `src/app/(app)/recruitment/cycles/[id]/page.tsx`, `builder/form-builder.tsx`, `speed-route/page.tsx`, `decisions/page.tsx`, `applicants/[applicationId]/page.tsx`, `emails/[key]/page.tsx`, `onboarding/page.tsx`, and `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx`.

For each, ask: is the primary action on this page obvious from its layout, does the page tell the user where they are in a multi-step process, and does anything require knowledge held outside the app.

- [ ] **Step 2: Read the schedule builder and attendings**

Read `src/app/(app)/schedule/builder/page.tsx` and `src/app/(app)/schedule/attendings/`. The builder is the largest page in the app; note specifically whether its size reflects genuine complexity or accumulated structure.

- [ ] **Step 3: Record findings into `scratchpad/fragments/task-09.md`, citing `file:line`**

- [ ] **Step 4: No commit**

---

### Task 10: Code-read volunteers, incidents, support, and learning management

**Files:**
- Create: `scratchpad/fragments/task-10.md`

- [ ] **Step 1: Read the volunteers surfaces**

`/volunteers` compliance, `/volunteers/master`, `/volunteers/ehs`, `/volunteers/spanish-review`, `/volunteers/offboarding` under `src/app/(app)/volunteers/`.

- [ ] **Step 2: Read incidents review and strikes**

`src/app/(app)/incidents/review/` and `src/app/(app)/incidents/strikes/`.

- [ ] **Step 3: Read support management**

`src/app/(app)/support/all/`, `src/app/(app)/support/epic/`, and `src/modules/support/components/epic-request-form.tsx`. The silent-clipboard finding at line 495 of the latter is already pre-seeded in the spec; confirm it still reproduces and note the line if it has moved.

- [ ] **Step 4: Read learning management**

`src/app/(app)/learning/manage/` and `src/app/(app)/learning/dashboard/`.

- [ ] **Step 5: Record findings into `scratchpad/fragments/task-10.md`**

- [ ] **Step 6: No commit**

---

### Task 11: Code-read the admin module

**Files:**
- Create: `scratchpad/fragments/task-11.md`

- [ ] **Step 1: Read all eleven admin pages**

Under `src/app/(app)/admin/`: overview, people, terms, roles, departments, subcommittees, contract, audit, email, notifications, settings.

The IA lens matters most here. Eleven flat nav items is a lot; record whether the grouping matches how the work is actually done, and whether any page is findable only by someone who already knows it exists.

- [ ] **Step 2: Record findings into `scratchpad/fragments/task-11.md`**

- [ ] **Step 3: No commit**

---

### Task 12: Rank, cap, and write the audit document

**Files:**
- Create: `docs/full-app-ux-audit-2026-07-28.md`

**Interfaces:**
- Consumes: fragments `task-04.md` through `task-11.md`.
- Produces: the committed deliverable.

- [ ] **Step 1: Concatenate every fragment and de-duplicate**

The same underlying problem will appear in more than one journey. Merge those into one finding whose reach is the union, rather than counting it twice.

- [ ] **Step 2: Add the two pre-seeded findings**

From the spec: the toast notification system (staged as two items, system first and inline-Alert migration second) and the bottom-right overlay collision between `HelpLauncher` at `src/platform/ui/help/help-launcher.tsx:106` and the inactivity warning at `src/platform/auth/inactivity.tsx:62`. Verify both line numbers still hold before writing them in.

- [ ] **Step 3: Rank on severity times reach**

Tier-1 findings outrank tier-2 findings at equal severity. Within a tier, `blocks` outranks `costs-time` outranks `polish`.

- [ ] **Step 4: Apply the cap**

Keep the top 40. If more survived, add a "Cut for cap" section stating how many were cut and listing their subjects in one line each. Never drop them silently.

- [ ] **Step 5: Split out the L-effort findings**

Move every `L` finding into a "Needs its own brainstorm" appendix. These are not backlog items.

- [ ] **Step 6: Write the document**

Structure: purpose and method, coverage table including what could not be walked and why, the ranked findings, the cut list, the brainstorm appendix, and a proposed first batch.

The proposed first batch should be the highest-ranked items whose combined effort fits one focused piece of work, with the toast system included since it was the originating request.

- [ ] **Step 7: Verify no em-dashes**

```bash
grep -n "—\|–" docs/full-app-ux-audit-2026-07-28.md || echo "CLEAN"
```

Expected: `CLEAN`.

- [ ] **Step 8: Commit**

```bash
git add docs/full-app-ux-audit-2026-07-28.md
git commit -m "docs: whole-app UX flow-friction audit"
```

- [ ] **Step 9: Update the audit history memory**

Append a line to `/Users/jcarney/.claude/projects/-Users-jcarney-Documents-Code-Projects-HAVENHub/memory/audit-history.md` recording this as the 12th audit, with the date, the UX flow-friction scope, and the finding count. Do not add a line to `MEMORY.md`; the index memory already covers it.

---

### Task 13: Present the batch for selection

**Files:** none.

- [ ] **Step 1: Summarize the audit to the user**

Report: total findings, the split across the three lenses, how many were cut for the cap, which journeys had incomplete coverage and why, and the proposed first batch with its combined effort.

- [ ] **Step 2: Ask which batch to ship**

The user picks. That batch gets its own spec and plan per the design document. Do not begin implementation in this session without that selection.

---

## Self-review notes

**Spec coverage.** Every spec section maps to a task: lenses and coverage into Tasks 4 through 11; the finding model into the fragment format and Task 12; the pre-seeded toast and overlay findings into Task 12 Step 2; environment and fixture-gap method into Tasks 1 through 3; the evidence rule into the journey tasks; the deliverable and verification into Task 12.

**Known deviation from the spec.** The spec described the fixture script as throwaway. This plan commits it as `scripts/seed-ux-audit-fixtures.ts` with an npm script, because a reproducible fixture builder is worth more than a scratch file when a follow-up batch needs the same states, and because the journey tasks depend on exact fixture identifiers that must not drift. The header comment marks it deletable once the audit ships.

**Unresolved at plan time.** Task 3 Step 1 directs the implementer to read five service files before writing fixture code. The signatures for `createCycle` and `submitApplication` are verified and stated inline; the learning and schedule entry points are named by file but not by signature, because writing invented field shapes for eight Prisma models would produce confidently wrong code. Reading a named file is a concrete instruction, not a placeholder, but it is the one place this plan defers detail.
