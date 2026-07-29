# Task 10: Code-read volunteers, incidents review, support management, and learning management

Code-read 2026-07-29, no browser or dev server. Tier 2: director/admin surfaces, audited at
lower depth than the volunteer-facing tier. Every claim below is source-verified by reading the
file(s) cited; none were confirmed by running the app, so where a finding depends on runtime
behavior that is called out explicitly in the row.

Read in full: `src/app/(app)/volunteers/compliance/[personId]/page.tsx`,
`src/app/(app)/volunteers/master/page.tsx`, `src/app/(app)/volunteers/page.tsx`,
`src/app/(app)/volunteers/ehs/page.tsx`, `src/app/(app)/volunteers/ehs/manage/page.tsx`,
`src/app/(app)/volunteers/ehs/manage/[trainingId]/page.tsx`,
`src/app/(app)/volunteers/spanish-review/page.tsx`, `src/app/(app)/volunteers/offboarding/page.tsx`,
`src/app/(app)/volunteers/layout.tsx`, `src/app/(app)/incidents/review/page.tsx`,
`src/app/(app)/incidents/strikes/page.tsx`, `src/app/(app)/incidents/strikes/strike-row.tsx`,
`src/app/(app)/incidents/[id]/page.tsx`, `src/app/(app)/incidents/actions.ts` (review/strike-decision
actions), `src/app/(app)/support/all/page.tsx`, `src/app/(app)/support/epic/page.tsx`,
`src/modules/support/components/epic-request-form.tsx`,
`src/modules/support/components/epic-request-tabs.tsx`,
`src/modules/support/components/request-filters.tsx`, `src/modules/support/components/request-list.tsx`,
`src/app/(app)/learning/manage/page.tsx`, `src/app/(app)/learning/manage/[courseId]/page.tsx`,
`src/app/(app)/learning/manage/[courseId]/UploadPackageForm.tsx`,
`src/app/(app)/learning/manage/actions.ts`, `src/app/(app)/learning/dashboard/page.tsx`.
Followed into supporting source to verify specific claims (cited inline):
`src/platform/ehs/engine/applicability.ts`, `src/platform/ehs/services/trainings.ts`,
`src/modules/learning/services/courses.ts`, `src/modules/incidents/services/report.ts`
(`decideStrike` only), `src/modules/incidents/services/strike-notifications.ts`,
`src/platform/ui/confirm-button.tsx`, `src/modules/my-info/components/certificate-viewer.tsx`,
`src/modules/support/services/tech-request.ts` (`TechRequestListRow` shape only),
`src/modules/support/labels.ts`, `src/modules/support/components/term-batch-tab.tsx` (partial).

**Pre-seeded finding verified NOT reproducing:** the brief flagged a silent `navigator.clipboard?.writeText`
call with zero confirmation in `epic-request-form.tsx` around line 495. The current `handleCopyEmail`
(lines 157-169) already checks `navigator.clipboard` explicitly, awaits the write, and drives a
`copyState` that renders "Copied to clipboard" or "Copy failed. Select the text above and copy
manually." via an `aria-live` region (lines 476-491). `git log -p` shows this was fixed in commit
`f007277b` ("fix(ui): IT support / tech requests accessibility + polish (audit PR)"), well before this
audit. The same pattern in `src/modules/support/components/term-batch-tab.tsx:141-153` has the
identical fixed shape. Not filed.

## Findings

