# Ops Request Batch: Implementation Plan

**Source:** operations triage list, 2026-08-12. Nineteen questions and requests from clinic leadership spanning recruitment, scheduling, incidents, and email.

**Status of the batch: COMPLETE.** Five items were already built and needed only an answer; six small items shipped alongside this document; **all nine workstreams have since been completed**, plus the Epic temporary password moved into admin settings and the shift reminder's Epic help desk link repointed from Airtable to `/support/new`, both off the back of the audit.

Outstanding work is operational, not engineering: see "Before the recruitment cycle opens" at the end.

**Scope of this document:** program-level. Each workstream states its goal, the design decision already taken, the schema and file surface, and the open questions. Per-task breakdowns happen when a workstream is picked up, following the house plan format.

## Global Constraints

- **No em-dashes anywhere.** CI enforces the `local/no-em-dash` eslint rule, including comments, strings, and docs.
- **Lint with `npx eslint src e2e`**, not `npm run lint`.
- **Read test results by the pass/fail counts, not the exit code.** Piping vitest through `tail` returns 0 even on a failed suite.
- **`prisma migrate dev` folds pre-existing drift into your migration.** After generating, open the SQL and delete anything your change did not cause. This bit during the shipped batch: the generated file carried unrelated `Training` constraint renames and an `Application.subcommitteeRanking` default drop.
- **Test commands need the worktree's own database.** The repo `.env` points every database URL at production Neon. Prefix runs with `TEST_DATABASE_URL="postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test_<name>" BLOB_READ_WRITE_TOKEN=""`.

---

## Already answered, no work needed

Recorded here so these are not re-raised.

| Question | Answer |
| --- | --- |
| Do returning volunteers skip scoring and auto-route? | Yes. `submissions.ts` auto-routes a `RENEWAL` volunteer application to `renewalDepartment` at submit, skipping committee scoring and routing. `TRANSFER` deliberately goes through the committee like a new applicant. |
| Are delegated departments reviewed by the managing department's directors? | Yes. `manageableDepartmentIds()` walks one hop of `DepartmentDelegation`, and `reviewScope()` uses it. Admin-configurable per department at `/admin/departments`, not hardcoded. |
| Can you undo/redo during speed scoring? | Yes. Arrow keys navigate the queue, the "Show scored" toggle re-includes scored applicants, and `submitCommitteeScore` upserts. For speed routing, re-routing resets the decision and `reopenDecision` reverses a reject until an acceptance is emailed or decisions are released. |
| Is the requesting director notified when their strike request is issued? | Yes. `incidents.strike_decided` fires to the reporter on both approve and decline. |
| Is there an exemption to "report hidden if linked"? | No, and one should not be added. See the note below. |

### On the "report hidden if linked" exemption

The reporter saw their own report through the owner path in `getReport`, which returns `canManage: false` and strips `reviewNotes`. The reviewer queue excludes it separately via `subjects: { none: { personId: actor } }`. Both behaved correctly.

An exemption permission is not recommended. The exclusion is what stops a reviewer who is named in a report from unmasking an anonymous reporter or adjudicating their own strike, and any permission that lifts it will end up granted to the exact senior people most likely to be named. If leadership needs visibility into a report naming a reviewer, the safe shape is a **separate escalation path** (route it to a named second reviewer) rather than a flag that lets the subject read it.

---

## Workstream 1: Second-choice discretion in routing (SHIPPED)

Built ahead of the imminent recruitment cycle. Landed as specced below, with three additions found during implementation:

- **The bulk tier actions had to be taught to skip returned rows.** A returned application is PENDING with no routed department, which is exactly the shape "Apply top tier" and "Apply bottom tier" treat as eligible. Left alone, "Apply top tier" would have routed returned applicants on `proposedDepartmentCode` (their FIRST choice, frequently the department that just declined them), handing them straight back; "Apply bottom tier" would have silently rejected someone a department deliberately returned rather than rejected. `batchEligible` in `speed-route-board.tsx` now excludes them, and the tier counts use it so the button labels stay honest.
- **The re-route picker hides the declining department**, and the Route button stays disabled if it is somehow selected.
- **`RETURNED` is checked after `ROUTED`** in the stage machine, so a stale marker can never keep a re-routed applicant in the lead's queue. `routeApplication` clears all four returned fields.

**Goal:** when a department declines an applicant routed to them, the applicant goes back to the recruitment lead flagged for re-routing rather than reading as a final program rejection.

**What exists:** re-routing already works mechanically. `routeApplication` resets `decision` to PENDING and tears down a not-yet-emailed `Acceptance` when the department changes. What is missing is any signal that an applicant is *awaiting* that: a department REJECT sets `Application.decision = REJECT`, which `applicationStage` maps to `DECIDED`, indistinguishable from an SRR-level rejection.

**Design:** add a third outcome to the routed-department decision, distinct from ACCEPT and REJECT: *decline and return for re-routing*. It must not reuse WAITLIST, which already means "hold for capacity in this department".

Recommended shape, avoiding an `InterviewDecision` enum change (that enum is shared with the director track):

