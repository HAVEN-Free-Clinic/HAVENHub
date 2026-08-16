# HAVEN Hub whole-app audit, 14th pass: production readiness

**Date:** 2026-08-15
**Base:** clean worktree fast-forwarded to `origin/main` @ `10cdc006` (includes #640, #641)
**Scope:** correctness, security, and production readiness across the whole platform. 1,270 TS/TSX files, 104 pages, 31 API routes (10 cron), 77 server-action modules, 132 migrations, ~70 Prisma models, 479 test files
**Method:** 105 agents in three fleets (14 cross-cutting bug classes, 14 subsystem deep reads, 7 depth tracks), every finding judged by two independent verifiers with opposing lenses (re-trace, then refute), plus a full deterministic baseline and 30 days of production telemetry
**Result:** 173 agent findings, 135 confirmed by both verifiers, plus 5 findings the orchestrator verified by hand.

> **Correction, 2026-08-16.** The first published version of this report led with "six of the ten
> scheduled jobs have never run in production" as a critical finding. That was wrong. The
> schedules are provisioned on cron-job.org and are **deliberately Inactive until launch**, so
> reminder mail does not go out to volunteers before the clinic opens. Section 1 has been rewritten
> to the launch checklist it should always have been, and the limits section now records why the
> inference failed. Findings 2 through 18 are unaffected.

## Executive summary

The code is in good shape and the deterministic baseline is entirely green: typecheck, lint,
production build, 5,738 unit tests, and GitHub CI including all three e2e shards, all passing on
this exact commit. Thirteen prior audits have cleared out the shallow defects and the high
findings from the 11th pass have demonstrably shipped.

**The clinic Teams channel card has never worked in production.** Every attempt times out on the
Graph call. Because a live success is the only thing that can seed the last-known-good fallback,
production has never had one, so the card is permanently absent for every user and each cold
render burns ~8s of a serverless invocation on a call that always fails. This is the one live
production defect in this pass.

The cron area still yields a real launch checklist (section 1), and one genuine observability
defect found while checking the correction: **the `[cron/<id>] complete` log stream is lossy**, so
it cannot be used to verify liveness. The app's own heartbeat does not depend on it.

Beyond that, the code findings cluster into three themes. **Confidentiality in the incidents
module** has two genuine leaks, both on paths the module's own guards deliberately close
elsewhere. **The term boundary** produces an inverted offboarding screen and a membership write
that resurrects offboarded people. **The invite-link feature (#613)** shipped without extending
three things it needed to extend: the PostHog scrubber, the applicant's read paths, and the
draft sweep.

Fix first, in order: **the Teams outage** (finding 2), then the two incidents confidentiality
leaks (findings 6 and 7), then the term-flip inversion (8). Work section 1's checklist at launch,
not now.

## Baseline

| Check | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `eslint src e2e scripts prisma` | 0 errors, 3 warnings (2 `<img>` LCP hints; 1 deliberate `cond ? a++ : b++`) |
| Unit suite (dedicated DB `havenhub_test_audit14`, 6 workers) | 479 files, 5,738 tests, 0 failures |
| `next build` (production) | succeeds, 104 routes |
| GitHub CI on `10cdc006` | static, test, e2e shards 1-3 all green |
| `npm audit` | 2 advisories, neither exploitable here (see appendix) |

Production traffic, 30 days: 43 unique visitors, 203 sessions, 3,016 pageviews. **This is pilot
traffic, not launch traffic.** A clean error stream is therefore weak evidence. Judge anything
about unbounded queries, N+1s, or batch sizes against the launch load, not against what has been
observed.

---

## P0. Operational: live defects and the launch checklist

### 1. Cron: the launch checklist, and one lossy-logging defect (MEDIUM)

**This section originally claimed six jobs had never been provisioned. That was wrong.** All ten
are configured on cron-job.org; five or six are set **Inactive on purpose** so reminder mail does
not reach volunteers before launch. What follows is what still needs doing, plus the one real
defect found while checking the correction.

**Scheduler state, 2026-08-16 (the authoritative source: the cron-job.org dashboard).**

| Job | Dashboard title | State |
| --- | --- | --- |
| `email` | email drain | Active, every 30 min |
| `recruitment-drafts` | recruitment draft drain | Active, daily 12:00 AM ET |
| `schedule-reminders` | swap reminders | Active, daily 8:00 AM ET |
| `wallet-passes` | Wallet Pass Sync | Active, daily 12:00 AM ET |
| `clinic-checkin-invites` | Clinic Check-in Reminder Saturday | **Inactive (intentional)** |
| `intercom-reconcile` | Intercom reconciliation | **Inactive (intentional)** |
| `recruitment-review-digest` | director application notif | **Inactive (intentional)** |
| `shift-reminders` | monday shift reminders | **Inactive (intentional)** |
| `reminders` | reminders | **Inactive (intentional)** |
| `attending-reminders` | not visible in the dashboard listing | **unconfirmed, needs a check** |

**1a. The completion log stream is lossy (MEDIUM, real).** Found while verifying the correction.
On 2026-08-16 cron-job.org recorded `recruitment draft drain` as **Successful (865 ms)** at
12:00:55 AM ET, and PostHog has **no** `[cron/recruitment-drafts] complete` line for that run,
even though `wallet-passes` logged normally in the same 04:00 UTC slot. Across 14 days
`recruitment-drafts` logged 5 completions and `wallet-passes` 2, for jobs the dashboard shows
running daily.

The log line is emitted unconditionally before `await flushLogs()`, so the loss is in the OTLP
export or ingestion, not in the route. **This does not affect the app's own monitoring:**
`recordCronHeartbeat` writes a `Setting` row and `getCronHealth` reads that row, so the `/admin`
staleness panel is independent of the log stream. What it does mean is that PostHog logs cannot
be used to answer "is this job running", by anyone, including a future audit. Worth either fixing
the export or writing that caveat into `docs/cron-jobs.md`.

**1b. Documented schedules do not match the configured ones.** `schedule-reminders` runs at
12:00 UTC (8:00 AM ET) against a documented `0 15 * * *`; `wallet-passes` runs at 04:00 UTC
against a documented `0 5 * * *`. Reconcile `docs/cron-jobs.md` with the dashboard.

**1c. `clinic-checkin-invites` may be scheduled weekly when the route expects daily.** Its
dashboard title is "Clinic Check-in Reminder **Saturday**", but the route's own header says
"Daily rather than weekly so a rescheduled or midweek clinic still gets its email; the runner
no-ops on non-clinic days." If it is configured Saturday-only, a rescheduled or midweek clinic
silently gets no check-in invites. Check the cron expression before enabling it at launch.

**1d. Confirm `attending-reminders` exists at all.** It is not visible in the dashboard listing
(which may simply be cut off). If it was never created, the weekly faculty reminder will not fire
at launch, and per finding 4 nothing in the app would ever say so.

**1e. A silent 401 is indistinguishable from a paused or missing schedule.** `authorizeCron`
(`src/platform/cron.ts:28-32`) returns false with no log, and each route then returns a bare 401.
So a rotated `CRON_SECRET` produces exactly the same evidence as a job that is switched off:
nothing anywhere. A `log.warn` on rejected cron auth makes the two distinguishable.

**Launch checklist for this area:** re-enable the five (or six) Inactive jobs; verify
`attending-reminders` exists; check 1c's cron expression; fix finding 4 so the tenth job is
monitored; fix finding 5 so `docs/DEPLOY.md` lists all ten; add the dead-man's-switch push alert
that `docs/DEPLOY.md:148-151` still marks "(recommended)". Note that until launch the `/admin`
cron-health panel will legitimately show the paused jobs as stale, and there is no "intentionally
paused" state to distinguish that from a real outage.

### 2. The clinic Teams channel link has never resolved in production (HIGH)

`src/platform/teams/channel-link.ts`, `src/app/(app)/clinic-channel-card.tsx`

`[teams/channel-link] resolve channel failed` x17 in production, ongoing (most recent
2026-08-16T02:20Z). Every occurrence is identical: `stage: "resolve channel"`, `attempts: 2`,
`tokenMs` 145-426 (token acquisition succeeds and is fast), `graphMs ~7,820`, `elapsedMs ~8,001`,
`TimeoutError`. Both attempts against `GET /v1.0/teams/{groupId}/channels` consume their entire
slice (5,000ms + 150ms backoff + 2,850ms = the 8,000ms budget) and never return.

In 30 days there is **not one success and not one `degraded; serving last-known-good` line from
production**; the single degraded line came from a preview deploy. Since `saveStoredLastGood` is
only reached on a live success (`channel-link.ts:458`), production has never written the
`teams.channelLinkLastGood` row, so the fallback added in `92b511ab` has nothing to serve. The
card is permanently absent for every user, silently: it renders inside
`<Suspense fallback={null}>` and the resolver is documented never to throw.

Secondary cost: `MISS_TTL_MS` is 5 minutes and the cache is module-level, so on Vercel every cold
instance pays ~8s of invocation wall time on a call that always fails.

The module is carefully built; the defect is that a 100% failure rate is invisible to an
operator. Related sub-findings the fleet raised, worth folding into the same fix:

- **No success-path telemetry at all.** `tokenMs`/`graphMs` are recorded only on the failure
  path, where they are pinned at the budget by construction, so the real latency that every
  budget decision has been argued from has never been measured. One `log.info` on a completed
  resolve settles it.
- **The retry split shortened the longest single attempt from 8,000ms to 5,000ms**
  (`channel-link.ts:134,150`). Deliberate and documented, but a Graph that answers in the
  5-8s band now fails deterministically where it previously succeeded. The budget test
  (`channel-link.test.ts:342-360`) asserts only an upper bound, so shrinking the first slice
  further would pass silently.
- **Six distinct causes all render nothing**, and only failure is logged.
- **A non-2xx Graph response is reduced to a bare status number** and its body never consumed, so
  a 403 scope problem and a 500 look the same in the logs.
- **No single-flight guard**: concurrent dashboard renders on one Fluid instance each fire their
  own Graph call and their own Entra token refresh.
- **The fallback is never invalidated by a successful "channel is gone" resolve**, so once seeded
  it can serve a dead deep link for the rest of the clinic week.

**Fix:** log every completed resolve; move the once-a-week answer off the RSC render path; make
the failure visible (an admin health row, not just a log line). Root cause needs a runtime probe
of the Graph call with the real token and group id, which static reading cannot settle.

### 3. Intercom ticket-state webhooks are being dropped in production (MEDIUM-HIGH)

Production logs: `[support] ticket.state.updated webhook missing a ticket id or state label` x4
on 2026-08-13 (03:05, 03:06, 04:02, 04:03 UTC, pairs ~60s apart, which is Intercom retrying), and
`[support] Intercom ticket.state.updated for an unknown ticket id` x2 on 2026-08-16 for
`intercomTicketId: 215475503912170`. **Both retries fail too**, so these are not the transient
ordering race the code comment hypothesises. Real Intercom state changes never reach the Hub, and
`intercom-reconcile`, the job that exists to report exactly this drift, is switched off until
launch, so nothing surfaced it.

Supporting code defects the fleet confirmed:

- `src/app/api/support/tickets/events/route.ts:252-258` comments that this branch logs the keys
  Intercom sent, precisely because "which fields did Intercom actually send" is the one question
  needed to debug it. **The production log lines for that branch carry an empty attribute map.**
  The one branch someone debugs a silent sync from is undebuggable.
- **SUP-1**: the `ticket.created` webhook never back-fills `intercomTicketId` onto a ticket Fin
  already created from the same conversation, permanently severing the sync link.
- **SUP-2**: a conversation-linked ticket with no Intercom Ticket id has no status control
  surface at all: the Hub hides every manager control because the ticket is "linked", while every
  Intercom-to-Hub status path keys on a column that path never sets.
- **INT-1**: nothing ever backfills `intercomTicketId`, and the reconciler structurally cannot
  see an orphaned ticket.
- **INT-3**: out-of-order or retried deliveries apply stale state, silently reverting a ticket's
  status, because the only guard is status equality.
- **SUP-4 / INT-4**: the reconcile sweep is capped at 500 rows with no persisted cursor, so past
  500 linked tickets it re-scans only the oldest forever and reports a clean sweep.

### 4. `attending-reminders` is invisible to the cron-health dashboard (MEDIUM-HIGH)

`src/platform/cron-heartbeat.ts:31-41`, `src/app/api/cron/attending-reminders/route.ts:34`,
`src/app/(app)/admin/page.tsx:55-56`

The route writes `cron.lastSuccess.attending-reminders`, but `CRON_JOBS` lists only 9 of the 10
externally scheduled jobs and omits it. `getCronHealth` maps over `CRON_JOBS`, so the heartbeat
row is written and never read: the job can never be flagged stale. This defeats the module's
stated purpose, whose own header says enqueue-only jobs leave no backlog when dead so the failure
is "otherwise INVISIBLE".

Found independently by seven agents across all three fleets plus the orchestrator.

No test guards it: `cron-heartbeat.test.ts:9` only does `CRON_JOBS.find(j => j.id === JOB)` for a
single job. **Fix:** add the entry (weekly, `maxStaleMs: 9 * 24 * 60 * 60 * 1000`), and add a
test that walks `src/app/api/cron/*/route.ts` for `recordCronHeartbeat("<id>")` and asserts each
id appears in `CRON_JOBS`.

### 5. The go-live checklist lists 6 of the 10 cron schedules (MEDIUM)

`docs/DEPLOY.md:133-138` omits `attending-reminders`, `clinic-checkin-invites`, `wallet-passes`,
and `intercom-reconcile`, though `docs/DEPLOY.md:192` asks that it and `docs/cron-jobs.md` be
updated together. An operator provisioning from DEPLOY.md creates six schedules. A third copy
drifted too: `src/platform/cron.ts:11-14` still describes three jobs and the wrong email cadence.

---

## P1. High-severity code defects

### 6. Strikes ledger shows a subject who holds `incidents.manage` the anonymous reporter's verbatim narrative (HIGH)

`src/modules/incidents/services/disciplinary.ts:335-345,479-502`,
`src/app/(app)/incidents/strikes/strike-row.tsx:102,148,171`,
`src/modules/incidents/services/report.ts:1111`

Every other manage-gated read in this module refuses a viewer who is a linked subject:
`getReport` (`report.ts:732-749`, comment: "they could otherwise unmask an anonymous reporter"),
`listReviewQueue` (`report.ts:814-816`), and the attachment route (`route.ts:70-75`).
`listActions`' central branch has no such exclusion: `buildCentralWhere` takes only
`(q, activeTerm)` and **never references the viewer**, and the branch returns the whole Prisma row.
`decideStrike` copies the reporter's free-text narrative onto the strike verbatim
(`description: report.description`) and sets `confidential = report.anonymous`. Confidentiality is
enforced only against directors (`directorVisibility`) and against the subject's own email and
`/my-info` view (`subjectFacingDetail`). Nothing stops the subject reading it on the ledger.

The actor is real, not hypothetical: `src/platform/rbac/system-roles.ts:57` seeds "Volunteer
Operations Manager" with `incidents.manage` + `incidents.view_strikes`, and anyone signed in may
report anyone.

**Scenario.** A volunteer reports Dana, the Volunteer Operations Manager, ticking "Do not share my
name". The narrative reads "I was on triage with her Saturday morning when she told the patient to
leave...". A second reviewer approves the strike. Dana's email correctly says "Contact your
department directors..." and `/my-info` shows the same. Dana then opens `/incidents/strikes`,
which she is entitled to open, and her own row is in the list with the narrative in full, plus the
reviewer's internal notes and the linked report number. From "triage, Saturday morning" she reads
that shift's roster and identifies the reporter.

Both verifiers confirmed at high; the refute lens reported it could not construct a refutation.
No test can catch it: every `listActions` case uses a separate target person, so the viewer is
never the subject.

**Fix:** redact rather than hide, so the ledger total stays honest and matches what `/my-info`
already shows: for any row where `r.personId === viewerPersonId`, substitute
`subjectFacingDetail(r)` for `description` and null `notes`, `followUpActions`, `policyReference`
and `reportId`.

### 7. The strike form's "internal notes" is the primary text emailed to the subject (HIGH)

`src/modules/incidents/services/disciplinary.ts:684-695`,
`src/app/(app)/incidents/strikes/page.tsx:481-490,495`,
`src/app/(app)/incidents/strikes/strike-row.tsx:168-173`

`subjectFacingDetail` returns `action.notes?.trim() || ...`, so notes win outright over
`description`, on the documented assumption that notes were "authored as a record the subject may
see". **The UI says the opposite, twice.** The Textarea that writes that column has the
placeholder `"Optional internal notes..."`, and the ledger row renders the same value under the
heading `"Internal notes"`. The `Notify by email` checkbox immediately beside it is
`defaultChecked`. Worse, the report detail page's adjacent reviewer field carries the explicit
hint "Internal notes. Not visible to the reporter or subject." (a different column), priming the
reviewer to read this one the same way.

So the one field the interface calls internal is the primary text sent to, and permanently shown
to, the person it is about, and it **displaces** the description the reviewer wrote for them.
There is no strike edit path in the module, so there is no in-app recovery: only deleting the
whole strike.

Note the same column is also written by `decideStrike` from the Approve form, which is not
labelled internal, so any fix must reconcile two forms writing one column with opposite implied
contracts.

### 8. An early term flip inverts the offboarding transition tab (HIGH)

`src/modules/admin/services/terms.ts:257`, `src/platform/terms/next-term.ts:10-14`,
`src/modules/volunteers/components/transition-tab.tsx:56`

`activateTerm` demotes a displaced term whose `endDate` is still in the future to `PLANNING`
(deliberate, so an early or mistaken flip stays recoverable). `getNextTerm()` is
`findFirst({ where: { status: "PLANNING" }, orderBy: { startDate: "desc" } })` with **no check
that the PLANNING term starts after the ACTIVE one**. After an early flip the demoted outgoing
term is normally the only PLANNING row, so "next term" is the term that just ended.

The transition tab then buckets every member of the *incoming* class as NOT_RETURNING and
**pre-checks every one of them** (`transition-tab.tsx:56` seeds the selection `Set` with exactly
those rows), while genuine returners are marked non-selectable. The offboarding page defaults to
this tab whenever a PLANNING term exists, and the admin confirm copy says it "archives" the
outgoing term, which is false on this branch.

Bounded by `MAX_BULK_OFFBOARD = 25` per confirmed click, so it takes several batches rather than
one. Both verifiers held it at high; the refute lens tried five distinct refutations and
discarded all of them. Secondary damage in the same window: `getPersonTerms` and `getWorkingTerm`
offer the just-ended term as "next", and schedule publication allows publishing it.

**Fix:** make "next" mean "starts after the live term" by adding
`startDate: { gt: activeTerm.startDate }` to the PLANNING query; refuse or warn on an activation
whose target starts before the current ACTIVE term; bail with `nextTerm: null` in
`transitionView()` when the ordering is inverted.

Related: **SCHED-5**, `getNextTerm` returns the latest-starting PLANNING term, so a second
planning term hijacks "next term" everywhere and hides the imminent term's shift requests from
the approvals page.

### 9. `copyRosterFromTerm` resurrects OFFBOARDED people onto a live roster (HIGH)

`src/modules/admin/services/roster.ts:441-460`

The upsert writes `status: "ACTIVE"` with **no `Person.status` guard**, and the source-term picker
offers ARCHIVED terms. Copying a roster from an archived term puts OFFBOARDED people back on the
live roster while their Person row stays OFFBOARDED, breaking the documented convergence
invariant that `Person.status` and `TermMembership.status` move together. This is the same class
the 11th audit fixed in `promoteContracts`; this path was the one membership writer missed.
Found by four agents across two fleets.

### 10. Executing a current-term offboard flag deletes the person's next-term membership (HIGH/MEDIUM)

**ONB-1.** Silently undoes a completed onboarding promotion with no in-app trace: a member
correctly onboarded into the incoming term loses that membership when a current-term offboard flag
is executed.

### 11. Email transport can degrade to `LogTransport` and stamp every row SENT (HIGH, latent)

`src/platform/email/transport.ts:340,383`, `src/platform/settings/service.ts:93-113`,
`src/platform/email/send.ts:180`

`resolveEmailTransport` reads `email.transport` with `getSettingUncached`, which catches Prisma
failures and returns `def.envDefault()` rather than throwing. If the env default is `log`, a
transient DB error on that single read collapses the transport to `LogTransport`, whose `send()`
resolves successfully, so `drainEmailQueue` writes `status: "SENT"` for **every row in the batch**:
terminal, no `lastError`, no FAILED card, no retry. The doc comment three lines above the read
states this exact hazard as the reason the read is uncached. The function already throws in
production for `graph` with no sender and `maileroo` with no key, for precisely this reason; the
degraded-transport case is the gap.

**Adjudicated with telemetry.** My two verifiers deadlocked (high vs not-a-bug) on whether
production's `EMAIL_TRANSPORT` is `log`. `LogTransport.send` logs `[email] from=... to=...
subject=...` at info, info logs are provably ingested, and there are **zero such lines in 30 days
of production**. So this failure mode has not occurred in production. It remains a real latent
hazard with a cheap guard, not an active incident.

**Fix (the cheap half):** in `resolveEmailTransport`, throw when the resolved value is `"log"`
under `VERCEL_ENV=production`, mirroring the existing graph/maileroo guards. Add a test that
stubs `prisma.setting.findUnique` to reject with P2021 and asserts the resolver rejects.

Closely related, both confirmed: **EMAIL-1**, a throwing transport resolver aborts the whole
drain, so the "fail loudly" guards deliver silent non-delivery instead of FAILED rows; and
**NOTIF-1**, the Teams transport's production refusal aborts the drain instead of failing rows,
so Teams messages sit QUEUED forever and the email fallback it exists to trigger never fires.

### 12. An invited applicant has no navigable way back to their own application (HIGH)

`src/modules/recruitment/services/portal-status.ts:64`,
`src/modules/recruitment/services/withdraw.ts:266`, `src/app/apply/page.tsx:90`,
`src/app/apply/i/[token]/page.tsx:39`, `src/modules/recruitment/services/drafts.ts:211`

`cycle-window.ts`'s own comment is explicit: "Every applicant-facing gate must call
`canSubmitToCycle`, not `isCycleOpen`, or an invite will work on one path and bounce on another."
The three **write** paths are correctly invite-aware. Three **read/navigation** paths still call
`isCycleOpen`: the status card (so no Continue link renders), `discardDraft` (so they cannot
discard and start over), and the portal's open-applications list (so the cycle is not listed).
The emailed link is not a fallback either: `peekInvite` requires `claimedAt: null`, so the link
shows "no longer valid" on the claimant's second click. Thirty days later `sweepAbandonedDrafts`
deletes the draft and every uploaded file.

The same-email re-claim branch that exists to make this work (`invites.ts:137-143`, documented as
"a double-submitted sign-in does not look like a stolen link") is unreachable, because
`peekInvite` gates it.

### 13. A closed clinic day still tells every assigned volunteer to come in (MEDIUM-HIGH)

**CLINIC-01.** Morning-of check-in invites, the Check-in tab, and self check-in all ignore
`ClinicDay.isClosed`. Ticking "Clinic closed" on the attending schedule silences the attending
side only (**SCHED-4**); volunteers are still reminded, invited to check in, and shown the shift.

### 14. "Download certificate" destroys the frozen service record of a reactivated returning alum (MEDIUM)

**PASSPORT-1.** Finder rated critical; verifiers settled at high/medium. Affects reactivated
returning alums and anyone whose memberships were removed.

### 15. A `PER_TERM` course can never be completed for a next (PLANNING) term (MEDIUM)

**L1.** Every member reads as permanently "not cleared" on the next-term builder banner, the
dashboard checklist, and the Epic roll-up. This bites during exactly the term-flip window that
finding 8 also targets.

---

## P2. Confidentiality, credentials, and privacy

### 16. Recruitment invite tokens ship to PostHog verbatim (MEDIUM)

`src/platform/posthog/scrub-url.ts:27`, `src/app/apply/i/[token]/page.tsx:64`

`SECRET_PATH_PREFIXES` is `["/onboard/", "/api/calendar/", "/credential/"]`. The
`/apply/i/[token]` claim route added in #613 is absent, and the file's header still says "Five
routes carry a live, unconsumed credential in the URL". The token leaks twice: in `$current_url`
and `$pathname` on the claim page view, and again via `redirect('/apply?next=/apply/i/<token>')`,
which the scrubber also misses (only `token` is a secret param name, and the nested-URL recursion
only descends into absolute http/https/webcal values, not a relative path).

Found independently by **eight** agents across all three fleets, the most-corroborated finding of
the pass. Same class as the 11th audit's T5 theme.

Related: **credential-bearing-urls-missing-ph-no-capture**, the `ph-no-capture` convention that
protects the calendar feed token was never applied to the invite link, the published credential
URL, or the wallet install anchors.

### 17. The admin audit viewer prints the full confidential disciplinary record (MEDIUM)

**VRT-2.** Deleting a strike writes its description and notes into `AuditLog`, which
`/admin/audit` renders verbatim to any `admin.view_audit` holder, bypassing `directorVisibility`
and `subjectFacingDetail` entirely.

### 18. Incidents: four more self-exclusion gaps (MEDIUM)

The subject-exclusion guard exists only in `report.ts`. Confirmed gaps elsewhere:

- **forwardReport / forwardStrike** have no subject guard, so a manager who is a linked subject
  can email a report about themselves to any outside address. Recipients are free-typed, and the
  `reportId` arrives from a client-editable hidden input. The action's doc comment still claims
  recipients come from a "configured directory" that was removed, so it documents a guard that no
  longer exists.
- **`linkableReports`** hands a subject who holds `incidents.manage` the id, number, concern types
  and date of the report filed about them.
- **`deleteAction`** lets an `incidents.manage` holder delete the strike issued against
  themselves, silently reverting the source report's approved strike request to PENDING.
- **INC-2**: a multi-subject report's single narrative is copied verbatim onto every subject's
  independent strike, so each subject and each subject's directors are told what the co-subjects
  did.

---

## P3. Everything else confirmed by both verifiers

Grouped by theme. Each was confirmed by two independent verifiers.

**Scheduling and clinic**
- **SCHED-1** Next-term approvers are emailed and cron-nagged about shift requests they are
  forbidden from opening or deciding.
- **SCHED-2 / CLINIC-02** Check-in invites filter only `Person.status`, not ACTIVE
  `TermMembership`, so a roster-removed volunteer is invited and can record attendance.
- **SCHED-3** The PENDING shift-request unique index and duplicate guard both omit `termId`.
- **CLINIC-04** `markPresent` and `undoAttendance` write and hard-delete attendance with no audit
  entry.
- **clinic-day-latched-closed** An on-call-only save latches `isClosed = true`; a Saturday later
  added to the calendar stays silently closed.
- **fullschedule-loads-whole-term** The clinic-wide schedule page loads every shift assignment in
  the term to render a single date.

**Terms, roster, and RBAC**
- **VRT-4** `activateTerm` and `archiveTerm` change which RoleAssignments the engine honours but
  skip the last-admin invariant every sibling mutation enforces.
- **term-enddate-noon-utc-vs-now** Term start/end are noon-UTC markers compared against a raw
  instant, so "the term has ended" becomes true at 8am ET on the final clinic day.
- **Maintenance mode self-lockout** (four independent finds) Writable with
  `admin.manage_settings` but bypassable only with the raw `*` grant, so a settings admin can lock
  themselves out with no in-app recovery. Plus **AUTH-MAINT-03**, turning it off can produce an
  `ERR_TOO_MANY_REDIRECTS` loop for up to 30s because the proxy and the page read the switch from
  two independent 30s caches.

**Recruitment and onboarding**
- **REC-2 (decide)** Speed-route's "Route the middle" modal routes a returned applicant straight
  back to the department that just declined them.
- **REC-3 / REC-4** The reviewer's "Recruitment history" card counts unsubmitted DRAFT
  applications as prior applications.
- **REC-3 (decide)** Decisions page counts and the conflict list include withdrawn applicants, so
  "Unnotified" and "Conflicts to resolve" can never be cleared.
- **REC-5 (decide)** Promoting from an archived cycle's waitlist emails an acceptance that can
  never be onboarded; archiving is terminal.
- **archived-cycle-is-a-one-way-door** Archiving permanently blocks releasing decisions and
  sending onboarding links for anyone still mid-pipeline.
- **REC-5 (intake)** `SUBCOMMITTEE_RANK` re-opens the client/server `visibleWhen` gap: `asArray`
  does not treat `["","",""]` as unanswered.
- **ONB-3** `promoteContracts` writes an applicant-typed `Person.netId` without the
  `isNetIdShaped` guard the import path applies, so free text lands in the column feeding the YNHH
  Epic PDF and the Teams removal CSV.
- **ONB-4** `lookupStoredEpicId` matches the contract NetID without trimming while
  `promoteContracts` trims, freezing `storedEpicId: null` into the signed record.
- **draft-sweep-deletes-invited-applicants** The abandoned-draft sweep deletes an invited
  applicant's draft and uploads from a closed cycle they may still submit to.

**Passport, wallet, and photos**
- **PASSPORT-2** A wallet badge stays live and scannable after a mid-term roster removal or
  self-withdrawal; the daily sweep does not look at membership at all.
- **PASSPORT-5** An offboarded member's public credential page cannot be retracted by anyone, and
  offboarding rewrites its contents without their involvement.
- **service-credential-revocation-unimplemented** `ServiceCredential.revokedAt` is read in four
  places and documented as the admin revocation control, but nothing ever writes it.
- **PASSPORT-3** The wallet badge picks an arbitrary membership when a member holds more than one
  in the active term, so a director's card can read "Volunteer" and name the wrong department.
- **PASSPORT-4** After "Add to wallet" auto-publishes the credential, the card still shows it as
  unpublished and hides the Unpublish control until a full reload.
- **wallet-pass-concurrent-issue** Two overlapping "Add to wallet" calls both mint a vendor pass;
  the upsert overwrites `serialNumber`, orphaning a live badge no revoke path can reach.

**Email and notifications**
- **EMAIL-2** Attending reminder resend silently reaches almost nobody while reporting success:
  idempotency is keyed on the address for 6 days, not on the clinic date.
- **EMAIL-3** Switching `email.transport` to maileroo without also changing `email.sender` fails
  every outbound email permanently.
- **EMAIL-5** A campaign whose recipient enqueue partially fails is unrecoverable; the banner says
  "resend" but no resend path exists for a SENT campaign.
- **EMAIL-6** The shared layout can be saved without its `{{{ body }}}` slot, silently emptying or
  HTML-escaping every outbound email.
- **EMAIL-4 / teams-transport-cached-read** (four finds) `resolveTeamsTransport` reads
  `email.transport` through the 30s cache, so a stale `"log"` marks real Teams DMs LOGGED:
  terminal, no retry, no email fallback.
- **reminders-canreach-suppresses-teams-routed-members** With a reminder type routed to Teams,
  `canReach()` silently skips every member whose `entraObjectId` is not yet cached.
- **clearance-reminders-no-per-person-isolation** One throw takes the dedup claim, suppresses that
  member's reminder for a full interval, and aborts the rest of the roster.
- **schedule-reminder-empty-requests-url** Pending shift-request reminder emails render with an
  empty `href`, shipping a dead button to every approver.
- **applicant-withdrew-link-no-access** The withdrawal notification links panelists to
  `/recruitment`, which redirects them to `/no-access`.
- **NOTIF-4** The withdrawal fan-out notifies offboarded former panelists.
- **NOTIF-5** The bell dropdown orders read notifications by when they were read, not when they
  arrived, disagreeing with `/notifications`.
- **NOTIF-3** The channel-link fallback fires on permanent Graph errors and is never invalidated.

**Compliance and learning**
- **L2** The dashboard clearance card computes the HIPAA checkmark and its sub-text from two
  different rules, so an early renewal renders a green check labelled "Awaiting verification".
- **L3 / hipaa-badge-expiry** The HIPAA panel and the weekly reminder advertise an expiry read off
  an unverified certificate while status came from an older verified one.
- **L4 / clearance-learning-progress-unordered** `loadClearanceMap` reads ONCE-course progress
  last-wins with no `orderBy`, unlike `getMyCourses` which explicitly guards it, so a completed
  course can read as incomplete on the builder banner while the member's checklist says Complete.
- **quiz-correct-answer-orphaned** Deleting a quiz answer choice leaves `correctValue` pointing at
  the deleted option, making the makeup quiz unpassable.

**UI, accessibility, and front-end correctness**
- **UI-1** Dark-mode WCAG AA failure: `text-subtle-foreground` on `bg-muted` is 3.74:1, baked into
  the shared Table header primitive.
- **A11Y-1** `Alert` renders a `<p>`, so three new call sites passing block children get parsed
  apart: the warning box renders empty and its text spills outside it.
- **A11Y-2** `ConfirmButton` disarms after 3s, shorter than its own `aria-live` label takes to
  speak, so a screen-reader user can never reach the confirm step of any destructive action.
- **A11Y-3/5/6/7/8** Unlabelled support reply box and file input; `TicketNumberField` drops focus
  to `<body>`; wallet publish/unpublish destroys the focused button and announces nothing; the
  bulk reminder button has no pending state; verified-language badges carry meaning only in a
  `title` tooltip.
- **UI-3** Modal-driven actions swallow a rejected server action: no error, no retry cue, work
  silently lost.
- **UI-4** `useFocusTrap`'s focusable set counts non-focusable nodes and bails out entirely when
  the panel's only control disables itself, the exact moment it exists to cover.
- **UI-2** `shallowRouting` on the global progress bar suppresses the only loading indicator for
  every query-only navigation (pagination, sorting, filtering, term switching).
- **AUTH-NAV-01** The Learning module link dead-ends at `/no-access` for exactly the people
  `additionalAccessPermissions` exists to admit. (This is the dead-end-result bug's fifth
  recurrence.)
- **sortable-list-optimistic-order-never-cleared**, **apply-preview-answers-survive-close**,
  **attendings-reminder-success-rendered-as-error**, **notification-bell-mark-read-no-revalidate**,
  **ticket-number-field-stuck-saving**, **wallet-badge-publishes-but-card-shows-unpublished**.

**Auth and sessions**
- **offboarded-session-welcome-redirect-loop** An offboarded member with a live JWT is trapped in
  a `/welcome` and `/` redirect loop and cannot reach `/login` or the Sign out button.
- **invite-claim-page-dead-ends-for-its-own-claimant** (see finding 12).

**Performance and platform**
- **scorm-asset-route-uncacheable** Every SCORM package file is served through a route that
  forbids caching and runs five database queries per file.
- **scorm-ingest-serial-uploads** Ingest uploads up to 2,000 files to R2 one at a time inside a
  server action with no declared `maxDuration`.
- **epic-history-unbounded-client-payload** `/support/epic` serializes every YNHH ticket ever
  recorded, with four nested relations, into a client component on every visit.
- **wallet-sweep-unbounded-serial-vendor-calls**, **bulk-flag-uncapped**,
  **DM-3** (`EmailLog` has no index serving the admin email monitor's default listing).
- **person-scalars-projection-does-not-close-deploy-window** `PERSON_SCALARS` / `TICKET_SCALARS`
  name every column, so the projection `DEPLOY.md` credits with fixing the #597/#598 outage
  changes nothing about the emitted SQL. Worth reading alongside **DM-1** (the projection guard
  misses the sign-in path) and **DM-2** (`SET NOT NULL` and dropping an upsert's conflict-target
  index are two more single-release-unsafe shapes with no guard).
- **max-upload-mb-env-default-bypasses-the-4mb-cap** The #75 cap is enforced only on the
  admin-editable value; `MAX_UPLOAD_MB` from the environment is never clamped, and `.env.example`
  still ships the unusable 5.
- **SUP-3** `completeRequest` claims the request COMPLETED before writing `Person.epicId`, so a
  failed write leaves a completed Epic request with no Epic ID and no retry path.

**Test-suite integrity**
- **TSI-01** The smoke suite's only content assertion is a regex matching strings Next.js 16 never
  emits, so 32 routes are guarded by nothing but "HTTP < 400".
- **TSI-05** The email-template variable guard runs off hand-maintained key lists covering 19 of
  46 descriptors; `schedule.test.ts` already omits one of its own group's keys, and the send path
  swallows the resulting failure with no log.
- **TSI-03** 148 inline `"use server"` closures are the sole authorization boundary for the app's
  most destructive mutations, and no test at any layer reaches them.
- **TSI-04** Four authenticated file-download routes (HIPAA certificates, incident evidence,
  applicant resumes, support attachments) have no route-level test at all.

**Unauthenticated surface**
- **UNAUTH-01** An outsider can silently disable the applicant portal's magic-link sign-in for 24
  hours by burning the global daily token ceiling.
- **UNAUTH-02** `/api/mcp` writes an `AuditLog` row for every request carrying any `Authorization`
  header, before authentication succeeds.
- **UNAUTH-03** `saveDraftAction` persists arbitrary, unvalidated, unbounded JSON into
  `Application.answers`.
- **UNAUTH-04** Every per-IP rate limiter keys on the attacker-controllable leftmost
  `x-forwarded-for` value and stores state in per-instance memory, so none of them binds. (Read
  with UNAUTH-01.)
- **UNAUTH-05** A volunteer can mark any assigned training course complete by POSTing a forged CMI
  snapshot to the SCORM beacon, clearing the onboarding gate and the clinic clearance badge. One
  verifier only; worth a hand check given the compliance stakes.

**Observability**
- **OBS-04** `/api/health` reports `mailer: true` from row existence, so an uptime monitor stays
  green through a dead Graph refresh token.
- **OBS-05** Production, staging, preview, and local dev all write into one PostHog project with
  no environment tag on any event or exception.
- **OBS-07** The observability stack's own env vars are unvalidated: a missing PostHog token
  silently disables all logs and analytics, and a missing `CRON_SECRET` silently disables all ten
  jobs.
- **OBS-08** The clinic geofence's fail-closed branch is unreachable: the unverified hardcoded
  coordinate always resolves, so the fence goes live against a default whose own comment says it
  MUST be confirmed against the real clinic entrance before production use.

---

## Checked and explicitly NOT findings

Recorded so a future pass does not re-raise them.

- **Forged `x-pathname` bypassing the onboarding gate.** `src/proxy.ts:24` stamps the header and
  its matcher excludes `/api`, so an API route would see a client-supplied value. But no route
  under `src/app/api/` calls `requirePersonSession` (verified by `rg`); the SCORM and persist-cmi
  routes use `auth()` directly, as `onboarding-allowlist.ts` documents. The surface is empty.
- **The 13th audit's R2-unset-in-production hole.** Fixed at `src/platform/config.ts:333-365`.
- **`npm audit` advisories.** `nanoid` reaches the tree only via `postcss` (build-time);
  `undici` via `juice` to `cheerio`, and `src/platform/email/render/inline.ts:35` calls `juice()`
  synchronously, which never fetches web resources. Hygiene bumps, not production risk.
- **`existing ? report.daysUpdated++ : report.daysCreated++`** at
  `src/platform/attendings/import/schedule.ts:347`. The lint warning is stylistic; the behaviour
  is correct.
- **`incidents-form-ships-full-active-roster`** and **CLINIC-03**, **UI-5**: rejected by both
  verifiers.

## Method and limits

- **105 agents.** Fleet A: 14 cross-cutting bug classes (authorization, data exposure, Prisma
  semantics, concurrency, input validation, tokens, degradation, time, RSC boundary, React,
  email, performance, ops, state machines). Fleet B: 14 subsystem deep reads. Fleet C: 7 depth
  tracks (test integrity, schema and migrations, red-team, a11y, observability and ops, plus
  focused investigations of the two live production failures). Every finding was then judged by
  two independent verifiers with deliberately opposing lenses: one re-traces the claim in the
  code, one is instructed to refute it and to default to "not a bug".
- **346 verifier verdicts.** 173 findings, of which 135 were confirmed by both verifiers, 35 by
  one, and 3 by neither. Verifiers deflated heavily: several findings filed as critical were
  settled at high or medium, and the report reflects the verifiers' consensus severity, not the
  finder's.
- **Deduplication matters.** The same defect was frequently found from several angles. The invite
  token PostHog leak was filed eight times, the `attending-reminders` heartbeat gap seven times
  (plus once by hand), `copyRosterFromTerm` four times. Corroboration count is noted where it is
  high, because it is a useful confidence signal.
- **Production telemetry cut both ways.** It found finding 2 and it settled finding 11, where the
  two verifiers deadlocked and only the absence of `[email]` log lines could break the tie. It
  also produced this report's one wrong headline: see the limits below.

**Limits, stated honestly:**

- Static reading plus telemetry. No browser session and no runtime reproduction of any finding.
- **Absence of logs is not absence of events, and this report learned that the hard way.** The
  original section 1 reasoned that because every cron route logs a completion unconditionally and
  info logs are ingested, a missing line proved the job never ran. Two things break that. First,
  a job deliberately switched off at the scheduler looks identical to one that was never
  provisioned, and six were switched off on purpose. Second, the log stream is genuinely lossy
  (section 1a): a run cron-job.org recorded as successful produced no line at all. The right
  primary source is the cron-job.org dashboard; the right in-app source is the `Setting`-backed
  heartbeat, which does not depend on logs.
- A silent 401 remains indistinguishable from a paused or missing schedule, because
  `authorizeCron` logs nothing on rejection.
- The root cause of finding 2 is not established. The evidence pins the symptom precisely; the
  cause needs a runtime probe of the Graph call with the real token and group id.
- Severity is a judgement. Anything marked medium that touches a term flip should be treated as
  high during the flip itself.
- Findings confirmed by only one verifier are marked as such where they appear. UNAUTH-05
  (forged SCORM CMI clearing the onboarding gate) is the one single-verifier finding with high
  enough stakes to deserve a hand check before it is dismissed.
- Production has had 43 unique visitors in 30 days. Nothing here has been exercised at launch
  scale.

---

## Follow-ups (all code items now closed, 2026-08-16)

Recorded here rather than silently dropped. Every one that was a code change has
since been made; the two that remain are launch-checklist items that cannot be
done from the repository.

**Closed:**

- **Admin UI for credential revocation.** `/admin/people/[id]` now has a Service
  credential section with Revoke / Restore, gated by the page's existing
  `admin.manage_people` (the same permission the service checks). It renders only
  when a credential exists, since a member issues their own from `/my-info`.
- **`issueWalletPassAction` return type.** Now derived as
  `Awaited<ReturnType<typeof issueWalletPass>>` instead of retyped by hand, so
  `publicToken` is no longer typed away.
- **Wallet sweep unbounded serial vendor calls.** Bounded to 150 per run with
  `SWEEP_CONCURRENCY = 6`, sized against the route's `maxDuration = 300` and the
  vendor's 8s timeout. Failures no longer end the run: one badge the vendor
  refuses used to abandon every pass behind it. Truncation is logged with the
  real backlog size, and the batch is deterministically ordered so a capped run
  and the next one agree on what comes first.
- **Epic ticket archive.** `getEpicRequestHistory` now takes the status the tab
  actually renders (Tracker OPEN, History CLOSED) instead of fetching every
  ticket ever recorded and discarding half in the client, and History is capped
  at `EPIC_HISTORY_LIMIT`. The table says when it is showing a capped set.
- **TSI-05, the send-path half.** `renderTemplate` takes an optional
  `onUnknownName`, and `renderEmail` warns with the template key and the missing
  names. Absence is the signal, not emptiness, so a legitimately-null optional
  field stays quiet. This covers what `registry.test.ts` cannot: admin overrides
  stored in the database against a variable a later code change removed.

**Still open, and not code:**

- **Revoking a credential does not revoke wallet badges.** Deliberate: the badge
  asserts present standing and is governed by the sweep and the offboard paths,
  and a revoked credential already leaves the badge's QR resolving to a 404.
- **The clinic geofence default (OBS-08).** Audit 13 measured the shipped
  coordinate at roughly 140 m from the clinic address, so the fence does cover
  the building. The residual is confirming the entrance coordinate before the
  first clinic day: a launch-checklist item, not a code change.
- **Cron provisioning (section 1).** Re-enable the paused jobs at launch, confirm
  `attending-reminders` exists on the scheduler at all, check whether
  `clinic-checkin-invites` is configured Saturday-only when the route expects
  daily, and add the dead-man's-switch push alert `docs/DEPLOY.md` still marks
  "(recommended)".

---

## Issue-tracker triage (2026-08-16)

Every open item on GitHub and in PostHog Error Tracking was worked to closure.
Both are now at zero.

**GitHub: 7 open, all auto-filed from PostHog, all closed.**

| # | Verdict | Cause |
|---|---------|-------|
| 631, 630, 629 | Not planned | One `next dev` run against a database with no schema. `The table public.Setting does not exist`, six events in 200ms on one day, stack rooted in `.next/dev/`. |
| 598, 597 | Completed | The dropped-column incident `PERSON_SCALARS` exists to prevent. Column gone from the schema, projection guard in place, and the missed sign-in path closed by DM-1 this round. |
| 580 | Not planned | The visitor's Zotero Connector extension talking to its own dead background worker. |
| 529 | Not planned | HTTP 429 from PostHog's own asset CDN while fetching the replay recorder, passed through the `/ingest/static` rewrite. One event, staging, internal account. |

**What the triage actually found.** Four of the seven were not defects, and the
finding is that they were filed at all: local dev and third-party extension
exceptions were reaching the shared PostHog project, becoming Error Tracking
issues, and auto-filing GitHub issues that sat in the open list beside real
defects. Tagging local events `environment: "development"` (OBS-05) did not stop
this, because the event is still captured. Both sources are now dropped before
capture -- `onRequestError` returns early when `VERCEL_ENV` is unset (dev, tests,
CI, but *not* staging or preview), and a third `before_send` predicate drops
exceptions thrown entirely inside a browser extension.

**And one thing the triage corrected.** The PostHog issue for #597/#598 carries
`source: src/platform/auth/match-person.ts`. The sign-in path was not merely the
half that *would* break next time, as DM-1 was written up -- it is where the
original outage fired, and the first round of that fix hardened `getActivePerson`
while leaving the function that actually threw unprojected. Closed this round.