| id | surface | lens | severity | reach | what is wrong | concrete fix | effort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F-10-1 | `src/app/(app)/learning/manage/[courseId]/page.tsx:76-93` | ia | costs-time | every learning manager assigning a course to specific departments, each course they scope | The "Assign to all departments" checkbox (line 77) and the per-department checkbox grid (lines 86-93) sit in the same form with no text, disabled state, or visual link between them, but they are not independent settings: `requiredTrainingsForMember`-equivalent logic for courses (`setCourseAssignment`, `src/modules/learning/services/courses.ts:66-82`) writes `assignToAll` and the `departmentIds` list as two separate columns, and I traced the read side (`src/modules/learning/services/enrollment.ts`) where `assignToAll` alone gates whether a course applies to a member, making the department list inert whenever it is checked. A manager can tick specific departments, leave "Assign to all departments" checked from a prior save, click "Save assignment," and the course still goes to everyone with no on-screen indication their department picks did nothing. The EHS training edit page has the identical `requiredForAll`-overrides-`departmentIds` relationship (`src/platform/ehs/engine/applicability.ts:43-47`) but at least carries a hint sentence, "When not required for all, choose the departments this training applies to" (`src/app/(app)/volunteers/ehs/manage/[trainingId]/page.tsx:71-73`); the Learning course page has no equivalent text at all, so it is the sharper instance of the same recurring pattern. Not confirmed by running the app; the override relationship is read from the two services directly, not observed rendered. | Disable (or visually gray out) the department checkbox grid when "Assign to all departments" is checked, and add the same one-line hint EHS already uses: "When not assigned to all, choose the departments this course applies to." Apply the same disabled-state treatment to the EHS training page's checkbox grid for consistency, since its hint text alone does not stop the checkboxes from staying live and clickable. | S |
| F-10-2 | `src/app/(app)/incidents/[id]/page.tsx:354-374` | flow | blocks | every incidents.manage reviewer who approves a strike request tied to an anonymous report; narrow but high-stakes when it occurs | The "Approve strike" form gives the reviewer a category select and a notes field, with no text anywhere on the page stating that approving a strike on an anonymous report automatically marks the resulting `DisciplinaryAction` confidential. That branch lives in `decideStrike` (`src/modules/incidents/services/report.ts:1035`, `confidential: report.anonymous, // anonymous report -> strike hidden from directors`) and its consequence is real: `notifyStrikeIssued` skips every department director when `action.confidential` is true (`src/modules/incidents/services/strike-notifications.ts`, the `if (action.confidential) return;` gate right after the subject-facing email). The page does surface `report.anonymous` itself, in the unrelated "Reporting details" card above ("Reporter asked to remain anonymous to the subject.", line ~272), but nothing connects that fact to what clicking "Approve strike" is about to do. A reviewer who wants the subject's directors looped in has no way to know, at the moment they decide, that this particular approval silently forecloses that. The "Confidential" badge only appears afterward, on the separate `/incidents/strikes` ledger (`strike-row.tsx:90`). This is a distinct reviewer-side manifestation of the anonymity pattern Task 8 filed from the reporter's side (F-08-1): that finding is about the reporter not knowing who reads their name, this one is about the reviewer not knowing their own approval click will silently exclude directors. Not confirmed by running the app; the confidentiality derivation and the notification gate are read directly from the two service files. | Add a line inside the "Approve strike" form when `report.anonymous` is true: "This report was submitted anonymously, so the resulting strike will be marked confidential and the subject's department directors will not be notified." Surface the same fact next to the "Confidential" badge is already rendered on `/incidents/strikes` so it reads consistently before and after the decision. | S |
| F-10-3 | `src/modules/support/components/request-list.tsx:36-75`, feeding `src/app/(app)/support/all/page.tsx` | ia | costs-time | every support.manage_requests holder triaging the master ticket queue, on every visit | `TechRequestListRow` carries `priority` (`src/modules/support/services/tech-request.ts:164`, populated from the DB on both `listMyRequests` and `listAllRequests`), `RequestFilters` lets a manager filter `/support/all` by priority (LOW/MEDIUM/HIGH/CRITICAL, `request-filters.tsx:102-117`), and the single-ticket detail view lets a manager set it (`ticket-detail.tsx:219-230`, "Update priority"). But the shared `RequestList` table both `/support` and `/support/all` render never displays it: the columns are `#`, `Subject`, `Category`, `Requester`, `Status`, `Updated` (lines 40-45), with no Priority column and no `PriorityBadge` component anywhere in `status-badge.tsx`. A manager looking at "All requests" with no priority filter applied cannot tell a CRITICAL ticket from a LOW one without opening each row individually, even though the app already models and lets them filter on exactly that field. This is the table meant for clinic-wide IT triage, and it has no visual hierarchy for the one field that exists to drive triage. Not confirmed by running the app; confirmed from the shared row type, the filter bar, and the absence of any priority rendering in `request-list.tsx` and `status-badge.tsx`. | Add a Priority column to `RequestList` (a small `Badge` with tone by priority, mirroring the `EPIC_STATUS_TONE` pattern already used for Epic requests), shown at least on the `showRequester` (manager) variant so `/support/all` sorts urgency into view without a click. | S |
| F-10-4 | `src/app/(app)/learning/dashboard/page.tsx:94` | flow | polish | learning managers resetting a learner's course progress, an infrequent action | The per-row "Reset" button (`<ConfirmButton label="Reset" size="sm" />`) uses the component's default `confirmLabel`, a bare "Confirm?", even though resetting wipes a learner's SCORM completion and forces a retake (`UploadPackageForm.tsx:17`'s own copy for the same underlying reset describes it as "Learners who already completed it will need to retake the new content"). Every other destructive `ConfirmButton` in this task's scope names its consequence in the confirm step: `offboarding/page.tsx:243` ("Offboard {name}? This removes all their active memberships."), `strike-row.tsx:101` ("Delete this disciplinary action? This cannot be undone."), `incidents/[id]/page.tsx:372` ("Confirm strike?"), `ehs/page.tsx:99` ("Unmark?"). This is the one instance in scope that falls back to the generic label, so a manager scanning a 25-row completion table and misclicking one row's Reset gets a confirm step that does not remind them what they are about to erase. Not confirmed by running the app; confirmed by comparing this call site's props against every other `ConfirmButton` call in the audited files. | Give it a descriptive `confirmLabel`, e.g. `confirmLabel={`Reset ${r.name}'s progress? They will need to retake this course.`}`, matching the pattern already used everywhere else. | S |
| F-10-5 | `src/app/(app)/volunteers/ehs/page.tsx:48-63` | flow | costs-time | volunteers.manage_compliance holders using the EHS dashboard, every time they touch the "Added to EHS?" column | The "Added to EHS?" column sits directly left of the real per-training completion cells, styled with the same pill/button treatment (`Added`/`Add`, primary vs. outline), so it visually reads as one more compliance signal. It is not: `addedToEhs` is a bare boolean on `Person` (`src/platform/ehs/services/flag.ts`) that `requiredTrainingsForMember`/`missingTrainings` (`src/platform/ehs/engine/applicability.ts`) never reads, so toggling it has zero effect on anyone's clearance or the COMPLETE/MISSING cells beside it. The only other places it appears are the legacy Airtable import (`src/platform/airtable/import/ehs.ts`, mirroring a field from the old system) and email-audience targeting (`src/platform/email/audience/person-fields.ts`). Nothing on the page, or anywhere else in the app, tells a manager what "Added to EHS" actually represents or why it's distinct from the training-completion cells right next to it; understanding it correctly requires knowing about the retired Airtable tracker, which is knowledge held outside the app entirely. A manager could reasonably believe toggling "Added" marks someone as EHS-compliant, when it does nothing of the sort. Not confirmed by running the app; the inert-for-compliance conclusion is read directly from `applicability.ts` never referencing `addedToEhs`. | Add a tooltip or hint line under the column header: "Administrative flag carried over from the legacy roster tracker; does not affect compliance status or the columns to the right." If the field has no remaining operational purpose beyond email targeting, consider whether it still belongs on the compliance dashboard at all versus the audience-builder's field picker. | S |

