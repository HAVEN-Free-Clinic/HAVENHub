# Applicant self-withdrawal on the application portal

Date: 2026-08-07

## Problem

An applicant who no longer wants to be considered has no way to say so. They
email the clinic, or they say nothing at all. Meanwhile reviewers score them,
directors route them, panelists hold interview slots for them, and in the worst
case an offer goes out to somebody who accepted a position elsewhere weeks ago.

Give applicants a control in the portal that removes them from consideration,
at every stage where removing themselves is still meaningful.

## Scope

Self-withdrawal is available at four stages:

1. A draft that has not been submitted.
2. A submitted application under review.
3. An application with a scheduled interview.
4. An accepted application, until its onboarding contract is `PROMOTED`.

Once the contract is `PROMOTED` the applicant holds a real `TermMembership`.
They are a member, not an applicant, and `withdrawFromTerm` in `/my-info` is
already the correct path. The portal shows no withdrawal control at that point.

Out of scope: any change to how staff rescind acceptances, cancel interviews, or
tear down onboarding contracts. Those paths exist and stay as they are.

## Core rule: withdrawal declares, it does not tear down

Withdrawal sets `Application.status = WITHDRAWN`, stamps `withdrawnAt`, writes an
audit row, and notifies. It does **not** delete `Acceptance` rows, cancel
`Interview` rows, or touch `OnboardingContract`.

This is deliberate. `revokeAcceptance` (`services/review.ts:195-206`) explicitly
refuses to delete an acceptance that has a contract, because
`OnboardingContract.acceptance` is `onDelete: Cascade` and deleting through it
would destroy submitted signatures, DOB, and HIPAA certificates, and orphan the
stored blob. `interview-decisions.ts` carries the mirror guard. A portal action
that reached past those guards could silently destroy onboarding records on a
click from an unauthenticated-adjacent surface.

So the applicant's withdrawal is a declaration, and staff execute any cleanup
with the guarded tooling that already exists. This is the same shape as
`recordSelfWithdrawal` in `platform/offboarding/self-withdrawal.ts`: the member
declares, ops executes.

## Data model

One migration:

- `ApplicationStatus` gains a third value, `WITHDRAWN`.
- `Application` gains `withdrawnAt DateTime?`.

No reason field. The confirm step captures intent and nothing else.

### Why the enum carries the weight

Every reviewer-facing query already filters `status: "SUBMITTED"`:

| Surface | Location |
| --- | --- |
| Review queue | `services/review.ts:76`, `:125` |
| Reviewable cycle list | `services/review.ts:172`, `:178`, `:180-181` |
| Director digest count | `services/review-digest.ts:26`, `:39` |
| Speed-routing pool | `services/speed-route.ts:50` |

Flipping the status to `WITHDRAWN` drops the application out of all of them
without editing any of them. The surfaces that do *not* filter on status get
explicit handling (see "Surfaces needing explicit work") rather than a silent
change in behavior.

## Drafts are deleted, not marked

`Application` carries `@@unique([cycleId, applicantId])`, so an applicant has at
most one application per cycle. If discarding a draft left a terminal `WITHDRAWN`
row behind, the applicant would be permanently locked out of a cycle that is
still open: discard at 2pm, change your mind at 3pm, no way back in.

"Discard draft" therefore reuses the teardown that `sweepAbandonedDrafts`
(`services/drafts.ts:192-226`) already performs: collect the `storedName` keys
out of `answers`, call `cleanupFiles(keys)`, then delete the `Applicant` row,
which cascades to the draft `Application`. The applicant is free to start fresh.

This is a different verb, a different button, and a different code path from
withdrawal. It is offered only while the cycle is open, matching the existing
`canContinue` gate in `portal-status.ts:52`.

## Stage behavior

| Portal state | Control | Write | Notified |
| --- | --- | --- | --- |
| `DRAFT`, cycle open | Discard draft | `cleanupFiles` + delete `Applicant` | nobody |
| `SUBMITTED` | Withdraw application | status + `withdrawnAt` + audit | nobody |
| `INTERVIEW` | Withdraw application | same | panelists on that interview, plus directors of the interview's `departmentCode` |
| `ACCEPTED` / `ONBOARDING`, contract not `PROMOTED` | Decline offer | same | directors of the acceptance's department, plus `recruitment.review_all` holders |
| `ONBOARDING`, contract `PROMOTED` | none | none | none |

Note that `portal-status.ts` only reports `INTERVIEW` when an interview has a
`scheduledAt`; an interview row created but not yet scheduled still reads
`SUBMITTED`, and so withdraws silently. That is correct: nobody is holding a slot
yet.

The under-review case is deliberately silent. It falls out of the review queue on
its own, and during an active cycle a notification per withdrawal is noise on the
exact population that generates the most withdrawals. Notifications are reserved
for the cases where a human would otherwise act on stale information: hold a
slot, dial into a call, plan a roster around a person who is gone.

### Notification

One new type, `recruitment.applicant_withdrew`, registered in
`platform/notifications/registry.ts` with `defaultChannel: "email"`, dispatched
through `notify()` so it honors per-type channel routing and lands in the in-app
inbox as well as email. One new email template.

Recipients come from `departmentDirectorPersonIds(departmentId)`
(`platform/departments.ts:90`, so the department code must be mapped to its id
first), the `InterviewPanelist` rows for the affected interview, and
`peopleWithAnyPermission(["recruitment.review_all"])` for the accepted case.
Recipients are deduped, and the withdrawing applicant is never a recipient: on
the renewal path they have a `Person` and could otherwise appear in a director
list for their own withdrawal.

## Surfaces needing explicit work

Two application-reading surfaces do not filter on status.

