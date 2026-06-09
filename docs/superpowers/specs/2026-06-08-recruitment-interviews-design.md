# Recruitment Director-Track Interviews Design (Plan 12)

**Date:** 2026-06-08
**Status:** Approved (brainstorm) — Plan 12, the third sub-project of the Recruitment program
**Module id:** `recruitment` (active since Plan 10)
**Builds on:** Plan 10 (foundation/intake) + Plan 11 (review & acceptance). Branch `plan-12/recruitment-interviews` is stacked on `plan-11/recruitment-review`.

Plan 12 digitizes the **director-track** hiring flow: candidates who applied to a DIRECTOR cycle are interviewed by a panel, panelists submit recommendations, and a dept-scoped decider records an Accept/Reject/Waitlist outcome. An Accept reuses Plan 11's `Acceptance` + batched-release machinery unchanged. Modeled on the `HAVEN Director Recruitment` base (`app6MHzSA1yPej2zX`): Applications → Interviews (scheduled time, Zoom link, panel, evaluations, decision) → Acceptances → Director Contracts. ~73 interviews per cycle.

This plan is **DIRECTOR-track only**. The volunteer accept-with-notes flow is Plan 11 and stays unchanged. Director **contracts/onboarding** and roster promotion are Plan 13.

---

## 1. Scope

In scope:
1. Create an interview for a director application (per department).
2. Schedule it (time + Zoom link + notes); send a candidate invite email.
3. Assign a panel (panelists, one lead); panelists submit a recommendation + comments.
4. A dept-scoped decider records Accept / Reject / Waitlist; Accept creates an `Acceptance`.
5. Accepted director candidates are emailed via Plan 11's existing batched release.

Out of scope (later plans / explicitly deferred):
- Director **contracts/onboarding** and **roster promotion** → Plan 13.
- **Rejection / waitlist emails** — the decision records the outcome; no auto-email for reject/waitlist in this plan.
- **Calendar / Zoom API** integration — `scheduledAt` and `zoomLink` are entered manually.

---

## 2. Decisions (from brainstorm)

