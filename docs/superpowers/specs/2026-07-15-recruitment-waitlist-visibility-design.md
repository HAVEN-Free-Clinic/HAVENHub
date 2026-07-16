# Recruitment waitlist visibility + promote

Date: 2026-07-15
Status: Approved (design)

## Problem

A "waitlisted" applicant is fully queryable (nothing is deleted), but the
recruitment reviewer UI gives no way to find them and no way to act on them:

- The cycle roster (`src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx`)
  lists every submitted application but masks the waitlist state. Its **Stage**
  column runs the decision through `applicationStage()`, which collapses any
  non-pending decision into `"DECIDED"`. Its **Decision** column
  (`page.tsx:18-24`) reads only `a.acceptances`, and WAITLIST mints no
  Acceptance, so a waitlisted applicant renders as `"None"` — indistinguishable
  from someone nobody has decided on. There is no decision filter.
- There is no dedicated waitlist view and no "pull from waitlist" action. The
  only lever today is the generic ACCEPT/REJECT/WAITLIST dropdown on one
  applicant/interview detail page at a time.

The applicant portal even promises "We will be in touch if a spot opens."
(`src/modules/recruitment/services/portal-status.ts:81`), but nothing fulfills
that: waitlisted applicants are a dead end for reviewers.

## Background — how "waitlist" is stored

`WAITLIST` is a value of the Prisma enum `InterviewDecision`
(`prisma/schema.prisma:512-517`). It lives on one of two fields by track:

- **Director track**: `Interview.decision`, set by `decideInterview()`
  (`services/interview-decisions.ts`).
- **Volunteer track** (no interview): `Application.decision`, set by
  `decideRoutedApplication()` (`services/routing.ts`).

Only `ACCEPT` mints an `Acceptance`; WAITLIST/REJECT never do. The applicant is
emailed only by `releaseDecisions()` (`services/decisions.ts:55`), which is the
sole email path, is idempotent (claims each acceptance with an `emailedAt: null`
precondition), and skips conflicted applications.

