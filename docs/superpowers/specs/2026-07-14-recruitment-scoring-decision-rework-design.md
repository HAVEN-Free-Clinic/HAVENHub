# Recruitment scoring + decision-making rework

Date: 2026-07-14
Branch: `feat/recruitment-scoring-decision-rework`
Status: Approved design, pending spec review

## Problem

The applicant scoring + decision-making process is built wrong. The intended
flow is a **staged pipeline**:

1. A central recruitment committee reads every application and scores each one
   **1-5**; the app shows a **running average**.
2. After committee scoring, each applicant is **routed** to whatever department
   the committee judges the best fit.
3. That department runs its **own interviews and scoring** and makes the
   **final decision**.

None of that staging exists today, and a related UX bug makes the current
decision step feel broken.

What exists today (verified against the codebase):

- Recruitment runs on **two disjoint tracks** (`RecruitmentCycle.track =
  VOLUNTEER | DIRECTOR`). `VOLUNTEER` = a reviewer *instantly accepts* an
  applicant into a department (`acceptApplicant()`, no scoring, no interview).
  `DIRECTOR` = a full interview pipeline.
- **No numeric scoring anywhere.** The only rating is a categorical
  `Recommendation` enum (`STRONG_YES | YES | MAYBE | NO`) on per-interview
  `Evaluation` rows, and `evaluationSummary()` renders only per-category
  **counts**, never an average.
- **No "committee picks best-fit department" step.** Applicants self-select
  departments up front (`Application.departmentChoices[]`), and reviewers can
  only accept/interview into a department the applicant already picked.
- **Decision-confirmation bug (confirmed):** on the interview page,
  `decideAction` (`src/app/(app)/recruitment/interviews/actions.ts:67`) only
  calls `revalidatePath` on success — no success signal. The page
  (`[interviewId]/page.tsx`) reads only an `?error` param, and the outcome
  `<Select>` has no `defaultValue`, so after recording a decision the form
  resets to "Accept" and looks untouched. The only real indicator is a small
  status `Badge` at the top of the page, spatially disconnected from the form.

## Goals

- A **committee scoring stage**: any holder of a new `recruitment.score`
  permission reads every submitted application in a cycle and gives it a 1-5
  score. The app shows a **running average** and how many committee members
  have scored (a readiness signal).
- A **routing stage**: a recruitment lead assigns each applicant to a single
  best-fit department. Default to the applicant's own department choices; allow
  override to any cycle department, visibly flagged.
- A **department review stage**: the routed department schedules an interview,
  its panel scores **1-5** (running average), and a department director records
  the **final** ACCEPT / REJECT / WAITLIST decision.
- **Numeric 1-5 scoring everywhere**; retire the categorical `Recommendation`
  enum.
- **Fix the decision-confirmation bug** so recording a decision gives clear
  on-page confirmation and the form reflects the recorded state.
- Build for the **volunteer** applicant pool now, but structure the models and
  permissions so the **director track can adopt the same pipeline later**
  without a rewrite ("director-ready").

## Non-goals

- The **director track keeps its current flow** for now (no committee scoring,
  no routing UI). It does inherit numeric 1-5 interview scoring from the shared
  `Evaluation` change — that is intended and part of "director-ready".
- No hard cycle-wide scoring phase gate. Routing is per-applicant, available
  whenever a lead judges an application ready (informed by the readiness
  signal). One unscored application never blocks routing the rest.
- No change to the SRR release / onboarding / promotion back half
  (`releaseDecisions()`, `OnboardingContract`, `promoteContract()`).
- No new subcommittee behavior. Subcommittee ranking/assignment stays as-is.
- Committee scoring is **not** auto-aggregated into the routing or final
  decision — scores are advisory input a human acts on (mirrors how interview
  evaluations are advisory to `decideInterview()` today).

## Design

### Pipeline overview

```
SUBMITTED
   |
   v  (1) COMMITTEE SCORING   application-level, cross-department
        every recruitment.score holder reads the app, gives 1-5; running avg shown
   |
   v  (2) ROUTING             a lead assigns the best-fit department
        prefer applicant's departmentChoices, allow override to any dept (flagged)
   |
   v  (3) DEPARTMENT REVIEW   department-scoped
        routed dept schedules interview -> panel scores 1-5 (avg) -> director decides
   |
   v  (4) RELEASE             existing SRR release + onboarding (unchanged)
```

Pipeline **stage is derived**, consistent with the app's existing philosophy
(`Application.status` stays `DRAFT | SUBMITTED`; everything past SUBMITTED is
already derived in `portal-status.ts`). A new `applicationStage()` helper
returns `AWAITING_SCORING -> SCORING -> ROUTED -> INTERVIEWING -> DECIDED` for
roster filters and badges, derived from `CommitteeScore` rows, the
`routedDepartmentCode` field, and `Interview` / `Interview.decision`.

### 1. Data model (`prisma/schema.prisma`)