- **Evaluation content:** each panelist submits an overall **recommendation** (STRONG_YES | YES | MAYBE | NO) plus free-text comments. No numeric rubric.
- **Authorization:** scheduling, panel assignment, invites, and the decision are **dept-scoped** via Plan 11's `reviewScope` (a director manages interviews for departments they direct; `review_all` overrides across all). Submitting an evaluation is authorized purely by **panel membership**.
- **Outcomes:** the decision is **Accept / Reject / Waitlist**. Only **Accept** notifies (it creates an `Acceptance`, emailed by Plan 11's release). Reject/Waitlist record the outcome with no email.
- **Scheduling:** manual `scheduledAt` + `zoomLink`; a **Send invite** action emails the candidate.

---

## 3. Data model

### New enums
```
enum InterviewDecision { PENDING, ACCEPT, REJECT, WAITLIST }
enum Recommendation     { STRONG_YES, YES, MAYBE, NO }
```

### New model: `Interview`

| Field | Type | Notes |
|-------|------|-------|
| `id` | String @id @default(cuid()) | |
| `applicationId` | String | FK → Application (onDelete: Cascade) |
| `departmentCode` | String | the department interviewed for; one of the cycle's `departments`, and one the candidate ranked |
| `scheduledAt` | DateTime? | null until scheduled |
| `zoomLink` | String? | |
| `invitedAt` | DateTime? | set when the candidate invite email is sent |
| `decision` | InterviewDecision @default(PENDING) | |
| `decidedById` | String? | FK → Person (onDelete: SetNull) |
| `decidedAt` | DateTime? | |
| `notes` | String? | coordinator notes |
| `createdById` | String | FK → Person (onDelete: Restrict) |
| `createdAt` / `updatedAt` | DateTime | |

- `@@unique([applicationId, departmentCode])` — at most one interview per candidate per department (a candidate may interview for more than one department).
- `@@index([applicationId])`.
- Relations: `application Application`, `decidedBy Person? @relation("interviewDecidedBy")`, `createdBy Person @relation("interviewCreatedBy")`, `panelists InterviewPanelist[]`, `evaluations Evaluation[]`.

**Derived status (UI only, not stored):** no `scheduledAt` → "Offered"; `scheduledAt` set and `decision = PENDING` → "Scheduled"; otherwise the `decision` value.

### New model: `InterviewPanelist`

| Field | Type | Notes |
|-------|------|-------|
| `id` | String @id @default(cuid()) | |
| `interviewId` | String | FK → Interview (onDelete: Cascade) |
| `personId` | String | FK → Person (onDelete: Cascade) |
| `isLead` | Boolean @default(false) | |

- `@@unique([interviewId, personId])`; `@@index([personId])` (powers "my assignments").

### New model: `Evaluation`

| Field | Type | Notes |
|-------|------|-------|
| `id` | String @id @default(cuid()) | |
| `interviewId` | String | FK → Interview (onDelete: Cascade) |
| `evaluatorId` | String | FK → Person (onDelete: Cascade) |
| `recommendation` | Recommendation | |
| `comments` | String? | |
| `createdAt` / `updatedAt` | DateTime | |

- `@@unique([interviewId, evaluatorId])` — one evaluation per panelist, editable.

### Reused unchanged (Plan 11)
`Acceptance`, `services/decisions.ts` (conflicts/summary/batched release), `email/templates/acceptance.ts`, `services/review.ts`'s `reviewScope` + `RecruitmentAuthError`/`AcceptanceError`.

Back-relations on `Person`: `interviewsCreated`, `interviewsDecided`, `interviewPanels InterviewPanelist[]`, `interviewEvaluations Evaluation[]`. Back-relation on `Application`: `interviews Interview[]`.

`src/platform/test/db.ts` `resetDb()` gains `"Evaluation"`, `"InterviewPanelist"`, `"Interview"` (before `"Acceptance"`/`"Application"`).

---

## 4. Authorization

No new permissions. Reuses Plan 11's `recruitment.review` (dept-scoped) + `recruitment.review_all` (override), plus `recruitment.access` (module entry).

- **Coordinator actions** (create/schedule/panel/invite/decide): authorized iff `reviewScope(actor)` covers the interview's `departmentCode` (`scope.all` or `departmentCode ∈ scope.departmentCodes`). Same rule as Plan 11 acceptance.
- **Evaluation submission:** authorized iff the actor is an `InterviewPanelist` on that interview. Independent of review scope. (Panelists need `recruitment.access` to reach the module; assignment does not grant it — an admin ensures panelists hold it.)
- **Interview detail page visibility:** the viewer's scope covers the department **OR** the viewer is a panelist. Non-coordinator panelists get a limited view (candidate basics + their own evaluation form); coordinators see scheduling/panel/decision.

All checks are enforced server-side in the services; pages only reflect.

---

## 5. Surfaces

### Cycle overview (director cycles)
Add an **"Interviews"** link (rendered when `cycle.track === "DIRECTOR"`) alongside applicants/decisions.

### Applicant detail (director cycles)
Replace the volunteer accept panel with a **"Schedule interview"** control: a department dropdown (the candidate's ranked departments intersected with the viewer's scope; `review_all` sees all cycle departments) + a button that calls `createInterview` and redirects to the interview detail. If an interview already exists for that department, link to it instead.

### Coordinator: interviews list — `/recruitment/cycles/[id]/interviews`
Dept-scoped queue (`review_all` sees all). Rows: candidate, department, derived status, scheduled time, panel size, evaluations received (e.g. "2/3"), decision.

### Coordinator: interview detail — `/recruitment/cycles/[id]/interviews/[interviewId]`
- **Schedule** form: `scheduledAt` + `zoomLink` + `notes`.
- **Panel**: add a panelist (Person picker + lead checkbox), remove a panelist.
- **Send invite** button: queues the candidate invite email (time + Zoom), stamps `invitedAt`; guarded so it requires `scheduledAt` first; re-sendable (button shows last-sent state).
- **Evaluations**: each panelist's recommendation + comments; a summary count by recommendation (`evaluationSummary`); a "missing" list (`missingPanelists`).
- **Decision**: Accept (into the interview's department) / Reject / Waitlist + a notes field. Gated by scope over the department.

### Evaluator surface
- `/recruitment/interviews` — personal "My interview assignments" list (interviews where the viewer is a panelist), so evaluators without review scope can find their work. Links to the detail.
- On the interview detail page, a panelist always sees a **"Your evaluation"** form (recommendation select + comments), upserting their `Evaluation`.

---

## 6. Engine (pure)

`src/modules/recruitment/engine/interview-eval.ts`:
- `evaluationSummary(evaluations: { recommendation: Recommendation }[]) → { strongYes, yes, maybe, no, total }`.
- `missingPanelists(panelistIds: string[], evaluations: { evaluatorId: string }[]) → string[]` (panelist ids with no evaluation).

Both pure, unit-tested.

---

## 7. Email

`src/modules/recruitment/email/templates/interview-invite.ts`:
- `interviewInviteEmail({ firstName, departmentName, scheduledAt, zoomLink }) → { subject, html }`. Notification with the formatted interview time and Zoom link. User-supplied values HTML-escaped; no em-dashes. `template: "recruitment.interview_invite"`.

Acceptance email reuses Plan 11's `acceptanceEmail` unchanged (a director Accept produces an `Acceptance`, released by Plan 11's `releaseDecisions`).

---

## 8. Services & files

- `src/modules/recruitment/engine/interview-eval.ts` (+ test).
- `src/modules/recruitment/email/templates/interview-invite.ts` (+ test).
- `src/modules/recruitment/services/interviews.ts` — `createInterview`, `updateInterview`, `addPanelist`, `removePanelist`, `sendInterviewInvite`, `listInterviewsForReview`, `myAssignedInterviews`, `getInterview` (+ test). Asserts DIRECTOR track; scope-authorized.
- `src/modules/recruitment/services/evaluations.ts` — `submitEvaluation` (panel-membership authz; upsert), `listEvaluations` (+ test).
- `src/modules/recruitment/services/interview-decisions.ts` — `decideInterview(interviewId, outcome, deciderId, notes)` (+ test). Records the decision (`decision`/`decidedBy`/`decidedAt`) and keeps the `Acceptance` in sync: setting **ACCEPT** creates an `Acceptance(applicationId, departmentCode, approvedById=decider)` if one does not already exist; setting a **non-ACCEPT** outcome **removes** any not-yet-emailed `Acceptance` for that (application, department) so the decision and the acceptance never disagree. An already-emailed acceptance is not auto-removed (an admin with `review_all` revokes it via the Plan 11 path, matching the volunteer post-email rule). Audit on every decision.
- Pages/actions: `src/app/recruitment/cycles/[id]/interviews/{page.tsx, actions.ts}`, `.../interviews/[interviewId]/{page.tsx, actions.ts}`, `src/app/recruitment/interviews/page.tsx` (my assignments), and a track branch in the existing applicant detail page.
- `src/platform/modules/registry.ts` — no new permissions; the "Interviews" link is per-cycle (overview), not top-level nav.
- `prisma/schema.prisma` + migration; `src/platform/test/db.ts`.

### Typed errors
Reuse `RecruitmentAuthError` (out-of-scope / non-panelist) and `AcceptanceError`. Add `InterviewError` (wrong track, invite-before-schedule, panel/evaluation invariants) in `services/interviews.ts`.

---

## 9. Error handling

- **Out-of-scope coordinator action** → `RecruitmentAuthError`.
- **Non-panelist submits an evaluation** → `RecruitmentAuthError`.
- **Non-DIRECTOR cycle on the interview surface** → `InterviewError`; the page shows "Interviews apply to director cycles."
- **Send invite before scheduling** → `InterviewError("Set an interview time first.")`.
- **Duplicate interview** (same application+department) → `InterviewError("An interview already exists for that department.")` (unique backstop).
- **Decide=ACCEPT when already accepted into that department** → `AcceptanceError` (Acceptance unique backstop).
- Pages map these to inline messages via `?error=`; the detail page renders untrusted text as escaped React content.

---

## 10. Testing

**Engine (pure, unit):** `evaluationSummary` (counts per recommendation, empty); `missingPanelists` (none missing, some missing).

**Email (pure, unit):** `interviewInviteEmail` (names candidate/department, includes time + Zoom, escapes HTML, no em-dash).

**Services (integration, real DB):**
- `interviews`: `createInterview` (scope ok; out-of-scope rejected; non-DIRECTOR rejected; duplicate rejected), `updateInterview`, `addPanelist`/`removePanelist`, `sendInterviewInvite` (requires `scheduledAt`; stamps `invitedAt`; queues an email), `listInterviewsForReview` (dept-scoped vs `review_all`), `myAssignedInterviews`.
- `evaluations`: `submitEvaluation` (panelist allowed; non-panelist rejected; upsert updates), `listEvaluations`.
- `interview-decisions`: `decideInterview` ACCEPT creates an `Acceptance` (and Plan 11 `releaseDecisions` then emails it); REJECT/WAITLIST record only; out-of-scope rejected; ACCEPT duplicate rejected.

**e2e (Playwright):** dev-login as SRR; build a DIRECTOR cycle with a department-choice field; submit a director application; from the applicant detail, schedule an interview; add a panelist; submit an evaluation; Accept into the department; open Decisions and release; assert the acceptance email is queued.

---

## 11. Done-criteria

- `Interview` / `InterviewPanelist` / `Evaluation` models + migration; `resetDb` updated.
- A dept-scoped director (and `review_all`) can create/schedule interviews, assign panels, send invites, and decide within scope; panelists submit recommendations by assignment.
- Accept produces an `Acceptance` that flows through Plan 11's conflict/release/email path; Reject/Waitlist record only.
- The director applicant detail branches to "Schedule interview"; the interviews + my-assignments surfaces work.
- Unit + integration + e2e tests green; CI (lint incl. module-boundary, typecheck, tests) passes.