- New nullable column `Application.returnedToRoutingAt DateTime?` plus `returnedById`, `returnedReason String?`.
- The department action sets those and leaves `decision` PENDING, clearing `routedDepartmentCode` so the application leaves that department's queue.
- New `ApplicationStage` value `RETURNED` in `application-stage.ts`, ranked between `SCORING` and `ROUTED`, so the roster groups them where the lead will act on them.
- Speed-route board grows a "Returned for re-routing" bucket showing the declining department and reason.
- Routing the application again clears the returned fields.

**Files:** `prisma/schema.prisma`, `services/routing.ts`, `engine/application-stage.ts`, `services/speed-route.ts`, `components/speed-route-board.tsx`, the applicant detail page, `engine/applicant-sort.ts`.

**Resolved during implementation:** a returned applicant IS re-routable to a department they did not rank, matching the lead's existing ability to route off-choice. The picker lists every cycle department except the one that declined them, marking ranked ones "(ranked)".

---

## Workstream 2: Auto-route medical departments (SHIPPED)

Landed as specced. **The flag defaults to false on every existing department, so nothing changes until an admin ticks it.** Before the cycle opens, someone with `admin.manage_departments` must turn it on for JCTS, SCTS, JCTP, SCTP, and VADM at `/admin/departments/<id>`.

One behaviour worth knowing: the lookup is by department CODE, and `RecruitmentCycle.departments` is a String[] of codes with no foreign key. A cycle naming a department code that has no `Department` row simply never auto-routes, which is the safe degradation.

**Goal:** applicants to clinical departments (JCTS, SCTS, JCTP, SCTP, VADM) skip committee scoring and go straight to their department for credential verification.

**Decision taken:** a per-department admin toggle, not a hardcoded code list. Departments are fully DB-configurable and admin-maintained; a constant would need a deploy to change and would silently miss any new clinical department.

**Design:**

- `Department.autoRouteApplicants Boolean @default(false)`, surfaced as a checkbox on `/admin/departments/[id]` with help text explaining that it skips committee scoring.
- `submitApplication` extends the existing RENEWAL auto-route branch: on a VOLUNTEER cycle, if the applicant's **first choice** is a cycle department with `autoRouteApplicants`, set `routedDepartmentCode` and `routedAt` at submit.
- Reuse the RENEWAL precedent exactly, including its comment explaining why routing is volunteer-only.

**Interaction with Workstream 1:** an auto-routed applicant who is declined lands in the returned bucket with no committee score. The lead then either routes them elsewhere or rejects. Build Workstream 1 first so this case has somewhere to land.

**Files:** `prisma/schema.prisma`, `modules/admin/services/departments.ts`, `app/(app)/admin/departments/[id]/page.tsx`, `modules/recruitment/services/submissions.ts`.

**Resolved during implementation:** first choice only. Any-choice routing would let an applicant who ranked a clinical team third bypass the committee for a department they barely wanted, and would make the routed department depend on which auto-route department happened to sort first in their ranking. A RENEWAL still goes to its own department, which takes precedence over the ranked first choice.

---

## Workstream 3: Strike ledger visibility and the three-strike system (SHIPPED)

**Goal:** members can see their own strikes; the three-strike threshold is tracked rather than remembered; recruitment can see a do-not-rehire flag.

**What exists:** `/incidents/strikes` (central + directors only), `strikeCount`, `visibleStrikeCount`, and a "they now have N strikes" line in the director notification. No member-facing view, no threshold, no ordinal, no rehire flag.

Four separable pieces, in dependency order:

**3a. Member-facing strike view. SHIPPED.** A read-only "Disciplinary record" section on `/my-info` listing the member's own strikes with the running total, each row's ordinal ("2nd strike"), category, date, and the subject-facing detail.

Built as specced, plus:

- **The redaction was extracted, not duplicated.** `subjectFacingDetail()` now lives in `disciplinary.ts` and is used by both `strike-notifications.ts` and this view, so the two surfaces that show a person their own strike cannot drift. A confidential strike still reaches its subject here (they were emailed about it, and it counts toward their standing); what confidentiality removes is the reporter's narrative.
- **The ordinal is computed at read time**, ranked by `occurredAt` then `id` to match the ledger's tiebreaker. Storing it would go wrong the moment `deleteAction` removed an earlier row.
- **The panel lives in `src/app/(app)/my-info/`, not `src/modules/my-info/`**, because eslint forbids module-to-module imports and the data comes from the incidents module. The page already composes across modules this way.
- **Dates use `formatCalendarDate`, not `DateOnly`.** `occurredAt` is a calendar-day marker anchored at UTC; the zone-aware component would have shown an ET member a strike dated a day earlier than the ledger their director reads and the email they received. Two tests pin this, including the midnight-UTC case.

**3b. Strike ordinal. SHIPPED.** The ledger's Strikes column now reads "2 of 4": this row's position in the person's sequence, then their current total. It previously showed only the total, identical on every row, so a strike from two years ago displayed as their current count.

