# Rescind an emailed acceptance from the routed-decision applicant page

Date: 2026-07-21
Status: approved, ready for planning

## Problem

An applicant on a VOLUNTEER-track cycle who was routed to a department and decided
directly from the committee score (no interview) can reach a state with no way out.

Once that department's acceptance has been emailed, two guards fire:

- `decideRoutedApplication` (`src/modules/recruitment/services/routing.ts:134`) blocks
  moving the decision to Reject or Waitlist: "This applicant has already been emailed
  their acceptance or started onboarding. Rescind the acceptance before changing this
  decision."
- `routeApplication` (`src/modules/recruitment/services/routing.ts:61`) blocks
  re-routing to a different department: "Rescind it before re-routing."

Both tell the reviewer to rescind. The rescind capability exists but its only UI is on
the interview detail page (`src/app/(app)/recruitment/interviews/[interviewId]/page.tsx:195-207`).
A routed decision taken without an interview has no interview record, therefore no
interview page, therefore no reachable rescind control anywhere in the app. The warning
is an instruction with nothing behind it.

A second, independent defect surfaced while tracing this. The applicant detail page uses
a single `?error=` query param, and only the Department decision card renders it. Errors
from `routeAction` and `committeeScoreAction` therefore appear in the decision card,
detached from the Route button and the score form that produced them.

## What already exists

- `revokeAcceptance(acceptanceId, actorId)` at `src/modules/recruitment/services/review.ts:195`
  deletes the Acceptance row and writes an audit entry.
- It self-authorizes. Line 210 requires the actor to be in scope for the department;
  line 212 requires `review_all` (SRR) when `emailedAt` is set; line 206 refuses outright
  when an onboarding contract exists, because `OnboardingContract.acceptance` is
  `onDelete: Cascade` and deleting would destroy signatures, DOB, and HIPAA cert data.
- Exposed as `rescindAcceptanceAction` at `src/app/(app)/recruitment/interviews/actions.ts:75`,
  which redirects back to the interview page and so cannot be reused here.

## Decisions

**Permission: SRR only.** The applicant page mirrors the interview page exactly. A
director in scope for the routed department sees the warning plus "Ask an SRR to rescind
it first." No service change is required, because `revokeAcceptance` line 212 already
enforces this server-side.

**Copy: one shared component, not a second inline copy.** Amended after the plan's
pre-flight review. The warning and its control move into
`RescindAcceptanceNotice` at `src/modules/recruitment/components/rescind-acceptance-notice.tsx`,
consumed by both the interview detail page and the applicant page. The original design
called for copying the block verbatim, which achieved identical wording only by
convention; a single component makes drift structurally impossible. The component keeps
the interview page's existing wording unchanged, so that page's rendered output stays
byte-identical and its Playwright coverage is unaffected. This widens the change to touch
the interview page, which the first draft of this spec did not anticipate.

**Onboarding contracts stay out of scope.** If a contract exists, `revokeAcceptance`
throws and the action surfaces "Remove the onboarding contract before revoking the
acceptance." There is no UI anywhere to tear down an onboarding contract, so that path
remains a dead end with a different message. This is a known, deliberate gap and warrants
its own issue rather than a silent fix inside this change.

**No applicant-facing email on rescind.** The applicant has already been told they are in.
Nothing un-tells them. This matches interview-page behavior today and stays a manual
conversation.

## Change 1: rescind control

New action in `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts`. It wraps the
same service as the interview action but bounces through this page's `bounce()` helper:

```ts
export async function rescindAcceptanceAction(cycleId: string, applicationId: string, acceptanceId: string) {
  const person = await requirePersonSession();
  try {
    await revokeAcceptance(acceptanceId, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof AcceptanceError) {
      redirect(bounce(cycleId, applicationId, { error: (err as Error).message }));
    }
    throw err;
  }
  redirect(bounce(cycleId, applicationId, { saved: "rescind" }));
}
```

`revokeAcceptance` joins the existing `@/modules/recruitment/services/review` import.