**New — committee scoring (stage 1), application-level per-reviewer score:**

```prisma
model CommitteeScore {
  id            String      @id @default(cuid())
  applicationId String
  reviewerId    String      // Person
  score         Int         // 1-5 (validated in service)
  comments      String?
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt
  application   Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  reviewer      Person      @relation("committeeScorer", fields: [reviewerId], references: [id])

  @@unique([applicationId, reviewerId])   // one per reviewer; upsert to revise
  @@index([applicationId])
}
```

Running average = `avg(score)` across rows; reviewer count = row count. This is
the per-reviewer `Evaluation` shape lifted one level up (application, not
interview). Add the back-relations on `Application` (`committeeScores`) and
`Person` (`committeeScores`, relation `"committeeScorer"`).

**New — routing fields on `Application` (stage 2):**

```prisma
routedDepartmentCode String?    // the committee's best-fit pick; null = not routed
routedById           String?    // Person (the lead who routed) — relation "applicationRoutedBy"
routedAt             DateTime?
```

`routedDepartmentCode` is the canonical "assigned to a department for review"
binding, and it resolves the old multi-department ambiguity: one routed dept ->
one interview -> one acceptance. The **off-choice flag is derived**
(`!departmentChoices.includes(routedDepartmentCode)`), not stored.

**Changed — `Evaluation` goes numeric (stage 3); retire categorical:**

- Replace `recommendation Recommendation` with `score Int` (1-5). Keep
  `comments` and `@@unique([interviewId, evaluatorId])`.
- **Drop the `Recommendation` enum** (`schema.prisma` enum + all usages).
- Data migration backfills existing rows before the column is dropped:
  `STRONG_YES -> 5, YES -> 4, MAYBE -> 3, NO -> 1`.

This shared change also switches director-track interviews to 1-5 scoring
(intended; makes the director track "ready" for the rest of the pipeline).

### 2. Permissions & authority

- **New `recruitment.score`** — add to the recruitment module permission
  catalog in `src/platform/modules/registry.ts`. Grants: read **all** submitted
  applications in a cycle + submit/update **your own** 1-5 committee score.
  Grants **no** routing, decision, or release power. Admin-grantable; not seeded
  into any system role, so **no backfill migration** is required (the permission
  string just needs to exist in the catalog to be grantable).
- **Routing (stage 2)** is gated on existing **`recruitment.review_all`**
  (leads/SRR). (Can be split into a dedicated `recruitment.route` later if
  non-SRR routing leads are needed; reusing `review_all` for now — YAGNI.)
- **Department review (stage 3)** keeps today's authorization: department
  directors (via `manageableDepartmentIds()` from active `DIRECTOR`
  `TermMembership` rows + one-hop `DepartmentDelegation`) and `review_all`
  create interviews, manage panels, score as panelists, and decide **for their
  department** (`reviewScope()` in `services/review.ts`).

**Surface reachability fix.** Today a department director with no
`recruitment.access` cannot reach cycle-level list pages (they sit behind
`cycles/layout.tsx`), and committee scorers would hit the same wall. Broaden the
`cycles/layout.tsx` gate to admit anyone with **any** relevant capability
(`recruitment.access` OR `recruitment.score` OR a non-empty `reviewScope()`),
then gate each tab/action by its specific permission — the established
"ModuleNav sub-permissions" pattern (layout admits, pages enforce). Committee
scorers and directors thereby reach exactly their scoped surfaces without a
blanket grant.

### 3. Services (`src/modules/recruitment/services/`)

- **`committee-scoring.ts`** (new): `submitCommitteeScore(applicationId,
  reviewerId, score, comments)` — validates `score in 1..5`, requires
  `recruitment.score` (or `review_all`), upserts on `(applicationId,
  reviewerId)`, records an audit action. `committeeScoreSummary(applicationId)`
  -> `{ average, count, scores[] }`.
- **`routing.ts`** (new): `routeApplication(applicationId, departmentCode,
  actorId)` — requires `review_all`; validates `departmentCode` is one of
  `cycle.departments`; sets `routedDepartmentCode/routedById/routedAt`; records
  audit. Off-choice routing is allowed but the caller/UI surfaces the derived
  flag (service does not block it).
- **`interviews.ts`** (changed): `createInterview()` drops the hard
  `track === 'DIRECTOR'` requirement. New guard: if `routedDepartmentCode` is
  set, require `departmentCode === routedDepartmentCode` (the volunteer
  pipeline); otherwise fall back to the existing "applicant ranked this dept"
  guard (director track, unchanged). This unlocks department interviews for
  routed volunteer applications without disturbing the director flow.
- **`evaluations.ts` / `engine/interview-eval.ts` (changed):**
  `submitEvaluation()` takes a numeric `score`; `evaluationSummary()` returns
  `{ average, count }` (an average, not category counts).