Computed at read time in `loadStrikeOrdinals`, ranked by `occurredAt` then `id` to match the ledger's own tiebreaker. Not stored, because `deleteAction` exists and a stored ordinal would be wrong for every later row the moment one was removed. Crucially it runs through the **same visibility predicate** as the total, so a director never sees "3 of 2" where the extra row is a confidential action they cannot open. A test pins that.

**3c. Three-strike threshold. SHIPPED.** `incidents.strikeThreshold` (Settings > Operations, default 3). The ledger shows a "Limit reached" badge once a person's visible total meets it, and the director notification appends "(at or over the 3-strike limit)" to the count phrase it already sent. Appended to the existing phrase rather than added as a template variable, so an admin override of that template keeps working.

Deliberately triggers **nothing** automatic. Reaching the limit is a prompt for an ED conversation; an automatic membership change driven by a count would be a policy decision the code should not make and hard to reverse.

**3d. Do-not-rehire flag. SHIPPED.** `Person.doNotRehire` plus note, setter, and timestamp. Set and cleared via `setDoNotRehire`, which requires `incidents.manage` (directors cannot, mirroring `deleteAction`). Clearing wipes the note and attribution so a stale reason cannot outlive the flag; both directions are audited.

Two surfaces:
- **Set/clear** on `/admin/people/[id]`, in its own section gated on `incidents.manage` rather than the page's `admin.manage_people`. Deciding the clinic would not take someone back is an incidents judgment, and the people who administer records are not necessarily the people who make it. Both server actions re-check the permission.
- **Read** on the recruitment applicant detail page, above the application so a reviewer sees it before forming a view.

**It is strictly advisory, and the code says so in three places.** Nothing rejects, filters, or hides an application. A test asserts that setting the flag does not change who appears in a people picker, as a standing guard against someone later wiring it into a query. The applicant is never told it exists, so a silent auto-reject would be both unfair and undiscoverable when set in error.

**Known limitation:** the flag only resolves for an applicant already linked to a `Person`. A returning alum who has not been matched yet shows no flag. That is a property of the link, not a statement about them, and it is worth knowing before relying on the flag as a safety net.

**Files:** `prisma/schema.prisma`, `modules/incidents/services/disciplinary.ts`, `modules/incidents/services/strike-notifications.ts`, `modules/my-info/`, `app/(app)/incidents/strikes/`, `platform/settings/registry`, `modules/recruitment/services/promotion.ts`.

**Open question for ops, still open:** should the member-facing view name who issued the strike? The subject's email already does, so consistency argues yes, but 3a deliberately shipped without it: on a confidential strike the issuer is often the reviewer who acted on an anonymous report, and naming them narrows the field of who reported it. Adding it is a two-line change if ops wants it; the safer default was to leave it out.

**Ops decision still needed:** the strike limit defaults to 3. Confirm that matches current policy at Settings > Operations, and change it there if not.

---

## Workstream 4: CC field on incident and strike notifications (SHIPPED)

Landed as designed below. To use it: grant `incidents.escalation_recipient` on a custom role at `/admin/roles` and assign it to the medical directors.

Implementation notes worth keeping:

- `incidentAudience()` in `report.ts` is now the single source of who receives incident notifications, replacing four separate `peopleWithAnyPermission(["incidents.manage"])` call sites. A test asserts the number the reporting form discloses equals the number of people `submitReport` actually notifies, so the form cannot start lying if someone adds a recipient path later.
- Someone holding both permissions is listed once, as a reviewer, and keeps the actionable link.
- The subject of a report or strike is never copied, even holding the escalation permission. Two tests.
- A confidential strike reaches no escalation recipient at all. That is the strictest rule in the feature: confidential comes from `report.anonymous`, so relaxing it would widen the audience for an anonymous report beyond the reviewers who handled it.

**Goal:** medical directors and other senior staff can be copied on incident and strike emails so they have visibility.

**Constraint to respect:** `notify()` is strictly per-person and writes one `Notification` row plus one `EmailLog` row per recipient. A literal RFC "Cc:" header would break that model, bypass per-person channel preferences, and leak recipient lists between people. **Do not add a Cc header.** Add additional recipients instead, each notified through the normal path.

**Design (revised after reading the code; two ops decisions taken 2026-08-12):**

Not a settings list of person ids, as originally specced. A **permission**, `incidents.escalation_recipient`, granted through the existing RBAC UI. Reasons: the settings registry has no multi-select input, `peopleWithAnyPermission` is already the established way this module resolves an audience, and role grants are already audited and manageable without new UI.

**Do NOT add it to any system role.** Per the system-role-grants note, changing `SYSTEM_ROLES` needs a prod backfill migration. Admins grant it on a custom role instead.

**Decision 1: notification only, no new read access.** Escalation recipients get an email carrying the substance (report number, concern types, immediate-risk flag, the names a strike was requested against) but **no link into the review queue or the strikes ledger**, which they cannot open. This was chosen over granting read access: widening who can read raw narratives on a confidential safety-reporting system, and on a non-anonymous report who sees the reporter's name, is a much larger change than the request needs.