**`myAssignedInterviews`** (`services/interviews.ts:224`) backs a panelist's "My
interviews" list. A withdrawn applicant's interview stays visible, badged
"Withdrawn". It must not silently disappear: a vanished row is how someone dials
into a call that was cancelled, and the panelist needs to see that the slot is
free.

**Cycle-overview department counts** (`app/(app)/recruitment/cycles/[id]/page.tsx:46`)
drive the "removing this department affects N applicants" warning on the
department selector. Withdrawn applications are excluded, because they are not
applicants anyone will act on and inflating that number misleads the decision.

## Staff-side undo

Withdrawal is terminal for the applicant. A `recruitment.manage_cycles` holder
gets a "Reopen" control on the applicant detail page that flips `WITHDRAWN` back
to `SUBMITTED` and clears `withdrawnAt`, mirroring the existing
`recruitment.application_reopen` action (`services/routing.ts:221-254`) and
writing its own audit row.

A misclick is then a message to the clinic rather than a dead end, and any
reversal is visible to staff instead of happening quietly in the portal.

## Portal UI

`ApplicantStatusView` gains:

- `state: "WITHDRAWN"` as a new member of the state union.
- `withdraw: null | { kind: "discard_draft" | "withdraw" | "decline_offer" }`.

Eligibility is computed server-side in `portal-status.ts` and re-checked in the
action. The client only renders what the server sent; it never decides whether
withdrawal is allowed.

`StatusCard` grows an action footer containing a `<form>` bound to the server
action with a `ConfirmButton` inside. `ConfirmButton` (`platform/ui/confirm-button.tsx`)
is the right primitive: two separate clicks, danger styling when armed,
`aria-live` announcement, focus preserved across the arm transition, and no
`window.confirm`, so it stays automation-friendly. The onboarding page already
uses it for its destructive withdraw.

The draft branch currently wraps the entire card in a `<Link>`
(`status-card.tsx:10-26`). That gets restructured into a card holding a
"Continue" link and a separate "Discard draft" control, because a button nested
inside an anchor is invalid markup and unreliable for keyboard users.

A `WITHDRAWN` card renders the headline "Withdrawn" with `showTracker: false` in
`trackerStageFor`. Running the four-node "Submitted, In review, Interview,
Decision" rail on a withdrawn application would imply progress that is not
happening.

No toast. The page re-renders into the withdrawn state, which is its own
confirmation, and the portal has no flash-toast infrastructure (that lives in the
`(app)` shell).

## Authorization

The action takes the cycle **slug**, never an `applicationId` from the form. It
calls `getApplicantIdentity()` and re-resolves the application through the
`(slug, identity)` lookup that `drafts.ts findRow` already uses.

No identifier supplied by the request ever selects the record, so a forged form
field cannot reach another applicant's application. This is the single most
important property of the feature and every test suite below exercises it.

## Concurrency

The write is an atomic claim in the style of the draft claim at
`services/submissions.ts:477`:

```
updateMany({ where: { id, status: { in: allowedStatuses } }, data: { status: "WITHDRAWN", withdrawnAt } })
```

The `PROMOTED` ceiling is re-read inside the same transaction, so a contract
promoted between the page render and the click cannot be withdrawn past.

Notification and PostHog capture fire only when the claim returns `count === 1`.
A double-click, a retry, or a race against a staff decision therefore cannot send
the interview panel two cancellation emails. A lost claim returns a friendly
"This application has already been updated" rather than throwing.

## Components

New:

- `modules/recruitment/services/withdraw.ts` and its test.
- `WithdrawError`, following the `DraftError` / `ContractError` convention.
- One email template for `recruitment.applicant_withdrew`.
- One notification registry entry.
- One Prisma migration.

Modified:

- `prisma/schema.prisma` (enum value, `withdrawnAt`).
- `app/apply/portal-actions.ts` (the server action).
- `modules/recruitment/services/portal-status.ts` (new state, `withdraw` field).
- `modules/recruitment/services/portal-tracker.ts` (hide tracker for `WITHDRAWN`).
- `app/apply/status-card.tsx` (action footer, draft-branch restructure).
- `modules/recruitment/services/interviews.ts` (withdrawn badge data).
- `app/(app)/recruitment/cycles/[id]/page.tsx` (exclude withdrawn from counts).
- The applicant detail page (staff reopen control).

`captureEvent("application_withdrawn", { slug, stage })` with
`termGroupForCycleSlug(slug)`, matching the shape in `draft-actions.ts:17-22`.

## Testing

`withdraw.test.ts`:

- Each stage's allowed and denied transitions.
- The `PROMOTED` ceiling refuses withdrawal.
- A second call is idempotent and sends no second notification.
- An attempt against another applicant's application is refused.
- `Acceptance`, `OnboardingContract`, and `Interview` rows survive untouched.

Regression coverage that a `WITHDRAWN` application is absent from
`listApplicantsForReview`, `pendingReviewCount`, the speed-routing pool, and the
cycle-overview department counts.

`portal-status.test.ts` and `portal-tracker.test.ts` for the new state and the
hidden tracker.

Draft discard: blob keys are cleaned up, the `Applicant` row is deleted, and the
applicant can start a fresh application in the same open cycle.

One e2e pass: submit, withdraw, confirm the status card reads "Withdrawn".

## Risks

**A withdrawn applicant is invisible to reviewers who were mid-evaluation.** The
review queue drops them, which is the point, but a reviewer with a half-written
evaluation loses their subject with no explanation. `CommitteeScore` and
`Evaluation` rows survive, so nothing is destroyed; the applicant detail page
remains reachable by direct link. Accepted as-is.

**Notification volume during a large cycle.** Only the interview and accepted
stages notify, which bounds it to the population that has already consumed staff
time. If it still proves noisy, the per-type channel routing in the notification
registry lets an admin retarget or quiet it without a code change.
