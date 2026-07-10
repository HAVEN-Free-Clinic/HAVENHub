# HAVEN Hub full-app audit, third pass (2026-07-10)

Third comprehensive multi-agent audit, run against `main` at `c78d7e6` (after the two fix waves: PRs #199-#215 and #217-#227, plus #229 clinic-access gating). Method: 16 parallel finders (12 area sweeps + 4 cross-cutting lenses: security/authz, concurrency/races, data-integrity, regression) feeding a dedup pass and an adversarial verifier that defaults to REJECT.

Result: 32 raw findings, 30 after dedup, **27 CONFIRMED, 3 rejected, 0 uncertain**. After merging two exact duplicates, **24 distinct defects: 9 medium, 15 low, zero critical, zero high.**

## Headline

Two clusters account for more than half the findings, and both are direct siblings of the previous wave's fixes, i.e. the wave guarded one path and left an identical path unguarded. This is exactly the class the audit was tuned to hunt after two prior waves.

- **RBAC last-admin lockout family** (M5, M9, L7, L8, L16). The last wave (PR #225) hardened the offboard population count; it left the `deleteAssignment` row-vs-holder gap, the roster-mutation paths, the offboard concurrency window, and an inert-assignment over-block all unguarded.
- **Incidents subject-exclusion family** (M4, M6, M7, plus support L6). The last wave (PR #224) walled the subject off from `getReport`/`reviewReport`/`decideStrike`; it left the attachment-download route and both notification fan-outs open.

The absence of any critical or high finding after three passes is itself the signal: the reachable high-severity surface is exhausted; what remains is edge-case correctness and defense-in-depth.

## Medium (9)

### M1 - Promotion does not reactivate a REMOVED membership
`src/modules/recruitment/services/promotion.ts:67` - data-integrity.
The membership lookup ignores `status`, and offboarding leaves a `REMOVED` membership row in place rather than deleting it. A previously-offboarded person who re-applies as NEW, is accepted, and is promoted gets `Person.status = ACTIVE` and a PROMOTED contract, but their `REMOVED` membership is never flipped back to ACTIVE, so they are silently absent from every ACTIVE-keyed roster, the scheduler, and compliance. Fix: reactivate a found REMOVED row to ACTIVE.

### M2 - False "Not selected" once decisions are released
`src/modules/recruitment/services/portal-status.ts:66` - correctness.
`NOT_SELECTED` is derived purely from the cycle-level `decisionsReleasedAt` plus zero acceptances. Release is allowed on an OPEN cycle, is repeatable/batched, and survives reopen, so a newly-submitted or not-yet-reviewed application shows a definitive "Not selected this cycle" before anyone reviews it. Fix: gate on a per-application signal (submitted at/before the release timestamp, or an actual per-application decision).

### M3 - 48h reminder cron notifies the wrong director set
`src/app/api/cron/schedule-reminders/route.ts:70` - correctness.
The pending-request reminder resolves recipients from `ShiftAssignment role=DIRECTOR`, the exact heuristic PR #226 replaced everywhere else with `requestApproverRecipients()` (directors by ACTIVE membership + one-hop delegated + in-department `manage_requests` holders). It misses membership-only and delegated approvers and reminds nobody when a delegated department has no local director shift. Fix: export and reuse `requestApproverRecipients` in the cron.

### M4 - submitReport commits before validating attachments
`src/modules/incidents/services/report.ts:438` - data-integrity.
The report row is created and audited before uploaded files are validated, and the file-validation throw sits outside the try and before `notifyReviewersOfSubmission`. An oversized attachment leaves an orphaned committed report (an immediate-risk one, with no reviewer notified) while the submitter is redirected as if it failed, so they re-file and duplicate. Fix: validate all files before `create`.

### M5 - Last-admin guard counts rows, not authenticatable holders
`src/modules/admin/services/rbac.ts:441` - security.
`deleteAssignment` refuses only when the admin-role assignment count is 1, never checking whether those rows resolve to an ACTIVE person who can authenticate. An offboarded ex-admin's still-present assignment counts as "live" but is inert, so deleting the sole real admin passes the guard and locks the admin module for everyone (shell `db:seed` recovery). Fix: count effective ACTIVE holders (reuse `assertNotLastActiveAdmin`).

### M6 - Attachment download misses the subject-exclusion wall
`src/app/api/incidents/attachments/[id]/route.ts:64` - security.
Every other report path blocks a manager who is the report's subject; the attachment route checks only `reporterId || can(manage)`, so a subject-manager can download the evidence about themselves (potentially reporter-identifying). Reachability is bounded because the attachment id is a non-enumerable cuid surfaced only on a page the subject cannot open, so it is a defense-in-depth gap. Fix: add the `subjectPersonId !== me` check.

### M7 - Submission notification reaches the subject-manager
`src/modules/incidents/services/report.ts:222` - security.
`notifyReviewersOfSubmission` fans out to all `incidents.manage` holders with no subject filter, despite its own comment saying the subject is never a recipient. A subject who holds `incidents.manage` receives the `strike_requested` notification that names them, learning a confidential strike targets them before it is decided. Fix: filter `subjectPersonId` out of the recipient set.

### M8 - A director can verify their own HIPAA certificate
`src/modules/volunteers/services/compliance.ts:457` - security.
`verifyCertificate` authorizes with `canViewCertificate`, whose first rule returns true for self (correct for the download route, wrong for the verify mutation). A director can verify their own self-uploaded cert, flipping `PENDING_VERIFICATION` to COMPLIANT and clearing themselves for scheduling with no independent review, defeating the separation-of-duties gate. Fix: require an independent verifier and block self.

### M9 - Offboard last-admin check is a non-transactional write-skew
`src/modules/volunteers/services/offboarding.ts:220` and `src/app/(app)/admin/people/[id]/page.tsx:67` - race-condition.
The last-admin assertion is a standalone read, then the status flip commits in a separate transaction, so two concurrent offboards of the last two admins both pass and leave zero admins. The sibling `deleteAssignment` guard deliberately wraps its check in a Serializable transaction to prevent exactly this. Fix: run the check inside the same Serializable transaction as the status flip.

## Low (15)

- **L1** `interviews.ts` / `interview-decisions.ts` lack the `SUBMITTED` guard `acceptApplicant` got in PR #217, so a DRAFT director application can technically be interviewed and accepted (SRR-only, id needed out-of-band). consistency.
- **L2** `recruitment/actions.ts:30` duplicate cycle `publicSlug` throws an uncaught P2002, giving a generic 500 instead of the friendly reserved-slug flow beside it. correctness.
- **L3** `schedule/components/builder-grid.tsx:276` the Grid view renders one row per ACTIVE member, so an offboarded assignee with a live future shift is invisible and cannot be cleared (the Day view was fixed for this in M12; the Grid was not). consistency.
- **L4** `learning/services/enrollment.ts:233` `persistScoCmi` validates `scoreRaw` but not `scoId` (not checked against the course manifest) or `suspendData` length, so an assigned learner can create unbounded orphan `ScoProgress` rows with large TEXT payloads. data-integrity.
- **L5** `training/training-quiz.tsx:136` a training cycle designated with no quiz questions renders a NaN-width progress bar and an enabled Submit button that always throws. correctness/ui.
- **L6** `support/new/page.tsx:47` a support ticket submit that fails attachment validation redirects before the manager triage alert and requester confirmation are sent, so the ticket sits un-triaged. correctness.
- **L7** `admin/services/roster.ts:189` `removeMembership` / `changeMembershipKind` bypass the last-admin invariant enforced on the offboard path, so removing/demoting the last kind- or department-scoped admin locks everyone out. security.
- **L8** `admin/people/[id]/page.tsx:67` the admin-page caller of the same non-transactional offboard write-skew as M9. race-condition.
- **L9** `recruitment/services/submissions.ts:259` the draft to SUBMITTED update has no atomic status claim (sibling of the hardened `submitContract`), so concurrent submits duplicate the confirmation email and orphan a blob. race-condition.
- **L10** `onboarding/services/onboarding.ts:82` the EHS onboarding task links to `/my-info`, which the onboarding gate is not allowlisted for, so the CTA dead-ends back to `/get-started`. consistency.
- **L11** EHS training create/update throws an uncaught P2002 on a duplicate `name` (a 500) instead of the app's friendly domain-error redirect. correctness.
- **L12** `email/audience/person-fields.ts:150` the `role` audience field lacks the blank to MATCH_NOBODY guard that `status` and `complianceStatus` have, so a hand-edited blank value 500s (or, when missing, over-matches all members). correctness.
- **L13** `email/sender-rules.ts:30` `SENDER_CATEGORIES` omits the `support` and `incidents` groups, so there is no category-level send-from control for them though the resolver already honors them. consistency.
- **L14** `admin/services/email-templates.ts:114` a template override can be saved with an empty subject (used verbatim), unlike the campaign path which rejects it. correctness.
- **L15** `recruitment/services/decisions.ts:86` `releaseDecisions` stamps `emailedAt` with an unconditional update, so two concurrent releases double-send the acceptance email. race-condition.
- **L16** `admin/services/rbac.ts:447` the last-admin guard over-blocks deleting an inert (non-live term) admin assignment when one live assignment of the same role exists. correctness.

## Rejected (3)

The adversarial verifier rejected 3 of the 30 deduped findings as already-guarded or non-reproducible against the current code.

## Landscape shift during the fix

Three PRs merged to `main` while the fixes were in flight, two of which intersected the audit:

- **#230** (`restrict cert verification to managers and admins, directors read-only`) independently resolved **M8**: directors can no longer verify certificates at all, so the director self-verify path the finding described is closed. The compliance PR was reduced to L11 only. A narrower residual remains (a compliance manager can still verify their own certificate), noted here for the record but left to the deliberate #230 design.
- **#231** (`link multiple people involved, with per-person strike requests`) refactored the incidents subject model from a single `subjectPersonId` to an `IncidentReportSubject` join table. All three incidents findings (M4, M6, M7) were re-verified as still-present against the new model and re-expressed through the `report.subjects` relation before landing.
- **#232** (dashboard clearance) was disjoint from every theme.

## Delivery

Fixed across 8 file-disjoint PRs (one per theme), each typechecked and linted, with tests added for the data-integrity and race-condition items:

- Incidents + support: M4, M6, M7, L6 - PR #233 (rebased onto the multi-subject model)
- RBAC last-admin family: M5, M9, L7, L8, L16 - PR #240
- Recruitment lifecycle: M1, M2, L1, L2, L9, L15 - PR #239
- Schedule: M3, L3 - PR #238
- Learning: L4, L5 - PR #236
- EHS: L11 - PR #237 (M8 resolved upstream by #230)
- Email platform: L12, L13, L14 - PR #234
- Onboarding gate: L10 - PR #235
