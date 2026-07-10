# HAVEN Hub — Comprehensive Re-Audit (2026-07-10)

Second full-app QA/bug audit, run **after** the 16-PR fix wave (#199–#215) that closed the 2026-07-09 audit. Purpose: catch anything the fixes missed, any regression the fixes introduced, and any remaining defect.

- **Baseline:** `origin/main` @ `9ada1d0` (all 16 fix PRs merged). Worktree `HAVENHub-audit2`. `tsc --noEmit` passes clean.
- **Method:** 16 finders (12 module/area sweeps + 4 cross-cutting lenses: security/authz, concurrency/races, data-integrity, regression-on-the-74-changed-files) → dedup → **adversarial per-finding verification** (verifier instructed to refute; default REJECT unless a concrete repro survives against current code).
- **Result:** 30 raw → 28 deduped → **26 distinct confirmed** (1 high, 12 medium, 13 low), 1 rejected, 0 uncertain. (Two lenses independently found the same Teams-drain bug; merged here.)

The single most important theme: **several fixes patched one code path but left an identical sibling path unguarded.** Those are called out as "fix-wave follow-through" below.

---

## HIGH (1)

### H1 — `revokeAcceptance` cascade-deletes a SUBMITTED/PROMOTED onboarding contract (data loss + orphaned HIPAA blob)
- **File:** `src/modules/recruitment/services/review.ts:99` (also reachable via the interview "Rescind acceptance" control)
- **Category:** data-integrity · **Fix-wave follow-through (sibling of M1)**
- `revokeAcceptance` loads the `Acceptance` with a bare `findUnique` (no `contract` include) and, after only an `emailedAt`/scope check, calls `prisma.acceptance.delete()`. `OnboardingContract.acceptance` is `onDelete: Cascade` (`schema.prisma:1312`), so deleting the acceptance silently destroys any attached `OnboardingContract` — including SUBMITTED records (signatures, DOB, HIPAA cert metadata, custom answers) and PROMOTED ones. The stored HIPAA blob is also orphaned (no storage cleanup).
- `acceptance.emailedAt` is written **only** by `releaseDecisions`; `createOrResendContract` sets `contract.sentAt` but leaves `emailedAt` null. So a contract can be SUBMITTED while `emailedAt` is still null, which makes the `if (acc.emailedAt && !scope.all)` guard skip — even an in-scope **department director** passes it.
- The M1 fix (`decideInterview`) added exactly this guard (`include: { contract }`, block on `existing?.contract`) and its comment literally names `revokeAcceptance` as the "deliberate, separately-authorized" teardown path — but `revokeAcceptance` never got the guard.
- **Repro:** SRR accepts applicant into dept X (`emailedAt` null) → SRR sends onboarding link → applicant completes onboarding (contract SUBMITTED, HIPAA cert stored) → a dept-X director clicks **Revoke** on the applicant detail page → guard skipped (`emailedAt` null) → `acceptance.delete()` cascade-destroys the SUBMITTED contract. Irreversible.
- **Fix:** `include: { contract: true }` and refuse deletion when a contract exists (mirror `decideInterview`), or at minimum block when `contract.status` is SUBMITTED/PROMOTED. Delete the HIPAA blob on any legitimate teardown.

---

## MEDIUM (12)

### M1 — Teams-drain has no atomic claim, so overlapping cron ticks double-send Teams DMs
- **File:** `src/platform/notifications/send.ts:67` (`drainTeamsQueue`) · **race-condition** · **Fix-wave follow-through (sibling of M11 / PR #214)**
- `drainEmailQueue` claims each row atomically (`updateMany` on `lockedAt`, skip when `count===0`) precisely so overlapping drains can't double-send. `drainTeamsQueue` goes straight from `findMany(QUEUED)` to `transport.send()` with no claim, and **`TeamsMessage` has no `lockedAt` column** (only `EmailLog` does — `schema.prisma:859`). The sole `/api/cron/email` route calls both drains back-to-back; the external scheduler does not skip overlapping runs and `maxDuration=300` > 60s tick, so two ticks can drain Teams concurrently → duplicate DMs (and, on the permanent-failure branch, a duplicate fallback email). The `send.ts:55` "same as drainEmailQueue" comment is now inverted.
- **Fix:** add `lockedAt` to `TeamsMessage` and give `drainTeamsQueue` the same claim + stale-reclaim pattern; correct the comment.

### M2 — Master compliance view flags directors as "Pending / Not Cleared" using volunteer-only training
- **File:** `src/modules/volunteers/services/compliance.ts:386` · **correctness**
- `masterCompliance()` builds `completedTraining` from only `track: "VOLUNTEER"` rows, then derives `trainingState`/`overallClearance` for **every** person regardless of membership kind. Directors train on the DIRECTOR track, so a director-only member's DIRECTOR-track completion is never counted → shows grey "Pending" + red "Not Cleared" even when fully compliant. The department view (`volunteers/page.tsx`) correctly renders "-" for directors; the master view lacks that distinction.
- **Fix:** compute completion against each person's required track(s) (`requiredTrainingTracks`), or exclude Training/Overall columns for director-only members.

### M3 — Reviewer applicant list includes unsubmitted DRAFT applications, sorted to the top
- **File:** `src/modules/recruitment/services/review.ts:45` · **data-integrity**
- `listApplicantsForReview` queries `where: { cycleId }` with no status filter, ordered by nullable `submittedAt desc`. Drafts are real `Application` rows (`status DRAFT`, `submittedAt null`, blank name). Postgres sorts `DESC` NULLS-FIRST, so in-progress drafts sort to the **top** of the review queue for `review_all`/`manage_cycles` reviewers, leaking a still-being-typed application + the applicant's email.
- **Fix:** add `status: "SUBMITTED"` to the where clause; add a stable secondary sort key.

### M4 — `acceptApplicant` does not require the application to be SUBMITTED
- **File:** `src/modules/recruitment/services/review.ts:64` · **data-integrity** (chains with M3)
- No `app.status` check. Combined with M3 surfacing drafts, a `review_all` reviewer (scope.all skips the ranked-department check) can accept a never-submitted draft into any cycle department. That Acceptance then feeds onboarding-contract generation and promotion → a Person can be onboarded from an application that was never completed.
- **Fix:** throw when `app.status !== "SUBMITTED"` in `acceptApplicant`.

### M5 — Report subject who holds `incidents.manage` can unmask an anonymous reporter and adjudicate their own case
- **File:** `src/modules/incidents/services/report.ts:582` · **access-control / separation-of-duties**
- `getReport`/`listReviewQueue`/`reviewReport`/`decideStrike` gate only on `can(actor, 'incidents.manage')` with no check that the actor is not the report's `subjectPersonId`. The reporter name is shown to every reviewer ("anonymous" only means "not shared with the subject"). The notification helpers deliberately exclude the subject ("The subject is never a recipient"), but the read/adjudication paths don't — so a subject who holds `incidents.manage` (e.g. Volunteer Operations Manager) can open the report about themselves, read the anonymous reporter's identity, and dismiss it / decline the strike.
- **Fix:** exclude `subjectPersonId === actor` rows from the reviewer surfaces and block self-adjudication; mask the reporter identity on such rows.

### M6 — Incident review-queue numeric search overflows int4 → page 500
- **File:** `src/modules/incidents/services/report.ts:639` · **correctness**
- `listReviewQueue` adds `{ number: asNumber }` whenever `parseInt(q)` is not NaN, with no upper bound. `IncidentReport.number` is int4; a digit string > 2,147,483,647 (e.g. a pasted phone number) overflows and Prisma throws → `/incidents/review` 500s. The sibling `tech-request.ts` already guards this exact hazard (`asNum >= 0 && asNum <= 2_147_483_647`).
- **Fix:** mirror the `tech-request.ts` bound.

### M7 — Offboarding the sole admin-conferring person locks out all admin access
- **File:** `src/app/(app)/admin/people/[id]/page.tsx:64` (+ `src/platform/people.ts` `setPersonStatusField`) · **correctness**
- The RBAC service defends the last-admin invariant in `setRoleGrants` and `deleteAssignment` (serializable tx, `LastAdminError`). But offboarding never consults RBAC: `setPersonStatus(...,'OFFBOARDED')` just flips `Person.status`, and `getActivePerson` returns null for any non-ACTIVE status, so an offboarded admin can no longer authenticate. Seed provisions exactly one global `*` holder; the Offboard button renders for every ACTIVE person including that admin, with no self/last-admin check → UI-unrecoverable lockout (only `db:seed` recovers).
- **Fix:** apply the same last-admin invariant before flipping a person to OFFBOARDED (both the admin-people and volunteers `executeOffboard` paths).

### M8 — Last-admin deletion guard counts inert term-scoped assignments → lockout bypass
- **File:** `src/modules/admin/services/rbac.ts:444` · **correctness**
- The guard refuses deletion only when `count({ where: { roleId } }) === 1`, but that counts assignments the engine never honors. `getEffectivePermissions` counts only `termId null` or `termId === active term`; an assignment scoped to an archived term confers nothing. So count can be > 1 while only one assignment is live; deleting the live one passes the guard yet leaves zero effective admins. Reachable via UI only: scope `Platform Admin` to the active term, roll the term over (auto-archives it), then delete the global assignment.
- **Fix:** count only assignments the engine honors (`termId null OR termId === active term`).

### M9 — Open-redirect: `safeNextPath` tab/newline bypass defeats the portal redirect guard
- **File:** `src/modules/recruitment/services/portal-next.ts:8` · **security (CWE-601)**
- The guard `/^\/[^/\\]/` only rejects `/` or `\` as the second char. A TAB/LF/CR passes, and the WHATWG URL parser strips those before parsing, so `/\t/evil.com` → `//evil.com` → external origin. Both sinks feed it to a URL constructor (`apply/verify/route.ts:16` redirect; `apply/page.tsx:59` Yale `callbackUrl`). Verified: `new URL("/\t/evil.com","https://apply.havenfreeclinic.org/...").href === "https://evil.com/"`. On the trusted portal domain this is phishing + applicant login-CSRF/session-fixation (the verify route sets the applicant cookie while bouncing the victim off-domain). Downgraded high→medium: fixated identity is applicant-portal-only, not a privileged account.
- **Fix:** reject inputs containing TAB/LF/CR/other C0 controls (or canonicalize via `new URL(raw, base)` and require the origin to equal base); add tab/newline cases to `portal-next.test.ts`.

### M10 — Email **Subject** header HTML-escaped, garbling names with `'`/`&`/`<`/`>`
- **File:** `src/platform/email/templates/renderEmail.ts:31` (`renderEmail`) · **correctness** · **Fix-wave follow-through (sibling of PR #200)**
- `renderEmail` renders the subject via `renderTemplate(subjectSource, context)` without `{ escape: false }`, so `{{var}}` values in a subject are HTML-escaped into the raw Subject header (`'` → `&#39;`). PR #200 added the `escape` option and applied it to the recruitment subject render, but the platform path was never updated. Affects support/incidents/schedule/reminders/`recruitment.interview_assignment` subjects. e.g. "Siobhan O'Brien" → Subject reads `...from Siobhan O&#39;Brien`. (The HTML `<title>` re-escapes independently, so `{escape:false}` here introduces no XSS.)
- **Fix:** `renderTemplate(subjectSource, context, { escape: false })` (matches `renderResolvedEmail`).

### M11 — `notify()` performs a Microsoft Graph HTTP call inside the caller's interactive transaction
- **File:** `src/platform/notifications/identity.ts:44` (via `addPanelist`, `interviews.ts:130`) · **race-condition / reliability**
- `addPanelist` calls `notify(tx)` inside `prisma.$transaction`. When the `interview_assignment` channel is `teams`/`both` and the panelist's `entraObjectId` is null, `resolveTeamsUser` fires a synchronous Graph GET (no timeout) **before** the cache write, while the tx holds row locks. If Graph is slow enough to cross Prisma's 5s default tx timeout, the tx rolls back and the follow-on queue writes throw; `addPanelist`'s catch only maps P2002, so the otherwise-valid panelist add fails. Also holds a pooled connection across an external round-trip.
- **Fix:** resolve the Teams identity before opening the tx (or pass a pre-resolved id / do the cache write on the global client).

### M12 — Offboarded people (lost active membership) render as raw cuids and vanish from the builder grid
- **File:** `src/app/(app)/schedule/builder/page.tsx:680` (+ `src/modules/schedule/services/builder.ts`) · **consistency**
- `builderView` returns `members` from ACTIVE memberships only, and `assignmentsByDate` carries `{role,tags}` without a name. A `ShiftAssignment` outlives its membership (offboarding removes the membership but not future assignments). Day view falls back to the raw personId cuid; Grid view (one row per member) drops the slot entirely; capacity still counts the person → headcount exceeds visible cards.
- **Fix:** carry the assignee's name in `assignmentsByDate` and resolve from the assignment row, or remove future `ShiftAssignment`s on offboard.

---

## LOW (13)

### L1 — Shift-change request emails only reach directors who hold a DIRECTOR shift, not the department's actual approvers
- **File:** `src/modules/schedule/services/requests.ts:382` (and `remindDirectors` :978) · **correctness**
- Recipients are derived from `ShiftAssignment where role='DIRECTOR'`, but approval authority is defined by `TermMembership kind='DIRECTOR'` (+ delegations + `schedule.manage_requests`). The notified set is a strict subset of the approver set, so a director who manages but isn't placed on a DIRECTOR shift (or a delegated director) gets no email/reminder. Request still appears in the UI, so it's a missed-notification gap, not a lost request.
- **Fix:** derive recipients from the same source as approval authority.

### L2 — `decideStrike` report-status write not gated on PENDING → concurrent approve+decline can leave a DECLINED report with an issued strike
- **File:** `src/modules/incidents/services/report.ts:821` · **race-condition**
- The PENDING gate is a plain read; both terminal writes are `update({where:{id}})` with no `where:{strikeDecision:'PENDING'}`, and `issueAction` + report update aren't one transaction. The `DisciplinaryAction.reportId` unique constraint only serializes two APPROVEs; approve-vs-decline is unguarded → report reads DECLINED while a real strike exists on the ledger.
- **Fix:** atomic claim (`updateMany where strikeDecision='PENDING'`, throw on count 0), wrapping `issueAction` + report update in one tx.

### L3 — `submitContract` PENDING guard not atomic → orphaned HIPAA blob on concurrent submit
- **File:** `src/modules/recruitment/services/onboarding.ts:274` · **race-condition**
- Read → PENDING check → `putObject` → `update({where:{id}})` are not atomic and the update has no `status:'PENDING'` precondition. Two submits (two tabs / replay) each upload a distinct HIPAA blob and both flip to SUBMITTED; the row references only the last blob → the other is orphaned forever, plus a duplicate audit row. No PHI exposure (orphan is unreferenced).
- **Fix:** atomic claim (`updateMany where status='PENDING'`); delete the just-written blob when the claim is lost (like the existing catch).

### L4 — `renderInlineEmail` HTML-escapes campaign Subject merge variables
- **File:** `src/platform/email/templates/renderEmail.ts:61` · **correctness** (same root cause as M10)
- Campaign subject `{{ firstName }}` etc. are escaped in the Subject header for every recipient (`campaigns/service.ts:221`). "D'Angelo" → `D&#39;Angelo`.
- **Fix:** `renderTemplate(input.subject, context, { escape: false })`.

### L5 — Learning dashboard shows a Reset button to view-only users
- **File:** `src/app/(app)/learning/dashboard/page.tsx:54` · **consistency**
- Page gates on `learning.view_progress` but renders the Reset form unconditionally; the action requires the distinct `learning.manage_courses`. A view-only user sees the button; clicking redirects to `/no-access` (dead control — not a 500, the finding over-stated that).
- **Fix:** render Reset only when `can(personId, 'learning.manage_courses')`.

### L6 — `getCourseCompletion` 500s on an arbitrary `?course=` value
- **File:** `src/modules/learning/services/dashboard.ts:28` · **correctness**
- `selected = sp.course ?? courses[0]?.id` flows straight into `findUniqueOrThrow`; a non-existent id throws P2025, and there's no error boundary in the learning route subtree → 500 instead of an empty table.
- **Fix:** `findUnique` + return `[]`/`notFound()` when null, or validate against the listed ids.

### L7 — `persistScoCmi` writes an unbounded/non-finite score into an int4 column without validation
- **File:** `src/modules/learning/services/enrollment.ts:217` · **correctness**
- `persistCmiAction` (guarded only by `learning.access`) forwards the client-supplied `cmi` with no runtime validation; `Math.round(cmi.scoreRaw)` into an int4 column. A crafted score > int4 (or NaN) throws a numeric-overflow at the upsert (self-inflicted 500, atomic — no corruption). Score is display-only so no false completion.
- **Fix:** clamp/validate `scoreRaw` (finite, 0..100 or int4 range) before writing.

### L8 — Incident review-queue status filter not validated against the enum → 500
- **File:** `src/modules/incidents/services/report.ts:629` · **correctness**
- `where.status = filters.status as IncidentReportStatus` with no allowlist; `/incidents/review?status=OPEN` (any non-enum value) makes Prisma throw. The sibling support/all page validates via `pick()` against `ALL_STATUSES`.
- **Fix:** validate against `IncidentReportStatus` values (drop to undefined when unknown).

### L9 — Epic notification Teams card links volunteers to `/volunteers`, a page they cannot access
- **File:** `src/modules/support/services/epic.ts:441` · **other**
- The Epic onboarding/activation/reset notification is delivered to the subject (a volunteer) with `link: ${baseUrl}/volunteers`, which requires `volunteers.view` (baseline Volunteer role lacks it) → `/no-access`. Reaches the recipient via both the inbox bell and Teams.
- **Fix:** point the link at a page the recipient can reach (`/my-info` or `/support`).

### L10 — Subcommittee `order` accepts NaN from crafted input → unhandled Prisma error
- **File:** `src/app/(app)/admin/subcommittees/[id]/page.tsx:31` (and `new/page.tsx:21`) · **correctness**
- `optionalInt(formData.get('order')) ?? 0` → `Number("abc")` is NaN, and `NaN ?? 0` stays NaN (nullish coalescing doesn't catch NaN) → `order: NaN` → `PrismaClientValidationError`, uncaught (the action only catches typed subcommittee errors) → 500. The departments service guards this via `validateCapacity`; subcommittees don't.
- **Fix:** reject NaN/non-integers before persisting; map to `SubcommitteeValidationError`.

### L11 — Department compliance page allows verifying a dateless cert → contradictory "Verified … / Date Unknown" row
- **File:** `src/app/(app)/volunteers/page.tsx:267` · **consistency**
- Verify form renders for any cert regardless of status, and `verifyCertificate` stamps `verifiedAt` with no completion-date precondition. `complianceStatus` returns UNKNOWN_DATE before it inspects `verifiedAt`, so the row shows "Verified <name> <date>" while Status stays "Date Unknown" / "Not Cleared". No false clearance (all readers route through `complianceStatus`).
- **Fix:** render Verify (and/or accept it) only when `cert.completionDate` is non-null.

### L12 — EHS restore migration comment claims a no-op it does not provide
- **File:** `prisma/migrations/20260710000000_ehs_restore_required_for_all/migration.sql:14` · **data-integrity**
- The comment says the UPDATE is "a no-op for any row an admin has since intentionally scoped away," but the SQL unconditionally sets `requiredForAll = true` for the two ids with no predicate on current value. Given a ~9-day window between the EHS feature migration and this restore, an admin could have scoped these trainings to specific departments; the migration silently re-requires them for the whole org (and re-triggers reminders), plus bypasses `recordAudit`. EHS is non-blocking so no lockout.
- **Fix:** scope the restore to un-modified rows, or (since it runs once) correct the misleading comment.

### L13 — AVS medication dose / cost-source labels defined but never rendered (dead code + unlabeled rows)
- **File:** `src/modules/clinic/avs/avs-pdf.tsx:114` (+ `strings.ts`) · **dead-code**
- `labelMedication` / `labelDose` / `labelCostSource` (EN + ES) exist but are referenced nowhere. Med rows print `dose` and `costSource` as two identically-styled unlabeled grey lines — in the Spanish AVS a patient can't tell dose from cost source, though translated labels exist unused.
- **Fix:** render the labels above the respective lines, or delete the unused keys if the label-less layout is intended.

---

## Rejected / not reported
- 1 raw finding was rejected by adversarial verification. Pure style, the intentional house-style patterns (no em-dashes, in-house template engine subset, theme non-flip, single-drainer crons), and unreproducible claims were filtered out during verification.

## Notes on scope
- No code was changed for this audit (review-only). `tsc` baseline is clean.
- Cross-cutting theme worth acting on first: the four **fix-wave follow-through** items (H1, M1, M10, L4/L2) are sibling paths the 16-PR wave patched elsewhere but missed here.