The decide functions already enforce: reviewer scope (`reviewScope`:
`review_all` sees all, a director sees their departments), separation of duties
(can't decide your own), and a guard that blocks changing **away** from an
ACCEPT that was already emailed or has an onboarding contract. That guard does
NOT block WAITLIST → ACCEPT, because a waitlisted applicant has no Acceptance to
protect.

## Decisions (locked)

1. **Promote emails immediately, reusing the acceptance email.** (Revised from
   the original "email via Release" decision.) Promoting a waitlisted applicant
   changes the decision to ACCEPT (minting the Acceptance) AND sends the standard
   `recruitment.acceptance` email right away via a new shared
   `sendAcceptanceEmail`, so it fulfills the portal's "we'll be in touch if a
   spot opens" promise without a separate release run. The send reuses the exact
   atomic `emailedAt: null` claim releaseDecisions uses, so promote + a later
   Release never double-send. A conflicted applicant (offers from >1 department)
   is promoted but NOT emailed until the conflict is resolved and the cycle
   released; the reviewer is told so. Only the waitlist promote path auto-emails;
   normal accepts elsewhere still notify via Release.
2. **Option 3 is a real standalone page** with inline promote, not just a
   pre-filtered link.

## Design

### A. Shared `rosterDecision` helper (new, testable)

New pure module `src/modules/recruitment/engine/decision-summary.ts`:

```ts
type RosterDecisionStatus = "ACCEPTED" | "WAITLIST" | "REJECTED" | "NONE";
function rosterDecision(input: {
  acceptances: { departmentCode: string }[];
  applicationDecision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST";
  interviews: { decision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST" }[];
}): { status: RosterDecisionStatus; label: string; tone: "default" | "success" | "warning" | "critical"; departments: string[] };
```

Precedence **accepted > waitlisted > rejected > none**:

- `acceptances.length > 0` → `ACCEPTED`. One distinct dept → `success`, label
  `Accepted: <DEPT>`. More than one distinct dept → `critical`, label
  `Conflict: A + B` (preserves today's behavior in `page.tsx:18-24`).
- else any WAITLIST (app decision or any interview) → `WAITLIST`, `warning`,
  label `Waitlisted`.
- else any REJECT → `REJECTED`, `default`, label `Rejected`.
- else → `NONE`, `default`, label `None`.

Unit-tested. Replaces the local `decision()` in `applicants/page.tsx`.

### B. Feature 1 — roster badge + filter (edit `applicants/page.tsx` only)

- Render the Decision column via `rosterDecision(a)` so waitlisted applicants
  show a **Waitlisted** badge. No query change: `listApplicantsForReview`
  already returns `a.decision`, `a.interviews[].decision`, `a.acceptances`.
- Add a `?decision=` filter using `NavForm` (`src/platform/ui/nav-form.tsx`):
  options All / Accepted / Waitlisted / Rejected / Undecided. Filter the
  already-fetched `apps` in memory by `rosterDecision(a).status`, then
  recompute pagination. Preserve `decision` in the pagination hrefs.
- Leave the Stage column unchanged ("Decided" is accurate; the Decision column
  now carries the nuance).

### C. Feature 2 — promote action (thin wrapper, no new decision logic)

New `src/app/(app)/recruitment/cycles/[id]/waitlist/actions.ts` exporting
`promoteFromWaitlistAction(cycleId, formData)`:

- Reads `applicationId` and optional `interviewId` from `formData`.
- If `interviewId` present (director track) →
  `decideInterview(interviewId, "ACCEPT", personId, null)`.
- Else (volunteer track) →
  `decideRoutedApplication(applicationId, "ACCEPT", personId, null)`.
- Captures the decided interview/application's `departmentCode`, then calls
  `sendAcceptanceEmail(applicationId, departmentCode)` (see below) to email the
  applicant immediately.
- Catches the module error types (`RecruitmentAuthError`, `AcceptanceError`,
  `RoutingError`, `InterviewError`) and bounces back to the waitlist page with
  `?error=`; on success bounces with `?promoted=<name>&sent=<1|conflicted|...>`
  and `revalidatePath`. Mirrors `applicants/actions.ts` `decideRoutedAction`.

All authz/guards come from the reused decide services.

**Shared email helper** — new `sendAcceptanceEmail(applicationId, departmentCode)`
in `services/decisions.ts`: renders + queues the `recruitment.acceptance` email
for that one acceptance and atomically stamps `emailedAt` using the SAME
`emailedAt: null` claim as `releaseDecisions`, so promote and a later Release
never double-send. Returns `{ sent: false, reason: "conflicted" }` (no email) if
the application holds acceptances from more than one department; `"already_emailed"`
if already sent; `"not_found"` if the acceptance is missing. Unit-tested.

### D. Feature 3 — standalone waitlist page

**Service** — new `listWaitlisted(cycleId, viewerId)` in `services/review.ts`,
mirroring `listApplicantsForReview` scope. Query:

```
application.findMany({
  where: { cycleId, status: "SUBMITTED",
    OR: [ { decision: "WAITLIST" }, { interviews: { some: { decision: "WAITLIST" } } } ] },
  include: {
    applicant: { select: { firstName, lastName, email } },
    interviews: { where: { decision: "WAITLIST" }, select: { id, departmentCode } },
  },
})
```

Normalize to entries `{ applicationId, applicantName, applicantEmail, departmentCode, interviewId: string | null }`:

- Cycle track VOLUNTEER → one entry per app; `departmentCode = routedDepartmentCode`, `interviewId = null`.
- Cycle track DIRECTOR → one entry per waitlisted interview; `departmentCode = interview.departmentCode`, `interviewId = interview.id`.

Scope: compute `seeAll = scope.all || managesCycles || canScore` (same as
`listApplicantsForReview`); if not, keep only entries whose `departmentCode` is
in the viewer's `scope.departmentCodes`. Unit-tested (volunteer app appears;
director interview appears; accepted/rejected/pending excluded; director sees
only their department; SRR sees all).

**Page** — new `waitlist/page.tsx`, `requirePermission("recruitment.access")`,
results scoped by `listWaitlisted`. Renders a count in the header and a table
(Name → link to applicant detail, Email, Department, `[Promote to accept]`
button posting to `promoteFromWaitlistAction` with hidden `applicationId` +
`interviewId`). Empty state. Breadcrumb via `cycleTrail({ …, section: { label:
"Waitlist", slug: "waitlist" } })` (generic; no `breadcrumbs.ts` change).
Surfaces `?error=` / `?promoted=` alerts.

**Nav** — add a "Waitlist" link button in the cycle overview link row
(`cycles/[id]/page.tsx`, next to "View applicants" at `page.tsx:87`), shown to
all `recruitment.access` holders like "View applicants" is (results scoped).

## Testing

- Unit: `decision-summary.test.ts` — precedence and labels, incl. conflict.
- Service: `review.test.ts` (or a `waitlist`-focused test) for `listWaitlisted`
  — track normalization, exclusion of non-waitlist decisions, scope filtering.
  Uses the isolated local test DB (per-worktree `TEST_DATABASE_URL`, never Neon).
- Service: `decisions.test.ts` for `sendAcceptanceEmail` — sends + stamps
  `emailedAt`, idempotent (no re-send, no double-send with a later Release),
  conflict skip, not-found.
- Promote path: WAITLIST → ACCEPT mints an Acceptance (decide functions already
  tested) and then emails via `sendAcceptanceEmail`.
- Build + drive verification of the two pages + promote at the end.

## Out of scope (YAGNI)

Waitlist ranking/ordering; auto-backfill when an accepted applicant declines; a
*dedicated* "you're waitlisted" or "a spot opened" email template (promote reuses
the standard acceptance email instead); a promote button on the roster (promote
lives on the waitlist page and the existing detail-page dropdown).

## Permissions

No new permission. Viewing is `recruitment.access` with `reviewScope` narrowing
rows. Promoting is gated inside the reused decide functions (`review_all` or the
department's director), plus separation of duties and the emitted/contract guard.

## Files

- New: `src/modules/recruitment/engine/decision-summary.ts` (+ test);
  `src/app/(app)/recruitment/cycles/[id]/waitlist/page.tsx`;
  `src/app/(app)/recruitment/cycles/[id]/waitlist/actions.ts`
- Edit: `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx`;
  `src/modules/recruitment/services/review.ts` (+ `listWaitlisted` test);
  `src/modules/recruitment/services/decisions.ts` (+ `sendAcceptanceEmail` test);
  `src/app/(app)/recruitment/cycles/[id]/page.tsx` (nav link)