- **`review.ts` (changed):** the volunteer instant-accept path
  (`acceptApplicant()` and its UI) is **removed**. Volunteer decisions now flow
  through the department interview/decision surface (`decideInterview()`), which
  already mints/removes the `Acceptance`. `revokeAcceptance()` and the
  rescind/release machinery stay.
- **Roster visibility (tri-modal), in the `listApplicantsForReview()` query:**
  - `recruitment.review_all` (leads/SRR): see **all** submitted applications.
  - `recruitment.score` (committee): see **all** submitted applications
    (cross-department read is the whole point of committee scoring), but with no
    routing/decision controls.
  - department directors (scope by `departmentCodes`, no `review_all`/`score`):
    see applications **routed to their department** — filter on
    `routedDepartmentCode ∈ scope.departmentCodes`. This is a change from
    today's "applications that *chose* my department" filter
    (`departmentChoices ∩ scope`); routing, not applicant choice, now drives a
    director's queue.

### 4. UI surfaces (extend existing routes)

- **`cycles/[id]/applicants/page.tsx` (roster):** add a **Stage** column +
  filter (`applicationStage()`) and a **Committee avg** column (e.g.
  `4.2 · 6 scored`). Scope-aware: `score` / `review_all` holders see all;
  directors see applications routed to their department(s). Uses `NavForm` for
  the filter bar (soft-nav convention).
- **`cycles/[id]/applicants/[applicationId]/page.tsx` (detail):** add
  - a **1-5 committee score input** (the current user's own score) + the running
    average + comments (stage 1);
  - a **Route to department** control for leads — the applicant's
    `departmentChoices` highlighted, any cycle department selectable, with an
    off-choice confirmation/flag (stage 2);
  - a link into the department interview once routed.
  Remove the current volunteer "Accept into department" instant-accept form.
- **`interviews/[interviewId]/page.tsx` (department stage 3):** numeric 1-5
  panel scoring with running average; reachable for routed volunteer
  applications (per the `createInterview()` change); decision-confirmation bug
  fixed (see below).

Feedback uses the existing `Alert` / `Badge` primitives and the
`?saved=`/`?error=` searchParam -> `Alert` convention (no toast primitive
exists; do not add one).

### 5. Decision-confirmation bug fix

In `src/app/(app)/recruitment/interviews/`:

1. `actions.ts` `decideAction`: on success **redirect** with
   `?saved=decision` (the convention `cycles/[id]/page.tsx` already uses),
   instead of the bare `revalidatePath`.
2. `[interviewId]/page.tsx`: destructure `saved` from `searchParams` and render
   a success `Alert` beside the existing error `Alert`.
3. Decision card **reflects state**: set `<Select defaultValue={iv.decision}>`
   and show "Recorded {label} · {relative date} by {name}".
4. Sweep the same silent-success fix across the sibling revalidate-only actions
   on this page (`scheduleAction`, `addPanelistAction`, `sendInviteAction`,
   `submitEvaluationAction`, `rescindAcceptanceAction`) — they share the defect.

### 6. Migration, testing, rollout

- **One Prisma migration**, trimmed to intended changes only (per the
  `migrate dev` drift gotcha): add `CommitteeScore`; add routing fields to
  `Application`; convert `Evaluation.recommendation` -> `score` **with an
  in-migration backfill** of existing rows; drop the `Recommendation` enum. All
  migration/test runs use a **throwaway local Postgres** via
  `TEST_DATABASE_URL`, never Neon.
- **Tests:** committee-score upsert + average; routing (prefer-choice,
  override/off-choice flag, `review_all` authorization, invalid dept rejected);
  numeric evaluation + average; `createInterview()` reachable for a routed
  volunteer application and still guarded for the director track; permission
  guards (`recruitment.score` cannot route or decide; director scope enforced on
  department review; layout admits score/scope holders); and a
  decision-confirmation assertion (success `Alert` shown, `Select` reflects the
  recorded decision). Update the existing recruitment e2e specs.
- **Rollout:** ships as CI-gated work. Preferred slicing into reviewable
  commits/PRs:
  1. Schema + permission + `applicationStage()` foundation (migration,
     `recruitment.score`, `Evaluation` numeric conversion, layout gate).
  2. Committee scoring (service + roster/detail UI + running average).
  3. Routing (service + detail control + roster stage/filter).
  4. Department stage reachability + decision-confirmation bug fix.

## Assumed defaults (called out for confirmation during review)

1. **Instant-accept removed** — all volunteer decisions go through the
   interview/decision surface. A department may skip scheduling/panelists and
   just record the decision, but the decision lives on an `Interview` row.
2. **Routing = `review_all` leads**, not every committee scorer.
3. **Running average is always visible** while scoring (per request). Mild
   anchoring risk noted; blind-until-you-score is a later option, not the
   default.
4. **Committee scoring is enabled for volunteer cycles now**; director cycles
   keep their current flow but inherit numeric interview scoring.
