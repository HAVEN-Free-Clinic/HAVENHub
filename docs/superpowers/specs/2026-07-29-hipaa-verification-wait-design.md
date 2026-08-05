# The HIPAA verification wait (2026-07-29)

## Problem

A volunteer uploads their HIPAA certificate. The PDF parses, a completion date is read, and the
certificate sits in `PENDING_VERIFICATION` until a compliance manager confirms it. Until that
happens the onboarding gate blocks them from every page in the application.

Three separate defects turn that ordinary wait into the worst uncontrolled state in the product.
They were found and independently verified in the 2026-07-29 UX audit (PR #474), where they rank
1st, 18th, and 19th of 88 items. The audit is explicit that they describe one moment and must
ship together.

1. **The checklist contradicts the step page, one click apart.** The step page says "Completion
   date pending. A compliance manager will verify the completion date. No action is needed from
   you." The checklist, one click away, still shows a warning badge reading "Action needed", the
   description "Upload your current HIPAA certificate", and a primary button "Upload
   certificate". The only action offered is the one that changes nothing.
2. **The wait explains nothing, unless the parser failed.** In the pending state the panel shows
   an amber "Awaiting verification" badge and a detected date. The reassuring sentence that would
   explain who verifies, how long it takes, and that no action is needed is gated on
   `completionDate === null`, so it renders only when the PDF parse **failed**. The case where
   everything worked gets two words; the broken case gets the explanation.
3. **Verification never tells the member it happened.** `verifyCertificate` stamps `verifiedAt`,
   writes an audit row, and fires a PostHog event. It queues no email and creates no notification
   for the certificate owner. The upload side is fully wired in the other direction, under a
   comment that reads "date but unverified -> a manager must verify it (blocks the member until
   then)". The code knows this state blocks the member, notifies the manager, and never closes
   the loop back.

Together: a volunteer whose only outstanding blocking item is verification is locked out of the
whole app by an event they are never told about, while being told to do the one thing that will
not help. The only way to learn they are cleared is to keep signing in and checking.

## Goals

Tell the volunteer the truth about where their certificate is, and tell them when it clears.

## Non-goals

- **Changing who is gated, or when.** The gate's behavior is deliberately untouched. `IN_PROGRESS`
  still fails `isSatisfied`, so exactly the same people are blocked before and after. This is a
  change to what the app says, not to what it enforces.
- Auto-verification, or any change to the compliance manager's review workflow.
- The other 85 audit findings.

## Design

### 1. Give the HIPAA task the IN_PROGRESS state the engine already models

`src/modules/onboarding/engine/status.ts`, `deriveHipaaTaskState` currently returns COMPLETE for
`COMPLIANT` and `EXPIRING_SOON` and INCOMPLETE for everything else, so `PENDING_VERIFICATION` and
`UNKNOWN_DATE` collapse into the same state as `NO_CERTIFICATE`.

Return `IN_PROGRESS` for `PENDING_VERIFICATION` and `UNKNOWN_DATE`. Keep INCOMPLETE for
`NO_CERTIFICATE` and `EXPIRED`.

This introduces no new concept. `OnboardingTaskState` already includes `IN_PROGRESS`, and both
`deriveTrainingTaskState` and `deriveLearningTaskState` already return it for exactly this shape
of situation. `StatusPill` already renders it as a neutral "In progress" badge and `TaskRow`
already downgrades a non-INCOMPLETE call to action to the outline variant, so the checklist stops
shouting without any new rendering code.

Then branch the row's copy for that state: description "We have your certificate. A compliance
manager is confirming the date." and call to action "View certificate".

> **2026-07-29 note (post-implementation):** the description above was superseded during the run.
> `IN_PROGRESS` covers both `PENDING_VERIFICATION` and `UNKNOWN_DATE`, and for the latter there is
> no date yet for anyone to confirm. The shipped copy is "We have your certificate. A compliance
> manager is reviewing it." (`src/modules/onboarding/services/step-config.ts`), which is accurate
> for both substates. The call to action, "View certificate", shipped as specified.

### 2. Explain the wait to the person actually waiting