Consequence for the templates: `incidents.report_submitted`, `incidents.strike_requested`, and `incidents.strike_issued_directors` each render their link paragraph unguarded, so they need `{{#if}}` guards. Passing an empty link then omits the paragraph rather than shipping a dead link. One template each, no new template variants, so the wording stays in one place.

**Decision 2: the audience disclosure counts them, with no distinction.** The reporting form promises "This report goes to the clinic's incident reviewers, currently N people", and `disclosure.ts` states outright that the count must come from the same query that drives the notification so the two can never drift. There are **four** call sites of `peopleWithAnyPermission(["incidents.manage"])` today (report.ts, incidents/page.tsx, incidents/[id]/page.tsx, plus the doc comment referencing them). All must move to one shared helper, or the form starts lying to reporters about who reads their report.

Naming the two groups separately was considered and rejected: telling a would-be reporter that senior staff are copied would deter reports about senior staff, which is the opposite of what the form is for.

**The permission must never be an authorization gate.** It grants no read access anywhere. If it later appears in a `can()` check that guards a page or an action, that is a bug.

**Confidentiality gate on strikes:** `notifyStrikeIssued` returns before notifying any director when `action.confidential` is set, because a confidential strike must not be mailed to people who cannot open the row. Escalation recipients fall under the same rule, and since they hold no `incidents.view_strikes` they are never notified of a confidential strike unless they separately hold `incidents.manage`.

**If ops genuinely needs per-report ad-hoc CC**, that is a different feature: a reviewer-only "share this report with" action, audited per use, rather than a free-text field on the reporting form. Free-text recipients on a confidential safety report is a disclosure hazard, and a reporter is not positioned to judge who should see it.

**Files:** `platform/modules/registry.ts` (register the permission), `modules/incidents/services/report.ts` (shared audience helper + submission notification), `modules/incidents/services/strike-notifications.ts`, `platform/email/templates/incidents.ts` (three `{{#if}}` link guards), `app/(app)/incidents/page.tsx` and `app/(app)/incidents/[id]/page.tsx` (disclosure count).

---

## Workstream 5: Board meeting attendance (SHIPPED)

Built as specced. `BoardMeeting` + `BoardMeetingAttendance`, new `volunteers.manage_board_attendance` permission, pages at `/volunteers/board-meetings`.

The load-bearing decision, which has tests: **the absence of an attendance row means "not yet recorded", never "absent".** A meeting nobody has taken attendance for must not quietly accrue absences against every director. `unexcusedAbsenceCounts` counts explicit `ABSENT` marks only, so neither `EXCUSED` nor a missing record inflates the number a strike conversation starts from.

Other notes:
- Roster is resolved LIVE from ACTIVE DIRECTOR memberships, and a two-department director appears once with both departments listed.
- The page flags anyone at two or more unexcused absences, and says in as many words that raising the strike is a separate step in Incidents. Nothing here creates one.
- Meeting dates anchor at noon UTC like every other calendar marker.

**Ops action:** grant `volunteers.manage_board_attendance` on a role. Nobody holds it until someone does.

**Goal:** track director attendance at board meetings, which happen every two weeks.

**Context that shapes this:** the director onboarding contract already states "2 unexcused absences to board meetings = 1 strike" (`contract/defaults/director.ts`). So this is not a standalone attendance log; it is the input to a strike request. Build it knowing that link exists, even if the automatic bridge is deferred.

**Design:**

- New `BoardMeeting` model: `termId`, `meetingDate` (noon-UTC anchored, matching every other calendar marker in the schema), `title`, `notes`.
- New `BoardMeetingAttendance`: `meetingId`, `personId`, `status` (PRESENT / EXCUSED / ABSENT), `recordedById`, `note`. Unique on `(meetingId, personId)`.
- Roster for a meeting is every ACTIVE DIRECTOR-kind `TermMembership` in the term, resolved live rather than snapshotted, consistent with how the schedule builder resolves its roster.
- Recording UI under volunteer management, gated on a new `volunteers.manage_board_attendance` permission.
- A per-person unexcused-absence count surfaced next to the strike request flow, so a director raising a strike for attendance has the evidence to hand.

**Explicitly deferred:** automatic strike creation at two unexcused absences. Keep the human in the loop, matching the decision in Workstream 3c.

**Files:** `prisma/schema.prisma`, new `modules/volunteers/services/board-attendance.ts`, `app/(app)/volunteers/`, `platform/rbac` permission registry.

**Open question for ops:** are board meetings term-scoped, and does attendance carry across a term boundary for the two-absence count? Term-scoped with a per-term count is the assumption above.

---

## Workstream 6: Generalized attending schedule, visible to everyone (SHIPPED)

Landed as designed below. Four things worth knowing:

- **`/schedule/attendings` is now open to every member** and leads with a date-by-service-line schedule table, which is what a volunteer working a shift actually wants. The nav tab is unconditional; edit controls render per service line.
- **Edit rights deliberately did NOT narrow.** The pre-split check was "manages any RHD-family department", so an SCTS director could maintain the roster. Scoping strictly to line-managers would have silently revoked that. `manageableServiceLines` therefore counts a line as yours if you manage the line itself OR any department inside it, and `upsertRhdClinic` applies the same rule. What is new is that managing ONE line no longer grants access to another's, which a test pins.
- **The weekly reminder now names every service line's attending**, e.g. "Dr. Ellis (SRHD), Dr. Okafor (PCAR)". It changed from `findUnique` to `findMany` because a Saturday can now carry more than one.
- **The procedure matrix is hidden for non-reproductive-health lines** on both the roster table and the create/edit form, via `AttendingForm`'s `showCapabilities`. A primary care attending has no IUD or Nexplanon qualification, and asking would imply a gap rather than an inapplicable question.

**Follow-up not done:** per-date attending assignment for primary care is currently only reachable through the builder, which surfaces the readiness panel for reproductive-health departments only. PCAR managers can maintain their roster but not yet set a per-Saturday attending from the UI. That needs either a small edit affordance on the new schedule table or the builder's panel generalised, and is the obvious next slice.

**Goal:** one attending schedule covering RHD and Primary Care (PCAR, covering JCTP and SCTP), visible to every member, still editable only by managers.

**Decision taken:** generalize the model *and* open read access.

**What exists:** `RhdAttending` (a roster with a six-procedure capability matrix) and `RhdClinic` (one row per term per clinic date, unique on `(termId, clinicDate)`, holding the attending, a director name, and procedures booked). Both are RHD-only. `canManageAnyRhdDept` gates the nav tab and the page.

**The blocking modelling problem:** `RhdClinic` is unique on `(termId, clinicDate)`, which cannot express "RHD has attending X and Primary Care has attending Y on the same Saturday". This is the real work in this workstream; the visibility change is small by comparison.

**Design:**