## Needs its own brainstorm

None. Every finding above is S effort (copy/badge/disabled-state changes); none require a design
pass before implementation.

## Coverage notes

- **Pure code read, no runtime verification.** No dev server or browser was used for this task, per
  its brief. Every row above is traced from source; where a finding depends on a state combination
  or rendered output I could not observe live, that is called out inline in the row.
- **Pre-seeded "Copy email" finding does not reproduce.** Verified and documented above (fixed in
  commit `f007277b`, prior to this audit). Not filed as a finding; noted per the brief's instruction
  to confirm reproduction before filing.
- **`/support/epic` tab components read for flow, not line-by-line.** `epic-request-tabs.tsx` (all
  680 lines) and `term-batch-tab.tsx` (first ~200 of 367 lines) were read for structural and flow
  issues; both show heavy prior iteration (many `#NNN` fix references in comments: double-send
  guards, error-message scoping, arm-then-confirm on bulk emails, chronological sort fixes) and no
  new gaps worth filing beyond F-10-3, which lives in the shared `request-list.tsx`/`request-filters.tsx`
  components rather than the Epic tabs themselves. `ticket-detail.tsx`, `comment-thread.tsx`,
  `attachment-list.tsx`, `epic-person-picker.tsx`, and `submit-form.tsx` were not read; they back
  `/support/[id]` and `/support/new`, outside this task's assigned surface list.
- **Incident reporter-side surfaces not re-read.** `src/app/(app)/incidents/page.tsx` (the report
  form), `subject-picker.tsx`, `concern-types-fieldset.tsx`, and `incident-attachments-field.tsx`
  were left to Task 8, which already covered them from the reporter's perspective. Only the
  reviewer-facing `/incidents/review`, `/incidents/strikes`, and the reviewer half of `/incidents/[id]`
  were read here.
- **Volunteers `master`/`compliance`/offboarding write paths traced for feedback, not just render.**
  `CertificateViewer` (`src/modules/my-info/components/certificate-viewer.tsx`), used by all three
  compliance surfaces, closes its modal and calls `router.refresh()` on both Verify and Set-date
  success, so the table row itself is the confirmation; this is consistent and not a gap. The
  offboarding page's flag/unflag/execute actions were traced end to end (including the #92 last-admin
  guard) and found sound; no finding filed there.
- **No application code was changed.** `git status --short` shows only this fragment file as new/modified.