`src/modules/my-info/components/hipaa-panel.tsx`. Widen the reassurance condition from
`completionDate === null` to cover both `UNKNOWN_DATE` and `PENDING_VERIFICATION`, and branch the
copy so each state gets the sentence that fits it. The pending copy states that we have the
certificate, what date we read, who confirms it, roughly how long that takes, that we will tell
them, and that they do not need to upload again. It closes with a support contact for the case
where the wait runs long, using the existing `SupportLink` and `getSupportContact()` rather than a
hardcoded address.

> **2026-07-29 note (post-implementation):** "roughly how long that takes" was deliberately
> omitted from the shipped copy in `hipaa-panel.tsx`; see the Risks note below on the timeframe
> claim. The rest of this paragraph shipped as specified.

Move the "Upload New Certificate" section behind a "Replace this certificate" disclosure while a
certificate is awaiting review, so re-uploading stops being the visually obvious next step.

### 3. Close the loop when it clears

`src/modules/volunteers/services/compliance.ts`, inside `verifyCertificate`'s existing
`if (!cert.verifiedAt)` transition block, notify the certificate owner.

The existing pattern lives in `src/platform/compliance/review-notifications.ts`: a named helper
per notification type that renders an email through `renderEmail("<descriptor>", context)` and
dispatches through `notify()`. Follow it. That means this change is four pieces, not one:

- a new entry in `NOTIFICATION_TYPES` with `defaultChannel: "email"`, matching all 22 existing
  types and the registry's stated reason ("always email so behavior is unchanged on first
  deploy"); admins can re-route it in `/admin/notifications` afterward
- a new email template descriptor, its context builder, and a default body
- a `notifyCertVerified` helper alongside its siblings
- the call site in the transition block

**Scope correction.** The audit sized this finding as `S` and described it as "one call plus a
notification-type registration". That was wrong: the email template descriptor is required
because the helpers render through `renderEmail`. This is realistically `M`. Recorded here rather
than discovered during implementation.

**Failure isolation.** A notification failure must not surface to the manager as a failed
verification. The certificate is already durably updated and audited by that point. Wrap the call
the way `saveCertificate` wraps its manager alerts: catch, log, continue.

> **2026-07-29 note (post-implementation, gap found in final review):** this section scoped only
> `verifyCertificate`. That was a gap in this spec, not an implementation miss. A certificate whose
> PDF does not parse (`UNKNOWN_DATE`) never reaches `verifyCertificate` at all; it clears through
> `setCompletionDateAsManager`, the other function that can flip a cert from unverified to
> verified (its own `if (!cert.verifiedAt)` transition block, alongside its own
> `hipaa_certificate_verified` capture with `via: "set_date"`). That path is wired into three
> manager UIs and is the live route for the whole dateless-certificate population. Both
> transitions must notify the owner identically; the implementation extracts the shared
> owner-lookup-and-notify logic into one local helper (`notifyCertOwnerOfVerification` in
> `compliance.ts`) called from both places, rather than duplicating the try/catch block.

## Testing

- `deriveHipaaTaskState` over all five `ComplianceStatus` values, asserting the two that move to
  `IN_PROGRESS` and the two that stay `INCOMPLETE`. `status.test.ts` already covers the sibling
  derivations in this shape.
- The gate is unchanged: a person whose only incomplete blocking task is a pending HIPAA
  certificate is still not onboarded. This is the test that proves the non-goal held.
- `verifyCertificate` queues exactly one notification on the first transition and **none on a
  repeat call**. The guard is `if (!cert.verifiedAt)`, so a double-verify must not double-notify.
- A notification failure does not fail the verification.

## Risks

- **Copy is being written by an agent for a compliance-adjacent flow.** The strings are drafted
  from the audit's proposals and are meant to be edited in review. The claim "usually within a few
  days" is an operational promise this repo cannot verify; it needs Jack's confirmation or
  softening before merge.

  > **2026-07-29 note (post-implementation):** resolved, not merely confirmed, by removing the
  > timeframe claim entirely. The shipped copy in `hipaa-panel.tsx` never states or estimates how
  > long verification takes; it names who verifies, what was read, that no upload is needed, and a
  > support contact for a wait that runs long. There was no promise left to confirm or soften.
- **A new notification type is a new outbound email to every affected volunteer.** It defaults to
  email and fires once per verification transition. That is the intent, but it is the first thing
  to check if send volume looks wrong after deploy.