The key realisation, from reading the seed: **a "service line" already exists in the data as a delegation manager.** `DepartmentDelegation` seeds SRHD manages CCRH/JCTS/SCTS (exactly today's `RHD_CODES`) and PCAR manages SCTP/JCTP. So the thing a clinic row belongs to is the MANAGING department. No new enum, table, or hardcoded service-line list is needed, and `RHD_CODES` itself becomes derivable from SRHD's delegation edges rather than a constant.

- Add `departmentId` to the clinic row, pointing at the **managing** department (SRHD for reproductive health, PCAR for primary care), and change the unique key to `(termId, clinicDate, departmentId)`.
- Add `departmentId` to the attending roster, same meaning, so an attending belongs to a service line.
- Generalize `canManageAnyRhdDept` into a per-department check driven by `manageableScheduleDepartmentIds`.
- Keep the procedure matrix reproductive-health-specific and render it only for that service line. Primary Care attendings have no IUD or Nexplanon qualification, and forcing them into that shape would produce a grid of meaningless "unknown".
- New read-only `/schedule/attendings` view for all members, gated on `schedule` module access. Keep the edit routes behind the manager check, and re-check on every action: a server action is a public endpoint regardless of what the page renders.

**Model names stay `RhdAttending` / `RhdClinic`, documented rather than renamed.** A rename touches the import script, the builder, the reminder email, every page, and every test, and each is a chance to break the weekly reminder that now reads this table in production. The naming is cosmetic; the migration is not. Treat a rename as a separate mechanical follow-up if it is wanted at all.

**The migration must fail loudly rather than lose data.** Backfill existing clinic rows to SRHD, then `SET NOT NULL`:

```sql
ALTER TABLE "RhdClinic" ADD COLUMN "departmentId" TEXT;
UPDATE "RhdClinic" SET "departmentId" = (SELECT id FROM "Department" WHERE code = 'SRHD' LIMIT 1);
ALTER TABLE "RhdClinic" ALTER COLUMN "departmentId" SET NOT NULL;
```

If SRHD is absent AND rows exist, `SET NOT NULL` aborts the migration, which is the correct outcome: a human investigates. Do NOT delete unassignable rows to make it pass, and do NOT leave the column nullable, because Postgres treats NULLs as distinct in a unique index and the one-attending-per-service-line-per-date invariant would silently stop holding.

**Dependency:** the weekly reminder email already names the attending (shipped in this batch), reading `RhdClinic` by `(termId, clinicDate)`. **That lookup must be updated when the unique key changes**, or the reminder will silently stop finding attendings. It is covered by tests; do not skip them.

**Files:** `prisma/schema.prisma` plus migration, `modules/schedule/services/attendings.ts`, `modules/schedule/engine/rhd.ts`, `modules/schedule/components/attending-form.tsx`, `app/(app)/schedule/attendings/`, `platform/email/shift-reminders.ts`.

---

## Workstream 7: Record of Service dates and hours (SHIPPED)

Built as specced. `Department.hoursPerShift` (nullable Decimal, admin field at `/admin/departments`), and `ServiceTermRow` gained `dates` and `hours`.

- **Null propagates rather than defaulting.** `hours` is null whenever shifts OR the department's rate is unknown; `dates` is null on a term with no shift data, matching the existing `shifts: null` rule. `formatHours` and `formatServiceDates` read undefined and null identically, so an already-issued credential snapshot from before this feature still renders.
- **Both fields are optional on the type** for that snapshot compatibility. Do not make them required.
- **A shared clinic date appears on BOTH department rows** when a member served in two departments that day, each priced at its own department's rate. That is the case that makes a single clinic-wide hours setting wrong, and it has a test.
- Rendering: hours append to the shifts cell ("3 scheduled, 18 hours") and dates sit on a quiet sub-line, so neither the PDF's column layout nor the credential page's table needed restructuring.
- `basis` stays `"SCHEDULED"`. An attended-basis record is still a separate decision, since it changes what the document claims.

**Ops action:** set **Hours per shift** per department at `/admin/departments`. Blank reads as "not recorded", so no hours appear anywhere until someone fills them in.

**Goal:** the service record lists dates served and total hours, not just a shift count.

**Decision taken:** fixed hours per department (`Department.hoursPerShift`), because `ClinicAttendance` captures check-in but has no check-out, so real elapsed hours are not derivable from existing data and would only ever work going forward.

**What exists:** `ServiceRecord.terms[]` carries `shifts: number | null` per term and department, where `null` means "no shift data existed for this term and department" and `0` means "data existed and this member had none". That distinction is load-bearing and deliberate; preserve it exactly.

**Design:**

- `Department.hoursPerShift Decimal? ` (nullable, admin-maintained). Null means "not configured", which must render as "not recorded", never as zero hours.
- `ServiceTermRow` grows `dates: string[]` (ISO day keys, ascending) and `hours: number | null`.
- `hours` is `shifts * hoursPerShift`, and is `null` whenever `shifts` is null **or** `hoursPerShift` is null. Do not silently substitute a default: a fabricated hour total on a document a member hands to a residency application is worse than an honest omission.
- The PDF, the public credential page, and the wallet pass all render a snapshot from `credential.ts` and must not recompute. Existing issued credentials keep their old shape; the renderer needs to tolerate rows with no `dates`/`hours` field.
- `basis` stays `"SCHEDULED"`. Its doc comment says it upgrades to `"ATTENDED"` only if attendance capture is built; `ClinicAttendance` now exists, so a follow-up could compute an attended-basis record, but that is a separate decision and changes what the document claims.

**Files:** `prisma/schema.prisma`, `modules/passport/services/service-record.ts`, `modules/passport/components/passport-pdf.tsx`, `modules/passport/components/service-record-card.tsx`, admin department form.

**Resolved 2026-08-12:** shift length is **not** uniform clinic-wide; it varies by department. The per-department `Department.hoursPerShift` column above is therefore the right shape, not a single global setting. The reminder email's "8:00 AM to 2:00 PM" describes the clinic day, not every department's shift, so do not treat it as a default to apply everywhere.

---

## Workstream 8: Generalized language verification (SHIPPED)

Done as a full migration, not the half-way version this section warns against. `PersonLanguage` is now the only source of truth; the four `spanish*` columns on Person are **dropped**. Spanish is the row with `language = "es"` and is special-cased nowhere.

**The field shape was kept identical on purpose**, so the interpreting department's queue semantics are unchanged: `verifiedAt IS NULL` means awaiting assessment, non-null means assessed either way, and `verified` is the outcome that is meaningless without it. That let the review workflow generalize without redesigning it.

**The backfill was verified before it was trusted.** All four prior states were seeded and checked after migrating, including the one that is easy to lose: a person assessed as NOT speaking Spanish (`spanishVerified` false with `spanishVerifiedAt` set). Dropping that row would have pushed everyone previously assessed "no" back into the queue to be re-reviewed. The migration's WHERE covers it.

Notable call-site decisions:
- **Only VERIFIED languages reach scheduling, capacity, badges, and the service record.** A self-reported claim is an intake signal; a test pins that `verifiedLanguagesByPerson` never returns one.
- **Email audience keys stayed `spanishVerified` / `spanishSelfReported`** so campaigns saved before the move keep working. They compile to relation filters now, and the false case uses `none` rather than `some: { verified: false }`, so it correctly includes people with no language row at all.
- **The admin person form no longer edits language.** A free checkbox there would be an unattributed override of an assessment that records who made it and when; the form points at the review queue instead.
- **The route is still `/volunteers/spanish-review` and the permission still `volunteers.verify_spanish`.** Renaming either means re-granting in production for zero functional gain; the page itself is now "Language review".
- Intake (`promotion.ts`) turns the onboarding contract's Spanish claim into a self-reported row, which puts the person in the queue. `OnboardingContract.spanishSelfReported` is untouched: it is contract data, not person state.

**Follow-up not done:** the application form still collects languages as free text, so a claim from an application does not automatically become a `PersonLanguage` row. Only the onboarding contract's Spanish checkbox does. Mapping free-text application answers onto codes needs a human in the loop and is its own piece of work.

**Goal:** verify any spoken language, not just Spanish, and surface the flag across the Hub.

**SCOPE CORRECTION (2026-08-12).** The line below says `spanishVerified` is read in four or five places. That is wrong, and anyone planning off it will badly underestimate. The real surface is **19 files and 78 references**:

```
16  src/platform/people.ts                       9  admin/components/person-form.tsx
15  src/platform/spanish-review.ts               8  schedule/services/builder.ts
 4  email/audience/person-fields.ts              4  schedule/components/builder-day-view.tsx
 3  recruitment/services/onboarding.ts           3  passport/services/service-record.ts
 2  schedule/engine/rhd.ts                       2  recruitment/services/promotion.ts
 2  recruitment/contract/review.ts               2  admin/people/{new,[id]}/page.tsx
 1  recruitment/contract/system-fields.ts        1  passport/components/passport-pdf.tsx
 1  admin/components/people-table.tsx            1  incidents/services/disciplinary.ts
 1  onboard/[token]/contract-field.tsx           1  onboard/[token]/actions.ts
```

It spans intake (the application's language answers and the onboarding contract), the review workflow, the capacity engine, schedule badges, email audience conditions, and the service record. This is a multi-day feature, not an afternoon.

**Do not do it half-way.** The tempting shortcut is to add `PersonLanguage` for "other" languages and leave Spanish in its boolean. That produces two sources of truth for "what languages does this person speak", with Spanish permanently special-cased, and every future reader has to know to check both. Either migrate Spanish into the new model properly or do not start.

**What exists:** `Person.spanishVerified` / `spanishVerifiedAt` / `spanishVerifiedById`, plus `licensedRN`. `spanishVerified` is read by the capacity engine (a `spanish` count per clinic day), the RHD readiness computation, the service record's `capabilities`, and the builder's flag badges.

**Design:**

- New `PersonLanguage` model: `personId`, `language` (a code from a maintained list, not free text, or the same person will appear as "Spanish", "spanish", and "Español"), `verifiedAt`, `verifiedById`, `note`. Unique on `(personId, language)`.
- Applicants already list languages as free-text application answers. Import is a mapping problem, not an automatic one: a reviewer confirms the claim before it becomes a verified row. Do not auto-create verified rows from application text.
- **Migrate `spanishVerified` into a `PersonLanguage` row with `language = "es"`** and keep the column as a derived read for one release, or update all five call sites in the same change. The capacity engine's `spanish` count is the one most likely to be missed.
- Replace the `verifyCertificate`-style permission check with a `volunteers.verify_language` permission, mirroring the existing Spanish verification gate.

**Related, shipped separately:** the full schedule now shows shift flags on directors and shadows, not just volunteers. Showing **person-level** flags there (language, RN) is a natural follow-on and belongs with this workstream, since the badge should read from `PersonLanguage` rather than from a Spanish boolean that is about to be replaced.

**Files:** `prisma/schema.prisma`, `modules/volunteers/services/`, `modules/schedule/engine/capacity.ts`, `modules/schedule/engine/rhd.ts`, `modules/passport/services/service-record.ts`, `modules/schedule/components/builder-day-view.tsx`, `app/(app)/schedule/full/page.tsx`.

---

## Workstream 9: Production email audit (DONE, pending ops decisions)

**Result:** `docs/email-template-audit-2026-08-12.md`.

The template machinery is clean across all 44: zero undeclared variables, zero syntax errors, zero missing sample values, no hardcoded Hub URLs in any body, sender resolution applied everywhere, and the anonymous-reporter withholding correct and tested. Every finding is about content.

Four findings, two of which need an ops or IT decision before anything changes:

1. **A shared Epic temporary password was hardcoded** (`SecureCare4u#25`), in three places across `epic-activation` and `epic-password-reset`. The `#25` implies an annual YNHH rotation, and it is now August 2026, so it may already be wrong, which would mean every Epic activation and reset email since the rotation gave people a password that does not work. **FIXED:** all three now read the `epic.temporaryPassword` setting (Settings > Integrations), seeded with the existing value so no email changed on deploy, and blank omits the clause. **The value itself still needs confirming with YNHH IT.**
2. **The shift reminder routes Epic problems to an Airtable form** rather than the Hub's own `/support` ticketing. **Needs an IT decision**; they may deliberately keep Epic intake separate.
3. The shift reminder still describes itself as a summer pilot. Recommend deleting that paragraph.
4. `epic-onboarding` says "Citrix Receiver", superseded by Citrix Workspace app, and `auth.member_login_link`'s sample value uses `.com` where the other ten use `.org` (preview only, no live impact).

**Goal:** confirm all 44 registered templates are complete, accurate, and production-ready.

**Scope:** every key in `listDescriptors()` across `compliance`, `clearance`, `epic`, `recruitment`, `support`, `shift`, `schedule`, `incidents`, `auth`, and `volunteers`.

**This is a review pass, not a feature.** Give it a checklist and a written output rather than treating it as open-ended reading. Per template:

1. Does `validateTemplate(defaultBody, declaredVariables)` pass, and does the body reference every variable it needs? (Already covered by tests for some groups; confirm coverage is universal.)
2. Does every variable have a realistic `sampleValue`? These drive the admin preview, and a blank sample makes a template look broken to the admin editing it.
3. Are `{{#if}}` guards present on every optional value, so an empty one hides its section instead of leaving a dangling label? This class of bug shipped once already, and the attending line added in this batch was written with the guard for that reason.
4. Is any recipient-specific content correctly withheld? The known hazard is `incidents.strike_issued`, which must not carry an anonymous reporter's narrative to the subject.
5. Does the sender resolve correctly? Sender is resolved at `queueEmail` and snapshotted, per the per-template sender feature.
6. Does the copy match current operational reality? Several bodies carry inline static content that has drifted risk: the shift reminder still points Epic issues at an **Airtable help desk form** even though the Hub now has its own `/support` ticketing, and describes the centralized reminder process as a summer pilot.

**Recommended output:** a table of template key, verdict, and required change, written to `docs/` and reviewed by ops before any copy edits land. Copy changes are ops decisions, not engineering ones.

**Known finding to start from:** the shift reminder's Epic help desk link points at Airtable rather than `/support`. Confirm with IT whether that redirect is intentional before changing it.

---

## Sequencing (historical)

All nine shipped, in the order 1, 2, 9, 3, 4, 6, 7, 5, 8. Kept here because the reasoning still applies to work of this shape: the dependency (1 before 2) was real and load-bearing, and taking 6 and 8 on their own rather than alongside other work was the right call, since each migrates a key that live code reads.

### Deferred follow-ups, in rough order of value

1. ~~**Per-Saturday attending assignment for Primary Care.**~~ **DONE.** Attending scheduling is now its own feature at `/schedule/attendings`: the term-at-a-glance grid is editable per cell for the service lines you manage, identically for primary care and reproductive health. Procedures render only for the line that books them. The builder's readiness panel still SHOWS coverage (it computes readiness from it) but no longer sets it, so exactly one form writes an `RhdClinic` row.

   Two defects surfaced while building it, both pre-existing:
   - **No non-reproductive-health line could add or edit an attending at all.** Both attending pages build their capabilities object by mapping all six procedure keys over FormData, so a line without the procedure matrix posted six nulls and `validCapability(null)` threw "Invalid capability value: null". The entire primary care roster was unreachable through the UI. Fixed in the service (null now means "the form did not render this field"), so neither page can reintroduce it, and covered by three tests. Caught by running the e2e suite, not by unit tests.
   - **`upsertRhdClinic` accepted a non-service-line department.** Now that the grid posts `departmentId`, a director could have written a clinic row keyed to their MEMBER department, which passes the manage check but is read by nothing. It now rejects, which also protects the builder path.
2. ~~**Application-form languages.**~~ **DONE.** The free-text pair was replaced by a standard locked `languages_spoken` multi-select over the shared catalog, seeded into every cycle and guarded at `publishCycle`. Answers land in `Application.languagesClaimed` and become `PersonLanguage` rows at promotion, unioned with the contract's Spanish checkbox. `npm run backfill:languages:apply` seeded it into pre-existing DRAFT cycles (applied to Volunteer Fall 2026 on 2026-08-12).
3. **Cosmetic renames**, none of which change behaviour: `RhdAttending` / `RhdClinic` (no longer reproductive-health-only), the `/volunteers/spanish-review` route and its `volunteers.verify_spanish` permission (now any language). Each was skipped deliberately, and the reasoning is in the relevant workstream above.

## Before the recruitment cycle opens

1. Tick **Skip committee scoring** on JCTS, SCTS, JCTP, SCTP, and VADM at `/admin/departments`. The flag ships off.
2. Tell department directors about the new **"Not a fit for us, return for re-routing"** outcome on the department decision form, and that it is not a rejection.
3. Tell the recruitment lead about the **Returned for re-routing** card at the top of the speed-route board, and that returned applicants are deliberately excluded from the bulk tier actions.
4. Confirm the **strike limit** (Settings > Operations, defaults to 3) matches current policy.
5. Confirm the **Epic temporary password** (Settings > Integrations) with YNHH IT. It is seeded with the value that was hardcoded until 2026-08-12 and may be a rotation behind.
6. Set **`incidents.externalEscalationEmails`** (Settings) to the medical directors' School of Medicine addresses, comma-separated. These are clinical supervisors with **no Hub account**, so they are reached by email address, not by a permission grant. Until the setting has a value, nothing is sent outside the clinic. Note the audience disclosure on the reporting form counts them and names them as outside the clinic, so the number reporters see will go up. Anonymous reports are never sent externally.
7. Grant **`incidents.escalation_recipient`** at `/admin/roles` only to senior people who *do* hold Hub accounts and should be copied on reports and issued strikes. Optional, and separate from item 6. Nobody holds it until someone does this.
8. Grant **`volunteers.manage_board_attendance`** to whoever runs board meetings, at `/admin/roles`. The Board meetings tab is invisible until someone holds it.
9. Set **hours per shift** on each department at `/admin/departments`. It ships null, and a null rate means the Record of Service shows no hours for that department rather than a wrong number.