UI in the `canDecideRouted` branch of
`src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`, replacing the
bare warning at lines 282-286:

```tsx
{emailedAcceptance && (
  <div className="mt-3 space-y-3">
    <Alert tone="warning">
      This applicant has already been emailed their acceptance for {app.routedDepartmentCode}. Changing to Reject or Waitlist is blocked until the acceptance is rescinded.{" "}
      {scope.all ? "Rescind it below, then record the new decision." : "Ask an SRR to rescind it first."}
    </Alert>
    {scope.all && (
      <form action={rescindAcceptanceAction.bind(null, id, applicationId, emailedAcceptance.id)}>
        <ConfirmButton label="Rescind acceptance" size="sm" />
      </form>
    )}
  </div>
)}
```

Also add a `saved === "rescind"` success alert ("Acceptance rescinded.") and imports for
`ConfirmButton` and the new action.

`emailedAcceptance` (page line 62) already carries `.id`, since `listAcceptances` returns
full `Acceptance` rows.

Post-rescind behavior matches the interview page. The Acceptance row is deleted,
`Application.decision` stays `ACCEPT`, and both guards lift, so the reviewer can then
re-route or record Reject or Waitlist.

## Change 2: per-card error routing

Rule: each card renders its error directly above the form that produces it, and no card
renders another card's error.

- `bounce()` gains `routeError` and `scoreError` alongside `error`.
- `routeAction` bounces `routeError`, rendered in the Routing card above the Route form.
- `committeeScoreAction` bounces `scoreError`, rendered in the Committee score card above
  the score form.
- `decideRoutedAction` and `reopenDecisionAction` keep `error`. The alert moves off the
  card top (page line 258) to sit immediately above the Record decision form, with a
  second placement above the Reopen button in the not-routed branch, which has its own
  control.
- The DIRECTOR branch is untouched. `scheduleInterviewAction` is its only error producer
  and already renders in the correct card.

Note on the reported symptom: the error in the original screenshot came from
`decideRoutedAction` and was already in the correct card. Its only flaw was vertical
distance from the Record decision button, which the move above fixes. The `routeAction`
and `committeeScoreAction` misrouting is real but is reached by clicking Route or
submitting a score, not by the path in the screenshot.

## Testing

`revokeAcceptance` needs no new service tests. `src/modules/recruitment/services/review.test.ts:186-211`
already covers in-scope director revoking an un-emailed acceptance, director blocked and
SRR allowed on an emailed one, and contract-bearing acceptances refused even for SRR.

New and updated tests in `src/app/(app)/recruitment/cycles/[id]/applicants/actions.test.ts`,
whose existing fixture already builds a VOLUNTEER cycle routed to EDUC with an emailed
acceptance:

1. SRR rescind deletes the Acceptance row and redirects to `?saved=rescind`.
2. A department-scoped director rescinding gets a redirect to `?error=` carrying the auth
   message, not an uncaught throw. Requires adding a scoped director to `seed()`,
   mirroring `review.test.ts`.
3. After an SRR rescind, `decideRoutedApplication(..., "REJECT")` succeeds. This is the
   regression that matters: it proves the dead end is gone.
4. Updated: the existing assertion at line 56 flips from `?error=` to `?routeError=`.
5. New: `committeeScoreAction` error asserts `?scoreError=`.

Verification before push, in order: `npx vitest run` on the touched test files, then
`npx tsc --noEmit`, then the full `npm run lint` across the repo, since ESLint boundary
rules do not surface under typecheck or tests alone.

## Risks

The Playwright suite runs comprehensively in CI and cannot run locally against this
worktree. UI label changes have broken it before. The rescind button is additive and the
error changes are query-string only, so exposure reads as low, but it is unproven locally
and no claim about e2e passing should be made until CI reports.

## Out of scope

- Onboarding contract teardown UI. Rescind stays blocked for applicants who have started
  onboarding. Should be filed separately.
- Any applicant-facing notification that an acceptance was withdrawn.
- The DIRECTOR-track branch of the applicant detail page.
