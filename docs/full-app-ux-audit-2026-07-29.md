# HAVEN Hub, Whole-App UX Flow-Friction Audit (2026-07-29)

Twelfth whole-app audit, and the first to ask what it is like to *use* HAVEN Hub rather than
whether it is correct, secure, accessible, or on-brand. The eleven prior passes covered
correctness, data integrity, security, WCAG accessibility, theming, and design-system drift.
None of them walked a journey end to end and asked whether a person who had never seen the
app could get through it.

- **88 published items** covering **87 independently verified findings** plus **1 pre-seeded
  design item filed as 2** (see "How the count reconciles").
- **Method:** five browser-walked volunteer and applicant journeys (tier 1) and three code-read
  director and admin surfaces (tier 2). Every finding was verified against source by an
  independent reviewer before it was accepted.
- **Ranked on severity times reach**, not severity alone.
- **Severity spread:** `blocks` 16, `costs-time` 63, `polish` 9.
- **Effort spread:** S 61, M 21, L 6. The six `L` items are pulled out of the backlog into
  "Needs its own brainstorm."

---

## Purpose and method

### What this audit asked that the prior eleven did not

The prior audits asked "is this right?" This one asked "can someone get through this?" Those
are different questions and they find different defects. A page can be correct, accessible,
on-token, and still tell a volunteer to upload a certificate they already uploaded. Nothing in
a correctness pass catches that, because nothing is wrong: both screens are rendering exactly
what they were written to render. It only shows up if you upload the certificate and then click
"Back to checklist."

So the unit of work here was the journey, not the file. Three lenses were applied to each one:

- **flow:** does the next step follow, and does the app tell you what just happened?
- **ia:** can you find the thing, and does the label mean what it does?
- **visual:** does the screen make the important thing look important?

Deliberately out of scope, because the 2026-07-11 audit covered them and shipped 132 fixes:
accessibility, contrast, ARIA, responsive breakpoints, and design-token drift.

### How it was conducted

**Tier 1 (browser-walked).** Five journeys driven through a real browser against a real dev
server on a dedicated local Postgres database (`havenhub_uxaudit`, 96 migrations, seeded plus
purpose-built fixtures). Every claim in a tier-1 finding was observed, and density or style
claims were measured against the live DOM rather than eyeballed. Where a finding could only be
confirmed from source, the row says so.

**Tier 2 (code-read).** Three director and admin surface sweeps with no browser and no dev
server, at deliberately lower depth. Every tier-2 claim is traced from the file and line cited.
Where a finding depends on a state combination or rendered output that could not be observed,
the row says so explicitly. Tier 2 is weaker evidence than tier 1 and is ranked accordingly.

**Every finding passed an independent review gate.** Each task's findings were verified against
current source by a separate reviewer before acceptance. Several were rejected, several were
re-severitied, one inherited finding was retracted as already fixed (the "Copy email" silent
no-op in `epic-request-form.tsx`, fixed in commit `f007277b` on 2026-07-11, before this audit
began), and one was reproduced from raw database rows rather than trusted. That gate, not a
finding cap, is what keeps this list free of padding.

### Ranking: severity times reach

Findings are ranked on **severity times reach**, not severity alone. The ladder is:

1. Tier 1, `blocks`
2. Tier 1, `costs-time`
3. Tier 2, `blocks`
4. Tier 2, `costs-time`
5. Tier 1, `polish`
6. Tier 2, `polish`

A tier-1 `costs-time` finding outranks a tier-2 `blocks` finding. That is deliberate and it will
feel wrong in places, because a tier-2 `blocks` finding is usually the more technically
offensive defect. The justification is population: tier-1 findings hit hundreds of untrained
people every semester, most of whom will see the screen once and have no one to ask. Tier-2
findings hit a handful of trained staff who run the same flow every week, know the workarounds,
and can walk down the hall. Ranking on severity alone aims the backlog at whatever annoys the
people closest to the code. Ranking on severity times reach aims it at everyone else.

Within a tier: `blocks` outranks `costs-time` outranks `polish`.

### Severity and effort are judgments, not measurements

`blocks` means the person cannot complete the task from this UI, or completes it while wrong
about what happened. `costs-time` means they get there, slower or by a route they had to invent.
`polish` means it works and reads badly. Those lines were drawn by hand, and reasonable people
will move some of them. F-06-11 (the failed quiz that hands over the answer key) is graded
`blocks` on the "leaves them wrong about what happened" clause applied to the clearance record's
downstream readers rather than to the test-taker, and its own row says to re-grade it to
`costs-time` if you read that clause strictly. F-04-9 (the four-shift minimum the form states
but does not enforce) is filed `costs-time` and has a fair case for `blocks`.

Effort (`S`, `M`, `L`) is a rough size, not an estimate. `S` is a copy, badge, link, guard, or
prop change. `M` is a component or service change with a small blast radius. `L` means a design
or policy decision has to be made before anyone writes code, which is why every `L` is pulled
out of the backlog entirely.

### How the count reconciles

87 verified findings arrived from the eight fragments:

| Source | Tier | Findings |
|---|---|---|
| Task 4, applicant journeys (apply, resume draft, onboard) | 1 | 22 |
| Task 5, new-volunteer entry and compliance | 1 | 10 |
| Task 6, learning and training | 1 | 12 |
| Task 7, schedule | 1 | 10 |
| Task 8, service surfaces (incidents, support, AVS, notifications) | 1 | 16 |
| Task 9, recruitment management and the schedule builder | 2 | 7 |
| Task 10, volunteers, incidents review, support and learning management | 2 | 5 |
| Task 11, admin module | 2 | 5 |
| **Total** | | **87** |

Two merges were applied, each collapsing a pair into one row:

- **R3 merges F-07-4 and F-07-5.** Both are the same missing date comparison in the schedule
  change-request flow (`eligibleSwapPartners`, `createRequest`, `approveRequest`), reached from
  two controls on the same card. Task 7's own fix for F-07-5 reads "Add the same guard as
  F-07-4, and ship them together."
- **R4 merges F-04-3 and F-04-11.** Both are the same missing post-submission state on the
  onboarding contract, seen immediately after submitting and on returning to the link later.
  Task 4's fix for F-04-11 reuses "the next-steps content from F-04-3."

87 findings minus 2 merges gives **85 rows**. Adding the 3 pre-seeded items (the toast system,
the inline-`Alert` migration, and the bottom-right overlay collision) gives **88 published
items**. Nothing was cut. There is no cut list.

Two de-duplication rulings made during the audit were checked and upheld rather than merged:

- **F-09-1 stays distinct from F-07-4/F-07-5.** The builder's pending-requests panel has its own
  gap that survives the submission-time guard: a request that was valid when filed goes stale
  during the pending-to-approval window, and the panel still shows no date framing. One is the
  requester's form, the other is the approver's queue.
- **F-10-2 stays distinct from F-08-1.** Different actor, mechanism, and consequence. F-08-1 is
  the reporter not being told who reads their name. F-10-2 is the reviewer not being told that
  their own approval click silently excludes the subject's directors.

---

## Ship these first

This is the batch to build if you read nothing else. It is 17 rows covering 19 items (17 verified
findings plus the 2 pre-seeded ones), grouped into seven small pieces of work: 11 `S` and 6 `M`, no
`L`, no design decisions outstanding. Stopping here and shipping exactly this leaves the app
materially better and leaves nothing half-done.

It contains every tier-1 `blocks` finding that does not need a design decision first, plus the
tightly coupled companions that would otherwise leave a shipped fix contradicting itself, plus
the toast system, which was the request this audit originated from.

### A. Transient feedback (2 items, M + S)

| Rank | ID | What | Effort |
|---|---|---|---|
| R11 | New | Build the toast notification system, and convert the highest-traffic flash sites | M |
| R12 | New | Fix the bottom-right overlay collision | S |

The app has no transient notification system at all. Every action confirmation is a
server-rendered inline `Alert` driven by a redirect search param. Build `ToastViewport`,
`useToast()`, and the flash-param reader, and convert the highest-traffic pages. The remaining
30 to 40 pages are the expensive half and are sequenced as **B6** in "Needs its own brainstorm";
do not leave a page rendering both, or every action double-reports. The overlay collision ships
with this because it is the same viewport decision: the collision is part of why toasts go
bottom-center.

### B. The HIPAA verification wait (3 items, all S)

| Rank | ID | What | Effort |
|---|---|---|---|
| R1 | F-05-1 | The checklist contradicts the page you just left, one click apart | S |
| R18 | F-05-2 | The pending state says nothing, and the reassuring copy renders only when the parser failed | S |
| R19 | F-05-3 | Verification never tells the member it happened | S |

Three fixes describing one moment: the state name, the copy, and the notification. Shipping any
one alone leaves the other two contradicting it. Together they close the single worst
uncontrolled wait in the product: a volunteer locked out of the entire app by an event they are
never told about.

### C. The schedule has no concept of a past date (2 rows, 3 findings, both S)

| Rank | ID | What | Effort |
|---|---|---|---|
| R3 | F-07-4 + F-07-5 | Swap partners are all in the past, and drop requests on past shifts are accepted | S |
| R58 | F-09-1 | The approval queue gives a director no way to see a stale request | S |

R58 is tier 2 and ranks below 47 tier-1 items on its own, but it is the approver half of the
same missing date comparison and belongs in the same sitting. Without it, a director clearing
the queue can still approve a stale drop and delete the `ShiftAssignment` row that records a
shift someone actually worked.

### D. The incident form's two silent defaults (2 items, both S)

| Rank | ID | What | Effort |
|---|---|---|---|
| R9 | F-08-1 | The anonymity checkbox never says who actually reads the report | S |
| R10 | F-08-2 | The form pre-answers the safety question as "No" on the reporter's behalf | S |

Both are copy and a default value. Both sit on the one form in the app where being wrong about
what happens next has consequences outside the software.

### E. The Spanish patient handout (3 items, S + S + M)

| Rank | ID | What | Effort |
|---|---|---|---|
| R7 | F-08-5 | Spanish handouts translate the headings and print the clinician's words in English | S |
| R55 | F-08-7 | The last line of the Spanish handout is hardcoded English | S |
| R8 | F-08-6 | There is no way to see the handout before printing it and handing it over | M |

The only output in this audit that leaves the building in a patient's hand. Ship the copy
warning and the footer string now; the preview is the real fix and makes the language boundary
self-evident instead of described. Note the coverage caveat in the next section: `/clinic/avs`
is gated on `clinic.access`, which no role in the audit database grants, so this surface's
current real-world reach depends on an ops decision that is outside this audit.

### F. The training quiz (3 items, M + M + S)

| Rank | ID | What | Effort |
|---|---|---|---|
| R6 | F-06-1 | An unkeyed quiz is mathematically unpassable and nothing warns anyone | M |
| R5 | F-06-11 | A failed attempt hands over the full answer key and lets you resubmit immediately | M |
| R20 | F-06-2 | "Try again" discards every answer, including the right ones | S |

R5 and R20 must land together: R20's original fix read the answer key client-side, which R5
removes. Use R5's new `wrongKeys` payload for both.

### G. The applicant's blind choices and dead ends (2 rows, 3 findings, both M)

| Rank | ID | What | Effort |
|---|---|---|---|
| R2 | F-04-1 | The department dropdown offers raw codes with no names and no descriptions | M |
| R4 | F-04-3 + F-04-11 | Onboarding ends on a dead-end screen, and returning to the link reads as a failure | M |

The department choice is the single most consequential answer in the application and is
currently made blind. The onboarding completion screen is the last thing an accepted volunteer
sees before they are expected to show up somewhere, and it contains zero links and zero buttons.

### What is deliberately not in this batch

**Two tier-1 `blocks` findings are excluded because they need a decision before anyone writes
code**, not because they are less serious:

- **B1 / F-06-12:** a course completed once satisfies the learning gate in every later term.
- **B2 / F-04-2:** the onboarding contract has no draft save of any kind, and the ordinary path
  through it loses everything typed.

Both are in "Needs its own brainstorm." Do not ship this batch and consider the gate work done.

---

## Coverage

Coverage is uneven by design (tier 1 walked, tier 2 read) and uneven by accident (several
states could not be reached locally). Stated plainly here rather than implied by omission.

### Walked in a browser (tier 1)

At a 1200px desktop viewport, against `localhost:3000` on `havenhub_uxaudit`.

| Journey | Surfaces walked |
|---|---|
| Applicant applies | `/apply` signed out and signed in, magic-link sign-in, the 12-step wizard cold from zero, review, submit, the status tracker, and the resume-draft path |
| Accepted applicant onboards | The tokenised onboarding contract end to end, submission, the completion screen, and a revisit of the link afterwards |
| New volunteer first login | `/get-started` landing, the profile step, the HIPAA step including a real upload and a rejected upload, `/my-info`, and the dashboard |
| Learning and training | `/learning`, `/get-started/learning`, the SCORM player including leave-and-return, and the makeup quiz walked failure-first then to a pass |
| Schedule | `/schedule` including the availability editor and both request forms, `/schedule/full` at default and selected dates, and `/schedule/requests` |
| Service surfaces | `/incidents` (a real report filed), `/incidents/mine`, `/incidents/[id]`, `/support/new` (a real ticket filed), `/support`, `/support/[id]`, `/clinic/avs` (English and Spanish PDFs generated and their text decoded), the notification bell, and `/notifications` |

### Code-read only (tier 2)

No browser, no dev server, deliberately lower depth. Every claim traced to a file and line.

| Sweep | Surfaces |
|---|---|
| Recruitment management and the schedule builder | The cycle overview, form builder, speed-route, decisions, applicant detail, cycle emails, onboarding, interview detail, `/schedule/builder`, and the attendings pages |
| Volunteers, incidents review, support and learning management | `/volunteers/*` (compliance, master, EHS, spanish-review, offboarding), `/incidents/review`, `/incidents/strikes`, the reviewer half of `/incidents/[id]`, `/support/all`, `/support/epic`, and `/learning/manage/*` |
| Admin | Every page under `src/app/(app)/admin/`, with the IA lens weighted heavily because the admin nav is one decision affecting eleven pages at once |

### What could not be walked, and why

**Environment limits.**

- **Yale SSO / Microsoft Entra.** Not configured locally (`AZURE_AD_*` unset), so the provider
  is absent from the auth config entirely. The applicant on-ramp was walked through the
  magic-link path instead, which is a real production path but not the common one. Any
  SSO-only behaviour is unverified, including how the Entra `firstName` affects the greeting in
  R77 / F-04-19.
- **`/clinic/avs` in the hands of the people who would use it.** The module gates on
  `clinic.access` and no role in this database grants it; both audit personas land on
  `/no-access`. The AVS findings were walked as the seeded Platform Admin. That is the right
  surface in the wrong hands: how a front-desk volunteer discovers the tool is uncovered.
  Whether the AVS *should* be reachable by the people running clinic is an ops question, not a
  UX one, so nothing is filed on the gate itself.

**Fixture limits.**

- **Renewal and transfer applicant types.** Gated on the signed-in identity being an existing
  member; neither audit persona is one. The renewal branch, its department picker, and the
  transfer guard are entirely uncovered.
- **Drawn signatures.** The onboarding pads were completed via "Type instead". Canvas stroke
  capture, the Clear button on a drawn signature, and the stored PNG are unverified. R32 /
  F-04-17 describes only what is observable in typed mode.
- **The unkeyed-quiz path (R6 / F-06-1).** Re-keying the fixture's questions to nothing would
  have broken the persona for every later task. Source-confirmed at four call sites; labelled as
  such in the row.
- **The pre-window makeup training state (R43 / F-06-9).** The fixture cycle's
  `inPersonTrainingDate` is already past, so the `!makeupOpen` branch never renders. The
  checklist half was walked; the destination half was read from source.
- **The quiz attempt-cap lock state.** Reaching it needs three deliberate failures, and the
  third would have locked the persona out of a blocking step for every later task.
- **The moment the onboarding gate lifts.** No persona could be taken from gated to released
  within one task's scope. R17 / F-05-5's claim that there is no acknowledgment on release is
  read from `src/app/get-started/page.tsx:15` (a bare `redirect("/")`), not observed.
- **The true first-time dashboard.** The gated persona cannot reach it and the cleared persona
  has five upcoming shifts, so the empty-state dashboard a genuinely new volunteer sees on their
  first unlocked visit is uncovered. R42 / F-05-9 is answered against a populated dashboard only.
- **Real schedule density on `/schedule/full`.** The fixture schedules one department on every
  clinic date, so the densest real page loadable was one card with four people. The production
  figure in R38 / F-07-9 (4,263px, 5.3 viewport heights) comes from a DOM measurement of that
  real card cloned to 30, against a shipped catalog of 36 departments. Real cards carry more than
  four names, so that figure is a floor.
- **Learning list density with many courses**, and **long SCORM content in the fixed-height
  player iframe.** One course, two short modules. Nothing is claimed about either.
- **Notification volume.** Measured over four rows. The pagination and scanning-cost claims in
  R50 and R51 rest on the measured absence of any filter control and on `NOTIFICATIONS_PAGE_SIZE`
  from source, not on a walked long list.
- **Multi-term and multi-department schedule views.** The persona is on one term in one
  department, so neither branch rendered.
- **A support ticket receiving an actual manager reply.** Confirmed from source that a manager
  comment notifies the requester; not walked. The conversation thread is covered as a static
  surface, not a live exchange.
- **Attachments on the incident and support forms.** The guards were read, nothing was uploaded.
- **The availability editor save path on `/schedule`.** Rendered and read, not saved.

**Scope limits.**

- **Mobile and every viewport below 1200px.** Nothing was walked narrow, anywhere in the audit.
  This is the largest single coverage gap. Several findings will behave differently and probably
  worse on a phone: the onboarding contract's 4,719px length, the 18-checkbox availability list,
  R75 / F-05-10's truncation, R48 / F-06-10's module nav, and the quiz intake grid. That is
  inference, and it is deliberately not claimed in any finding.
- **Accessibility, contrast, ARIA, and design-token drift.** Out of scope per the audit brief;
  covered by the 2026-07-11 audit. One thing noticed in passing and recorded rather than filed:
  the three agreement fields on the applicant contract step take their entire ~250-word policy
  body as their accessible name. R27 / F-04-16's fix resolves it as a side effect.
- **Tier 2 has no runtime verification at all.** Every tier-2 finding is a source trace. Where a
  finding depends on a permission combination or rendered state that could not be observed, the
  row says so.
- **Tier-2 pages not opened**, and named so nobody assumes they were clean: the recruitment
  waitlist, subcommittees, standalone training tab, interviews list, applicants list, cycles
  list, and the contract and quiz builder editors; `schedule/attendings/new`; the support
  `ticket-detail`, `comment-thread`, `attachment-list`, `epic-person-picker` and `submit-form`
  components; the admin `audience-builder`, `cron-presets`, `timing-actions`, `use-form-dirty`
  and template preview components; the admin OAuth callback route and loading skeleton.
- **One RBAC edge case was noticed and deliberately not filed.** The admin module's manifest
  carries no `additionalAccessPermissions`, unlike volunteers, recruitment, and learning. If a
  real role holds only `admin.send_email_campaign` without `admin.access`, `AdminLayout` blocks
  it before its own page-level check runs, which would make R70 / F-11-3's reachability problem
  total rather than partial. Confirming that needs an RBAC correctness check against seeded
  roles, which is outside this audit's scope.

### Fixture and data state left behind

Recorded because a later reader will find rows that look like defects and are not.

- **`ux.cold@example.com` has a submitted application in `ux-audit-cycle` carrying deliberately
  degenerate data:** a `.txt` file accepted as the cover letter (R23 / F-04-12) and a single
  availability date against the form's stated four-shift minimum (R22 / F-04-9). Audit debris,
  not a product defect.
- **`ux.accepted@yale.edu`'s onboarding contract is SUBMITTED and does not self-heal.** Re-running
  the fixture script reuses any existing contract regardless of status. Restoring a PENDING
  contract means deleting or resetting the row first.
- **`ux.fresh@yale.edu` is no longer from-zero.** Phone set, one dateless HIPAA certificate on
  file, training passed via quiz (two `QuizAttempt` rows), one of two course modules complete,
  and the fabricated `minShiftsWanted = "4"` from R45 / F-06-4 persisted.
- **Two CANCELLED `ShiftRequest` rows, two incident reports, two tech requests**, and six
  notifications on `dev.volunteer@yale.edu` rather than the fixture's four, because setting a
  ticket's status and setting it back notifies on both transitions.
- **No application code was changed by any task in this audit.**

---

## The ranked findings

82 ranked items across six severity bands, plus 6 unranked items in "Needs its own brainstorm."
Tier 1 is browser-walked, tier 2 is code-read.

### Index

| Rank | ID | Tier | Severity | Effort | Summary |
|---|---|---|---|---|---|
| R1 | F-05-1 | 1 | blocks | S | Uploading a HIPAA certificate leaves the checklist still saying "upload your certificate" |
| R2 | F-04-1 | 1 | blocks | M | The department dropdown offers raw codes with no names and no descriptions |
| R3 | F-07-4 + F-07-5 | 1 | blocks | S | The schedule change-request flow has no concept of a past date |
| R4 | F-04-3 + F-04-11 | 1 | blocks | M | Onboarding ends on a dead-end screen, and returning to the link reads as a failure |
| R5 | F-06-11 | 1 | blocks | M | A failed quiz attempt hands over the full answer key and allows an immediate retry |
| R6 | F-06-1 | 1 | blocks | M | A quiz with no answer keys is unpassable and nothing warns anyone |
| R7 | F-08-5 | 1 | blocks | S | Spanish handouts translate the headings and print the clinician's words in English |
| R8 | F-08-6 | 1 | blocks | M | There is no way to see the patient handout before printing it |
| R9 | F-08-1 | 1 | blocks | S | The anonymity checkbox never names who actually reads the report |
| R10 | F-08-2 | 1 | blocks | S | The incident form pre-answers the safety question as "No" |
| R11 | New | 1 | costs-time | M | There is no transient notification system anywhere in the app |
| R12 | New | 1 | costs-time | S | The help launcher and the inactivity warning occupy the same corner |
| R13 | F-05-4 | 1 | costs-time | M | The progress counter can never fill and "Not yet cleared" never clears |
| R14 | F-07-1 | 1 | costs-time | M | Past and future shifts render identically and nothing marks the next one |
| R15 | F-04-4 | 1 | costs-time | M | Resuming a draft reopens at step 1 of 12 with every step marked incomplete |
| R16 | F-04-8 | 1 | costs-time | S | "This field is required." stays under a field after it is filled in |
| R17 | F-05-5 | 1 | costs-time | S | The onboarding gate never says it locks the whole app |
| R18 | F-05-2 | 1 | costs-time | S | The verification wait explains nothing, unless the PDF parser failed |
| R19 | F-05-3 | 1 | costs-time | S | Verifying a certificate never tells the member it happened |
| R20 | F-06-2 | 1 | costs-time | S | "Try again" discards every answer, including the correct ones |
| R21 | F-06-3 | 1 | costs-time | S | A disabled Submit will not say which question is unanswered |
| R22 | F-04-9 | 1 | costs-time | M | The stated four-shift minimum is not enforced anywhere |
| R23 | F-04-12 | 1 | costs-time | S | File fields accept anything and state no size or type limit |
| R24 | F-04-13 | 1 | costs-time | M | Non-Yale applicants must still fill required Yale NetID and Yale email fields |
| R25 | F-04-14 | 1 | costs-time | M | Choosing a department silently adds a required step six steps later |
| R26 | F-04-10 | 1 | costs-time | M | Failed contract validation leaves you scrolled past the error with nothing focused |
| R27 | F-04-16 | 1 | costs-time | M | The attendance policy is one unbroken paragraph stuffed into a help text |
| R28 | F-04-5 | 1 | costs-time | S | The submit confirmation has no links and no decision timeline |
| R29 | F-04-6 | 1 | costs-time | S | The portal lists the same cycle twice with contradictory calls to action |
| R30 | F-04-7 | 1 | costs-time | S | A cycle deep link, signed out, names no cycle, no date, and no role |
| R31 | F-04-15 | 1 | costs-time | M | Browser Back shows the portal with no draft (provisional) |
| R32 | F-04-17 | 1 | costs-time | S | Signature pads show the empty canvas and the text input at the same time |
| R33 | F-07-2 | 1 | costs-time | S | Shift cards omit the weekday and do not link to who else is working |
| R34 | F-07-7 | 1 | costs-time | S | The full schedule does not know who you are |
| R35 | F-07-8 | 1 | costs-time | S | The clinic date strip gives no anchor for today |
| R36 | F-07-10 | 1 | costs-time | S | A pending request shows no date, no owner, and no expected wait |
| R37 | F-07-6 | 1 | costs-time | S | The swap button fires on one click, the drop button needs two |
| R38 | F-07-9 | 1 | costs-time | M | The department grid has no search, filter, or jump navigation |
| R39 | F-05-6 | 1 | costs-time | S | The gate's only help is a sentence that is not a link |
| R40 | F-05-7 | 1 | costs-time | S | Certificate rejections show raw developer error strings |
| R41 | F-05-8 | 1 | costs-time | S | The profile step never says which field is actually missing |
| R42 | F-05-9 | 1 | costs-time | M | The action feed has no heading and repeats the navigation |
| R43 | F-06-9 | 1 | costs-time | M | Training reads as actionable before the makeup window opens |
| R44 | F-06-6 | 1 | costs-time | M | Nothing tells a learner what a course expects or that progress saves |
| R45 | F-06-4 | 1 | costs-time | M | Shift preferences sit below the Submit button and default to a fabricated 4 |
| R46 | F-06-5 | 1 | costs-time | S | "Back to courses" lands on the checklist |
| R47 | F-06-7 | 1 | costs-time | S | A completed course shows no completion date and no term |
| R48 | F-06-10 | 1 | costs-time | S | Module titles truncate where there is room to show them |
| R49 | F-08-11 | 1 | costs-time | M | "Awaiting requester" is third person and the notification says nothing |
| R50 | F-08-13 | 1 | costs-time | S | Unread is a 6px dot that also knocks the list out of alignment |
| R51 | F-08-14 | 1 | costs-time | S | The notifications page reorders the list and drops the unread affordance |
| R52 | F-08-3 | 1 | costs-time | S | Nothing says the incident form is not monitored in real time |
| R53 | F-08-4 | 1 | costs-time | S | Filing a report tells you what was stored, not what happens next |
| R54 | F-08-10 | 1 | costs-time | S | A refresh destroys the whole AVS form with no warning |
| R55 | F-08-7 | 1 | costs-time | S | The Spanish handout's last line is hardcoded English |
| R56 | F-08-8 | 1 | costs-time | S | The patient handout prints the internal IT mailbox as the patient's contact |
| R57 | F-08-9 | 1 | costs-time | S | Two different handouts download under one filename |
| R58 | F-09-1 | 2 | blocks | S | The approval queue cannot tell a live request from a stale one |
| R59 | F-09-7 | 2 | blocks | S | "Record decision" never says the applicant is notified from another page |
| R60 | F-11-2 | 2 | blocks | S | "Reset to built-in default" resets to the admin's master template instead |
| R61 | F-10-2 | 2 | blocks | S | Approving a strike on an anonymous report silently excludes the directors |
| R62 | F-09-2 | 2 | costs-time | S | "Save quiz settings" does not mention that the questions live elsewhere |
| R63 | F-10-1 | 2 | costs-time | S | "Assign to all departments" silently overrides the department picks beside it |
| R64 | F-10-3 | 2 | costs-time | S | The support triage table has no priority column |
| R65 | F-09-6 | 2 | costs-time | S | Publish is one click, Unpublish needs a confirm |
| R66 | F-09-5 | 2 | costs-time | S | The day-view date strip ignores the current clinic date it already has |
| R67 | F-09-4 | 2 | costs-time | S | Cycle lifecycle actions have no card, heading, or explanation |
| R68 | F-10-5 | 2 | costs-time | S | The "Added to EHS?" column affects nothing and says nothing |
| R69 | F-11-1 | 2 | costs-time | S | Subcommittees are a recruitment concept editable only inside Admin |
| R70 | F-11-3 | 2 | costs-time | S | Campaigns and Templates appear in no nav and no command palette |
| R71 | F-11-4 | 2 | costs-time | S | Three unrelated surfaces are named "Notifications" |
| R72 | F-11-5 | 2 | costs-time | S | Saving one setting returns you to the top of a 44-field page |
| R73 | F-09-3 | 2 | costs-time | S | The cycle emails pages lose their breadcrumb trail |
| R74 | F-08-16 | 1 | polish | S | Three empty states in one release, three different shapes |
| R75 | F-05-10 | 1 | polish | S | A dashboard action tile clips to "Request a s..." |
| R76 | F-04-20 | 1 | polish | S | The confirmation email subject reads "application application" |
| R77 | F-04-19 | 1 | polish | S | A brand-new applicant is greeted "Welcome back, Ux" |
| R78 | F-04-21 | 1 | polish | S | Step titles and option labels do not match their contents |
| R79 | F-04-22 | 1 | polish | S | The training acknowledgement is missing the word "at" |
| R80 | F-08-15 | 1 | polish | S | "Mark all as read" is offered on an empty notifications page |
| R81 | F-08-12 | 1 | polish | S | The ticket header prints "Submitted" twice, meaning two things |
| R82 | F-10-4 | 2 | polish | S | Resetting a learner's progress confirms with a bare "Confirm?" |
| B1 | F-06-12 | 1 | blocks | L | A course completed once satisfies the learning gate in every later term |
| B2 | F-04-2 | 1 | blocks | L | The onboarding contract has no draft save of any kind |
| B3 | F-07-3 | 1 | costs-time | L | Nothing in the app says when a shift starts or where to go |
| B4 | F-06-8 | 1 | costs-time | L | Learning modules have no deadline anywhere in the model |
| B5 | F-04-18 | 1 | costs-time | L | The application and the contract use incompatible form models |
| B6 | New | 1 | costs-time | L | Migrate the remaining inline flash alerts to toasts |

---

### Band 1: tier 1, blocks

The person cannot finish the task from this UI, or finishes it while wrong about what happened,
and the population is everyone.

#### R1. F-05-1: Uploading a HIPAA certificate leaves the checklist still saying "upload your certificate"

`flow` / tier 1 / every new volunteer, once per semester / **S**
`src/modules/onboarding/engine/status.ts:20-22`, `src/app/get-started/onboarding-checklist.tsx:37-46`

**What is wrong.** Uploading the certificate produced "Certificate uploaded successfully" and,
on the step page, "Completion date pending. A compliance manager will verify the completion
date. No action is needed from you." One click on "Back to checklist" then rendered the HIPAA
row byte for byte as before the upload: warning badge "Action needed", the same description
"Upload your current HIPAA certificate", the same primary button "Upload certificate", and the
counter still "1 of 5". The checklist and the step page state the opposite thing about the same
certificate, one click apart, and the only action the checklist offers is the one that changes
nothing. `deriveHipaaTaskState` returns COMPLETE only for COMPLIANT and EXPIRING_SOON, so both
PENDING_VERIFICATION and UNKNOWN_DATE collapse to INCOMPLETE, and `StatusPill` maps INCOMPLETE
plus an href to the warning "Action needed". A volunteer who uploaded a valid certificate is
told, indefinitely, that they still have to upload it.

**Fix.** Give the HIPAA task the IN_PROGRESS state the engine already models: in
`deriveHipaaTaskState`, return `"IN_PROGRESS"` for `PENDING_VERIFICATION` and `UNKNOWN_DATE`,
keeping INCOMPLETE for `NO_CERTIFICATE` and `EXPIRED`. `StatusPill` already renders IN_PROGRESS
as a neutral "In progress" badge and `TaskRow` already downgrades a non-INCOMPLETE CTA to the
outline variant. Then swap the row's description and CTA for that state to "We have your
certificate. A compliance manager is confirming the date." and "View certificate". IN_PROGRESS
still fails `isSatisfied`, so the gate itself is unchanged.

#### R2. F-04-1: The department dropdown offers raw codes with no names and no descriptions

`ia` / tier 1 / every applicant, once per cycle / **M**
`field-preview.tsx`, `/apply/[slug]/page.tsx`, `apply-wizard.tsx`, `wizard-review.tsx`,
`templates/application/volunteer.ts:10`, `templates/application/director.ts:10`

**What is wrong.** The department preference dropdown offers only the raw internal codes `VADM`,
`MDIC`, `PATS`, with no names and no descriptions. The only guidance is the sentence "See
department descriptions at havenfreeclinic.com/apply", which is plain text, not a link. The
single most consequential answer in the entire application cannot be given knowingly. The raw
code then reappears on the review step ("Department / position preference: MDIC") and in the
generated step title ("MDIC department questions"), so the last chance to catch a wrong choice
is also an acronym.

**Fix.** `field-preview.tsx` renders `departments.map((d) => <option value={d}>{d}</option>)`
over `cycle.departments`, which holds codes. Load `Department.name` for those codes in
`/apply/[slug]/page.tsx`, thread a code-to-name map through `apply-wizard.tsx` into
`field-preview.tsx`, `wizard-review.tsx`, and the generated step title (both templates build it
as `${norm} department questions`), and render the name with the code as fallback. Make the
descriptions pointer a real anchor.

#### R3. F-07-4 + F-07-5: The schedule change-request flow has no concept of a past date

`flow` / tier 1 / every volunteer who needs a swap or a drop after roughly the term midpoint,
which is most of the term / **S**
`src/modules/schedule/services/requests.ts:1018-1105`, `:298-397`, `:651-691`,
`src/app/(app)/schedule/page.tsx:279`, `:326-370`

**Merged from two findings.** F-07-4 (every swap partner offered is in the past) and F-07-5 (a
drop request on a past shift is accepted and confirmed) are the same missing date comparison
reached from two controls on the same card. Task 7's own fix for F-07-5 reads "Add the same
guard as F-07-4, and ship them together."

**What is wrong.** *Swap:* measured across all four cards that offer swaps, each `<select>` held
exactly the same five options, all for dates before today. `eligibleSwapPartners` filters on
term, department, role, active membership, the actor's own busy dates and partners already on
the requester date, and never once compares a clinic date to now; its final sort is ascending,
so the stalest option is offered first. Selecting one submitted successfully, redirected to
`/schedule?requested=1`, showed "Change request submitted. Your director will review it.", and
left the card reading "Change requested: swap with Uxa Pending (July 11th) (pending director
review)". The volunteer wanted off a future shift, believes a swap is in motion, and has filed
something that can only be denied. *Drop:* the change disclosure renders for every shift with no
date condition. Walked on a shift seven weeks in the past: the form submitted, the server
accepted it, the banner confirmed it, and the sidebar's pending count went 0 to 1.
`approveRequest` has no date precondition either, so an approver clearing the queue would run
`planApply` and delete the `ShiftAssignment` row recording that this person actually worked that
day.

**Fix.** Filter the past out at the source. In `eligibleSwapPartners`, resolve today's key the
way the rest of the module does (`formatForDateInput(new Date(), await getDisplayTimeZone())`)
and add `isoDateKey(p.clinicDate) >= todayKey` to the existing filter. Add the mirror guard in
`createRequest` next to the existing clinic-date validation, throwing
`RequestValidationError("That clinic date has already passed.")` for either a past
`requesterDateKey` or a past `targetDateKey`, so the API is closed even though the UI no longer
offers it. Add the matching precondition to `approveRequest` so a queue-clearing approver cannot
silently erase worked-shift history. Client side, compute `isPast` alongside `dateKey` and
replace the disclosure on past shifts with a muted "This shift has passed." line. The existing
`swapPartners.length === 0` branch then renders the honest "No eligible swap partners for this
shift." instead of five impossible ones.

#### R4. F-04-3 + F-04-11: Onboarding ends on a dead-end screen, and returning to the link reads as a failure

`flow` / tier 1 / every accepted volunteer, once per cycle / **M**
`src/modules/recruitment/services/onboarding.ts:285-575`

**Merged from two findings.** F-04-3 (the completion screen is terminal) and F-04-11 (revisiting
the link afterwards renders an error) are the same missing post-submission state. Task 4's fix
for F-04-11 reuses "the next-steps content from F-04-3."

**What is wrong.** Submitting the contract replaces the page with a heading and one sentence:
"Thanks, your onboarding is complete. We will be in touch with next steps." The DOM contains
zero links and zero buttons. `submitContract` queues no email and creates no notification, and
`EmailLog` gained no row, so nothing is actually in flight. The Epic section one screen earlier
had promised "We will set up your Epic account. Directions follow after you submit this form";
no directions follow. The volunteer has never signed into HAVEN Hub and is given no route into
it, and the applicant portal afterwards only says "Onboarding in progress / Form submitted" with
no action. Reloading the onboarding URL later then renders "This onboarding form is not
available / The link may be invalid or already completed / Need a new link? Contact the HAVEN
Free Clinic IT team", so a volunteer who bookmarked the link, or reopens the email to check what
they signed, reads a failure and is told to email IT.

**Fix.** Replace the bare status line with a next-steps screen: how to sign into HAVEN Hub, the
training date and location already stored on the cycle (`inPersonTrainingDate`,
`trainingLocation`), the Epic directions the form promised, and what happens on the director's
side. Queue a matching confirmation email in `submitContract`. Then branch the token page on
contract status: for SUBMITTED and PROMOTED render a confirmation ("You completed this on
{date}") plus that same next-steps content, and reserve the invalid-link error for unknown or
expired tokens.

#### R5. F-06-11: A failed quiz attempt hands over the full answer key and allows an immediate retry

`flow` / tier 1 / every volunteer who fails the makeup quiz at least once, and every downstream
reader of the clearance record they then produce / **M**
`src/modules/recruitment/services/training.ts:339-342`,
`src/app/(app)/training/training-quiz.tsx:186-202`, `:89-93`, `:112-116`

**What is wrong.** `submitQuiz` returns `correctByKey` for every graded question, not just the
missed ones, and the review UI marks the matching option "Correct" on all 15. `tryAgain` clears
state with no cooldown, no question reshuffle, and no option reshuffle. The review UI only ever
renders on a failed non-locking attempt, because passing and locking both take the
`router.refresh()` path, so this is exactly the state that precedes another attempt. Walked:
after scoring 0%, the page showed the correct option for all 15 questions, and "Try again"
returned an immediately submittable form. On the volunteer's own journey this costs nothing,
which is the problem: the resulting `Training.status = COMPLETE` / `completedVia = QUIZ` row
certifies 80% competency on HIPAA, documentation language, and IPV-disclosure handling to the
clearance map, the schedule builder, and the director putting that person in front of a patient,
when what was demonstrated may only be the ability to re-read the previous screen.

**Severity note.** Graded `blocks` under the "leaves them wrong about what happened" clause,
applied to the record's consumers rather than to the test-taker. Re-grade to `costs-time` if you
read that clause as strictly test-taker-facing.

**Fix.** Stop returning the answers on a retryable attempt. Change `submitQuiz` to return
`wrongKeys: string[]` (the graded keys the learner missed) instead of `correctByKey` on the
failed-and-not-locked path, and mark only the learner's own selection with "Not correct" for
those keys, leaving every other option unmarked, so the review still says which questions to
restudy without disclosing what to pick. Secondarily, shuffle `q.options` per attempt from a
per-attempt seed so positional recall cannot substitute for knowledge. Ship with R20, which must
consume the same `wrongKeys` list.

#### R6. F-06-1: A quiz with no answer keys is unpassable and nothing warns anyone

`flow` / tier 1 / every gated volunteer in a term whose training cycle was published with no
answer keys; whole-cohort when it happens / **M**
`src/platform/quiz/grading.ts:19-30`, `src/app/(app)/training/training-quiz.tsx:67-82`,
`src/modules/recruitment/services/training.ts:306`, `:40-53`

**What is wrong.** A quiz whose questions carry no `correctValue` is mathematically unpassable.
`gradeQuiz` drops unkeyed questions from `total`, then returns
`passed = total > 0 && rawPercent >= passPercent`, so zero keyed questions means `passed` is
permanently false; the file's own header comment states this outright. The learner-side "Makeup
quiz not ready yet" card only fires on `questions.length === 0`, and `submitQuiz` only throws on
the same condition, so 15 unkeyed questions render and submit as a normal quiz.
`setTrainingCycle` validates nothing before designating a cycle as term training. The volunteer
gets the fail banner three times, then the locked state "Your makeup quiz is locked after 3
attempts. Contact your recruitment director to reset it." They are told they answered wrong,
they are blocked from a blocking onboarding step, and neither screen mentions that passing was
impossible.

**Coverage note.** Source-confirmed at the four call sites cited, not walked: the fixture cycle
is keyed, and re-keying it to nothing would have broken the persona for every later task.

**Fix.** Two guards. *Learner side:* `getMyTrainingForTerm` already queries `FormField` for the
quiz; add `correctValue: true` to that select, count the non-null ones into a new
`gradedQuestionCount` on `MyTraining`, and render the existing "Makeup quiz not ready yet" card
when it is 0. Throw the same `TrainingStateError` in `submitQuiz` when no question is keyed. Do
not send `correctValue` itself to the client. *Builder side:* in `setTrainingCycle`, when `value`
is true, count keyed `SINGLE_SELECT` fields in the cycle's `QUIZ` sections and throw
`TrainingStateError("This cycle's quiz has no answer keys, so nobody could pass it.")` when the
count is 0. Ship alongside R62, which is the plausible contributing cause on the builder side.

#### R7. F-08-5: Spanish handouts translate the headings and print the clinician's words in English

`flow` / tier 1 / every Spanish-speaking patient handed a summary, which is a large share of a
free clinic's panel / **S**
`src/modules/clinic/avs/build-summary.ts:62-64`, `:76-81`, `:86`

**What is wrong.** The Spanish handout is bilingual in the worst place: the scaffolding is
Spanish and every word the clinician actually wrote is English. A realistic visit generated in
Español decoded as: "INFORMACIÓN DEL PACIENTE", "DETALLES DE LA VISITA", "MOTIVO DE LA VISITA /
Hypertension follow-up", "DIAGNÓSTICOS / AFECCIONES / High blood pressure, Type 2 diabetes",
"NOTAS / Take your blood pressure at home every morning before breakfast and write the numbers
down.", "SEGUIMIENTO / 3 meses, Blood pressure check", "RECOMENDACIONES DE ESTILO DE VIDA / Cut
back on salt. Walk 20 minutes a day." `buildSummary` localizes headings, chip labels, and dates
but passes every free-text field through untouched. Nothing in the UI warns about this: the
language `Select` is unlabelled as to scope and the three "Printed as typed" hints speak to
verbatim, not to language. The patient carries home a document that looks translated and whose
only actionable sentences are not.

**Fix.** Make the boundary visible where the text is typed. When `preferredLang === "es"`, render
an inline note under each free-text field ("Printed as typed. Type this in Spanish; only the
headings are translated.") and change the three hint strings from "Printed as typed." to "Printed
as typed, in whatever language you type." Add a one-line `Alert tone="warning"` under the
language `Select` when `es` is chosen. The real fix is R8; ship the copy now and the preview
next.

#### R8. F-08-6: There is no way to see the patient handout before printing it

`flow` / tier 1 / every clinician producing a handout, every visit, and every patient who
receives a wrong one / **M**
`src/modules/clinic/avs/avs-tool.tsx:83-95`

**What is wrong.** `grep -n "preview"` in `avs-tool.tsx` returns nothing; the only output path is
`handleGenerate` building a blob and clicking a synthetic `<a download>`. Walked twice: clicking
Generate produced a silent file download with no on-screen change at all (measured immediately
after: zero elements matching `[role="alert"], [role="status"]`, and the button label back to
"Generate PDF"). Switching the language changed nothing on screen either; after selecting Español
the entire form, including every field label, every chip, and all eight follow-up options, still
rendered in English. So the clinician's only route to checking a patient handout is to download
it, find it, open it in another application, and read it, per patient, and the one thing they
most need to check (R7's language mixture, R55's English footer) is invisible until they do.

**Fix.** Render the summary on the page instead of only into the PDF. `buildSummary(data,
data.preferredLang)` is already a pure function returning a `LocalizedSummary` of
`blocks`/`items`, so an `<AvsPreview summary={...} />` component can render the same structure
into a right-hand column or a collapsible panel, live as the clinician types, using the same
headings and localized labels the PDF uses. This needs no change to `build-summary.ts` or
`avs-pdf.tsx`.

#### R9. F-08-1: The anonymity checkbox never names who actually reads the report

`ia` / tier 1 / every person who files a report and wants to stay unnamed; the whole point of the
anonymity control / **S**
`src/app/(app)/incidents/page.tsx:187-191`, `src/modules/incidents/services/report.ts:238`,
`src/app/(app)/incidents/[id]/page.tsx:267`, `src/app/(app)/incidents/review/page.tsx:131`

**What is wrong.** The form never says who receives the report, and its one statement about
disclosure is narrower than a reporter will read it. Section 10 renders "Your name: Dev
Volunteer" and a single checkbox labelled "I would prefer to remain anonymous (your name is not
shared with the subject)". Checking it changed nothing else on the page. What actually happens is
that the report fans out to every holder of `incidents.manage`, the reporter's real name renders
verbatim on the detail page each of them opens, and the review queue's search box is documented
as matching "Subject, reporter, or report #". So "anonymous" means anonymous to one named party,
and the person deciding whether it is safe to report a colleague is told nothing about the set of
people who will read their name. Nowhere on the form, the confirmation, or the detail page is
that audience described.

**Fix.** Replace the bare checkbox with an explicit disclosure block above it: "Your report goes
to the clinic's incident reviewers ({n} people who hold the incidents.manage permission). They
will see your name whether or not you check the box below." Then relabel the checkbox to what it
does: "Do not share my name with the person I am reporting."
`peopleWithAnyPermission(["incidents.manage"])` is already called on submit, so the page can call
it too and render the count. Mirror the same sentence on `/incidents/[id]` next to the Anonymity
field so the reporter can re-read the promise later.

#### R10. F-08-2: The incident form pre-answers the safety question as "No"

`flow` / tier 1 / every reporter who does not scroll to section 6, on the field that drives
escalation / **S**
`src/app/(app)/incidents/page.tsx:152`, `src/app/(app)/incidents/actions.ts:70`,
`src/modules/incidents/services/report.ts:259-263`

**What is wrong.** Measured on a clean page load: `input[name=immediateRisk][value=no]` is
`checked: true` and `value=yes` is `checked: false`, from a `defaultChecked`. The action reads it
as `immediateRisk: formData.get("immediateRisk") === "yes"`, so a reporter who never reaches
section 6 silently submits "not time-sensitive". That flag is exactly what changes the reviewer
alert: `report.immediateRisk` selects between "was submitted and flagged as an immediate risk"
and plain "was submitted" in both the email and the Teams card. Section 6 sits well down a form
measured at 1682px in an 861px viewport, so it is below the fold on arrival. The result is a form
that quietly downgrades urgent reports to routine ones and tells the reviewer the reporter said
so.

**Fix.** Drop `defaultChecked` from the "No" radio and make the question required, so nothing is
submitted on the reporter's behalf. If ops wants a default, it must be the safe one ("Yes"), not
the quiet one.

---

### Band 2: tier 1, costs-time

They get there, slower or by a route they had to invent, and the population is everyone. This is
the largest band by a wide margin, which is the shape of an app that works and does not explain
itself.

#### R11. New: There is no transient notification system anywhere in the app

`flow` / tier 1 / every user, every action that produces feedback / **M**
Design: `docs/superpowers/specs/2026-07-28-ux-audit-flow-friction-design.md`, "Toast notification
system"

**What is wrong.** Action feedback is a server-rendered inline `<Alert>` driven by redirect
search params. Re-counted 2026-07-29: **121 `?error=` sites, 37 `?saved=` sites**, plus
`?windowsaved=` and `?status=` one-offs, with `Alert` imported by **73 files**. A `grep -ril
toast src` returns **zero matches**: no toast component exists anywhere in the codebase. The only
floating notification in the entire app is the inactivity warning. The consequence is that every
confirmation costs a full round trip and a param in the URL, that a refresh re-fires the same
banner, and that any client-only action (a copy, a local toggle, a validation that never reaches
the server) has nowhere to report success or failure at all.

**Fix.** Two sources feed one `<ToastViewport>`, mounted once **outside** the glass containers.
That placement is required, not stylistic: `.glass-bar`'s `backdrop-filter` creates a containing
block that breaks `fixed` children, which is why `HelpLauncher` is already mounted outside the
toolbar. (1) *Flash params:* a client component reads `saved` / `error` from the URL, pops a
toast, then strips the param with `router.replace` so a refresh does not re-fire it. The 158
existing redirect sites are not touched and the server-action contract stays as it is. (2)
*Client callers:* a `useToast()` hook for actions that never round-trip the server.

**Successes auto-dismiss, errors do not.** Auto-dismissing an error is a usability failure: the
user may not have been looking, and an error usually requires action. Success and info
auto-dismiss at roughly four seconds; error and warning persist until dismissed and carry a close
button. All are click-dismissible.

**Inline alerts do not all go away.** Form validation bound to a specific field stays inline.
"Enter a valid email address" belongs next to the input, not floating at the bottom of the
screen. The migration rule is: page-level flash confirmations become toasts, form-bound
validation stays put. Without that rule, a mass migration makes error UX worse.

**Visual.** Solid brand-dark pill in both themes, tone carried by the leading icon rather than a
filled background, which is already the stated principle in `src/platform/ui/alert.tsx`.
Bottom-center placement. Polite live region for success and info, assertive for errors, mirroring
current `Alert` semantics. `prefers-reduced-motion` respected. Three visible at once, the rest
queued.

**Staging.** This item is the system plus the highest-traffic flash sites. Converting the
remaining 30 to 40 pages is **B6**. Do not leave a page rendering both a toast and its inline
`Alert` from the same param, or every action double-reports.

#### R12. New: The help launcher and the inactivity warning occupy the same corner

`visual` / tier 1 / every user whose session goes idle while the help launcher is on screen /
**S**
`src/platform/ui/help/help-launcher.tsx:106`, `src/platform/auth/inactivity.tsx:62`

**What is wrong.** Re-verified 2026-07-29: `HelpLauncher` renders at `fixed bottom-6 right-6
z-50` and the inactivity warning at `fixed bottom-4 right-4 z-50`. They occupy overlapping space
at the same stacking level whenever both are visible, and the thing that loses is the session
warning, which is a `role="alert"` telling the user they are about to be signed out.

**Fix.** Move one of them, and pick the target deliberately rather than nudging an offset: this
collision is part of why the toast viewport in R11 goes bottom-center. Give the inactivity
warning and the toast viewport one shared bottom-center lane, and leave the help launcher alone
in the bottom-right corner it already owns. Ship with R11.

#### R13. F-05-4: The progress counter can never fill and "Not yet cleared" never clears

`ia` / tier 1 / every volunteer, permanently, from first login onward / **M**
`src/modules/onboarding/services/step-config.ts:73-78`,
`src/modules/onboarding/services/onboarding.ts:132-133`, `src/app/(app)/page.tsx:272,488`

**What is wrong.** EHS is the only non-blocking onboarding step, but it is counted and styled
exactly like the four blocking ones. The gate opened at "Your progress 0 of 5" under the sentence
"You cannot be scheduled until each one is done", and EHS carried the same amber "Action needed"
badge as the steps that actually block. `completedCount`/`totalCount` come from `summarize()`
over all tasks while `onboarded` comes from `computeGating()` over blocking tasks only, so the
gate releases at 4 of 5 and the progress bar can never fill. The same split then follows the
volunteer forever: a cleared volunteer with a shift in four days shows an amber "Not yet cleared"
pill on the dashboard and, on `/my-info`, "A few steps left for Summer 2026 / Finish the
unchecked items below to be fully cleared" with no CTA at all (`finishHref` is null), the single
unchecked item being EHS, which the checklist itself says "are recorded by your coordinator". The
instruction cannot be followed inside the app.

**Fix.** Two parts. *Gate:* pass blocking-only counts to the progress display so "of N" matches
the release condition, and give non-blocking steps a distinct pill (an `optional` branch on
`StatusPill` rendering a default-tone "Optional" badge instead of the warning-tone "Action
needed"). *Clearance:* drive the dashboard and `/my-info` pill off `onboarded` rather than
`cleared`, and render EHS as a separate advisory line below the checklist ("EHS training is
recorded by your coordinator after you complete it in Workday") rather than as an unchecked
requirement.

#### R14. F-07-1: Past and future shifts render identically and nothing marks the next one

`visual` / tier 1 / every scheduled volunteer, every visit, worsening through the term / **M**
`src/app/(app)/schedule/page.tsx:278-285`, `:200-204`, `:490-493`,
`src/modules/schedule/services/schedule.ts:124`, `src/app/(app)/page.tsx:224-226`

**What is wrong.** Measured at 1200x805: all nine shift cards carry the identical class string,
identical background `rgb(255,255,255)`, identical border `rgb(226,232,240)`, identical color, and
`opacity: 1`. Four of them had already happened. The next real shift was the fifth card at y=787
in an 805px viewport, sitting on the fold line under four dead ones. The list is a flat
`t.shifts.map` with one card shape over a service that sorts ascending and never filters. The
counts reinforce it: the hero says "9 shifts this term" and the sidebar "Total shifts 9", while
the dashboard for the same person says "5 upcoming". The one screen a volunteer opens to answer
"when am I next on" makes them read four obsolete dates first and do the arithmetic themselves.

**Fix.** Partition the list. The dashboard already computes the exact predicate needed
(`shifts.filter((s) => isoDateKey(s.clinicDate) >= todayKey)`). Reuse it in `MySchedulePage`,
render an "Upcoming" group and a collapsed "Past shifts (4)" `<details>` group below it, give the
first upcoming card a `Next` badge plus the dashboard's existing `daysBetweenKeys` line ("4 days
away"), and mute past cards. Change the hero and sidebar counts to read upcoming ("5 shifts left
this term, 9 total") so the three surfaces agree.

#### R15. F-04-4: Resuming a draft reopens at step 1 of 12 with every step marked incomplete

`flow` / tier 1 / every applicant who does not finish in one sitting / **M**
`wizard-progress.tsx`

**What is wrong.** "Continue your application" reopens the wizard at **Step 1 of 12** with every
rail step showing as incomplete, even though all ten saved answers are present and prefilled.
Nothing says how far they got or what remains, so they press Continue through four
already-complete steps to reach the first blank field. The same rail reports position rather than
completion in the other direction too: using Edit on the review step to change an answer at step
9 dropped the checkmarks from steps 10 through 13, all of which were fully answered.

**Fix.** Two parts. (a) Open at the first step containing an unanswered required field (reuse
`missingRequiredKeys` over the loaded draft) instead of index 0. (b) In `wizard-progress.tsx`,
derive a step's complete state from its required fields being answered, not from
`index < stepIndex`.

#### R16. F-04-8: "This field is required." stays under a field after it is filled in

`flow` / tier 1 / every applicant who submits a step with a blank required field / **S**
`apply-wizard.tsx` (`handleNext`, `handleValueChange`)

**What is wrong.** "This field is required." stays under a field after the applicant types a valid
value. Filling First name, Last name, Yale NetID and Yale email left all four still marked invalid
with red error text; the errors only cleared on the next Continue press. `fieldErrors` is written
in `handleNext` and cleared only in `handleNext`, never on input.

**Fix.** Clear `fieldErrors[key]` from the field's change handler (`handleValueChange` and the
uncontrolled inputs' `onChange`) once the value is non-empty.

#### R17. F-05-5: The onboarding gate never says it locks the whole app

`flow` / tier 1 / every new volunteer, once per semester / **S**
`src/app/get-started/page.tsx:39-42`, `:15`

**What is wrong.** The gate explains itself only as "Complete these steps to be ready for shifts.
You cannot be scheduled until each one is done." What it actually does is lock the entire
application: both `/` and `/my-info` redirected straight back to `/get-started`, and the page
renders no navigation, no search, and no account menu, so the only controls on screen are the five
step buttons and "Sign out". Nothing states that HAVEN Hub itself is behind this, nothing
estimates how long any step takes, and nothing says where the volunteer lands when they finish;
the exit is a bare `redirect("/")` with no parameter, so no acknowledgment of finishing is even
possible. A first-time volunteer cannot tell whether this is a five-minute form or an afternoon.

**Fix.** Rewrite the paragraph to name the real consequence and the finish line: "HAVEN Hub
unlocks once these are done. You cannot be scheduled for a shift until then, and you can finish
them in any order." Add a per-step time estimate to the checklist rows (a `minutes` field on
`StepDefault`, rendered as "about 5 min"). Change the exit to `redirect("/?onboarded=1")` and
render a one-time "You're all set, welcome to HAVEN Hub" banner on the dashboard for that
parameter.

#### R18. F-05-2: The verification wait explains nothing, unless the PDF parser failed

`flow` / tier 1 / every volunteer whose certificate PDF parses, which is the normal case / **S**
`src/modules/my-info/components/hipaa-panel.tsx:106-110`

**What is wrong.** In the pending state the certificate block is: "Uploaded Jul 28, 2026 [View]",
an amber badge reading "Awaiting verification", and "Detected completion date: Jun 29, 2026".
That is the entire message. No sentence saying who verifies, how long it takes, whether they will
be told, or what to do if nothing happens. The reassuring sentence that does exist ("A compliance
manager will verify the completion date. No action is needed from you.") is gated on
`latest.completionDate === null`, so it renders only when the PDF parse **failed**. The case where
everything worked gets a two-word badge; the case where the parser broke gets the explanation.
Meanwhile the page heading still reads "Upload your current HIPAA certificate" and the only button
is "Upload certificate", so the implied next action is to upload again.

**Fix.** Change the condition to `status === "UNKNOWN_DATE" || status === "PENDING_VERIFICATION"`
and branch the copy: PENDING_VERIFICATION reads "We have your certificate and read a completion
date of {date}. A compliance manager confirms it before you are cleared, usually within a few
days. We will let you know; you do not need to upload it again." Add "If it has been longer than a
week, contact {supportEmail}" using the existing `SupportLink`. Hide the "Upload New Certificate"
section behind a "Replace this certificate" disclosure while a certificate is awaiting review, so
re-uploading stops being the visually obvious next step. Ship with R1 and R19.

#### R19. F-05-3: Verifying a certificate never tells the member it happened

`flow` / tier 1 / every volunteer whose certificate needs manual verification / **S**
`src/modules/volunteers/services/compliance.ts:488-537`,
`src/modules/my-info/services/my-info.ts:341-368`

**What is wrong.** `verifyCertificate` stamps `verifiedAt`, writes an audit row, and fires a
PostHog event. It queues no email and creates no `Notification` for the certificate owner. The
upload side is fully wired in the other direction: `saveCertificate` calls
`notifyCertNeedsVerification` under a comment reading "date but unverified -> a manager must
verify it (blocks the member until then)". The code knows this state blocks the member, notifies
the manager, and never closes the loop back. Combined with the gate, a volunteer whose only
outstanding blocking item is verification is locked out of every page in the app by an event they
are never told about, so the only way to learn they are cleared is to keep signing in and
checking.

**Fix.** In `verifyCertificate`, inside the existing `if (!cert.verifiedAt)` transition block,
call `notify()` for `cert.personId` with a "Your HIPAA certificate is verified" message and a link
to `/my-info`. The notify dispatcher already handles channel selection and email fallback, so this
is one call plus a notification-type registration. Ship with R1 and R18.

#### R20. F-06-2: "Try again" discards every answer, including the correct ones

`flow` / tier 1 / every volunteer who fails the makeup quiz, on every retry / **S**
`src/app/(app)/training/training-quiz.tsx:89-93`

**What is wrong.** After failing, the page reported 15 of 15 answered; one click on "Try again"
left `document.querySelectorAll('input:checked').length === 0` and the counter back at "0 of 15
answered", because `tryAgain` calls `setAnswers({})`. The realistic failure is a near miss (12 of
15 is the 80% bar), so a volunteer who got 11 right must re-answer all 15 rather than fix the 4
they missed. The same click also leaves the window at scroll offset 4,446 of a 5,332px page with
focus on `<body>`, parking them at the bottom of a now-blank quiz with Question 1 four thousand
pixels above them.

**Fix.** In `tryAgain`, stop clearing `answers`; clear only `graded` and `error`. Better, clear
only the wrong ones so the retry starts pre-filled with the correct answers and the missed
questions empty. Take that list from R5's new `wrongKeys` payload, not from `graded.correctByKey`,
which R5 removes; the two must land together or this one re-introduces the answer leak. Then
scroll to and focus the first now-unanswered fieldset.

#### R21. F-06-3: A disabled Submit will not say which question is unanswered

`flow` / tier 1 / every volunteer who misses one question on a 15-question page, which the
5,332px page height makes likely / **S**
`src/app/(app)/training/training-quiz.tsx:215-223`, `:161-163`

**What is wrong.** With 14 of 15 answered the Submit button is disabled and the only feedback is
the footer line "Answer all 15 questions to submit." Nothing names the missing question, nothing
marks it, and there is no jump affordance. The live counter that would at least say "14 of 15"
sits in the quiz card header, which is not sticky and was 4,500px above the button. The
volunteer's only recovery is to scroll back through fifteen question blocks hunting for the one
with no filled radio.

**Fix.** Change the footer text to name the gap and make it actionable: render "{n} question{s}
left" and wrap it in a button that scrolls the first unanswered `<fieldset>` into view and focuses
its first radio. On a blocked submit attempt, add a visible "Not answered" chip to unanswered
fieldset legends. Optionally make the card header row `sticky top-14` so the counter stays on
screen.

#### R22. F-04-9: The stated four-shift minimum is not enforced anywhere

`flow` / tier 1 / every applicant / **M**
`schema-builder.ts`, the default application template's availability field

**What is wrong.** The help text states "To be eligible you must commit to a minimum of four
shifts", but selecting a single date passed validation, passed review, and submitted. The review
step displayed the one date with no warning. Applicants can submit an application that is
ineligible by the form's own stated rule and only learn at rejection. There is also no running
count and no select-all across the 18 checkboxes.

**Severity note.** Filed `costs-time`; there is a fair case for `blocks` on the grounds that the
applicant is left wrong about whether they submitted a valid application.

**Fix.** `schema-builder.ts` honours `v.max` for MULTI_SELECT but never `v.min`; add
`if (v.min !== undefined) arr = arr.min(v.min)`, set `validation.min: 4` on the availability field
in the default template, mirror the rule in the client's `missingRequiredKeys`, and show a live "2
of 4 minimum selected" count above the list.

#### R23. F-04-12: File fields accept anything and state no size or type limit

`flow` / tier 1 / every applicant / **S**
`field-preview.tsx:93`, `:109`, `field-groups.ts:102-104`, `upload.ts:22-38`

**What is wrong.** Both required file fields render with an empty `accept` attribute and no
statement of size limit or accepted types anywhere on the page. This is not missing plumbing:
`field-preview.tsx` already reads `validation.acceptedTypes` into the input's `accept`, but
`acceptedTypes` is never set on `cover_letter` or `resume` in the default template, so the
attribute renders empty. The same unset field also short-circuits the **server-side** type check
(`upload.ts` only runs the allow-list check when `accepted.length > 0`), so a `.txt` file was
accepted as the "cover letter" whose own help text asks for a PDF, reported as "Attached:
ux-audit-tmp-bad.txt" with no warning from either the client or the server. Once a file is
attached there is no control to remove it, only to replace it.

**Fix.** Set `validation.acceptedTypes` on `cover_letter` and `resume` in the default template;
the client `accept` attribute and the server-side allow-list check both already key off that
field, so one template change closes both gaps. Render the effective rules under each label ("PDF
or Word, up to N MB") from `maxFileMB`/`acceptedTypes`, and add a "Remove" control beside the
"Attached: {name}" line.

#### R24. F-04-13: Non-Yale applicants must still fill required Yale NetID and Yale email fields

`ia` / tier 1 / non-Yale applicants; every applicant reading the blurb / **M**
Personal details step of the default application template

**What is wrong.** The section blurb reads "If you are a returning volunteer, your record is
pulled automatically and you can skip this section", but every field below carries a required
marker, no skip exists, and the blurb is shown identically to someone who answered "New applicant"
on step 1. Separately, "Yale NetID" and "Yale email" remain required after choosing the
affiliation "I am NOT a Yale Affiliate", which is precisely the audience the portal's own "Not
affiliated with Yale? Get a one-time link by email" path invites; the walk completed only by
typing a non-Yale address into the field labelled "Yale email".

**Fix.** Gate the blurb on `applicantType === "RENEWAL"`. Add `visibleWhen` on `net_id` and the
Yale email field keyed to `yale_affiliation != "not_yale"`, and show a plain "Email" field for the
non-Yale branch.

#### R25. F-04-14: Choosing a department silently adds a required step six steps later

`flow` / tier 1 / every applicant who picks a department with a supplement / **M**
Department supplement section ordering; `WordCountTextarea` / `validation.wordLimit`

**What is wrong.** Choosing a department at step 6 silently changed the total from "Step 6 of 12"
to "Step 6 of 13" and appended a required 100-word essay as step 12, six steps after the choice
that caused it and immediately before Review. Nothing announces the change. The step's blurb says
"Please limit each response to 250 words or less" while the question itself says "approximately
100 words", and no word counter renders even though `WordCountTextarea` already supports one via
`validation.wordLimit`.

**Fix.** Order department supplement sections immediately after the department-choice step;
announce the change inline ("Choosing MDIC adds 1 step"); set `validation.wordLimit` on the
supplement questions so the existing counter appears; delete the contradictory section blurb.

#### R26. F-04-10: Failed contract validation leaves you scrolled past the error with nothing focused

`flow` / tier 1 / every accepted volunteer who misses a field / **M**
Onboarding contract submit path

**What is wrong.** Submitting with all five signature pads empty left the viewport exactly where
it was (scrollY 3874 of a 4719px document) while the first error sat at y=2594, off screen above,
with nothing focused. Each pad's entire error message is the bare lowercase word "required".
Non-signature fields fall back to native browser bubbles, which report one field at a time and, in
the case observed, covered the label of the next field down.

**Fix.** On failed validation, scroll to and focus the first invalid control, render an error
summary above the Submit button listing each missing item as an in-page link, and replace
"required" with a specific instruction ("Sign or type your initials to continue").

#### R27. F-04-16: The attendance policy is one unbroken paragraph stuffed into a help text

`visual` / tier 1 / every applicant / **M**
Volunteer contract step of the default application template; compare `contract/defaults`

**What is wrong.** The attendance and professionalism policy is delivered as one unbroken ~250-word
paragraph with its three sub-headings ("Attendance Policy (Strike Policy)", "Professionalism",
"Commitment to the Entirety of the Semester") absorbed inline into the prose, because the whole
policy is stuffed into a `SHORT_TEXT` field's `helpText`. The identical policy renders with proper
headings and separate paragraphs on the onboarding contract, so the applicant sees the readable
version only after they have already agreed to the unreadable one. The three agreement inputs are
unhinted full-width text boxes with no placeholder, under body text ending "Please initial below".

**Fix.** Split the three policies into separate agreement blocks with structured content,
mirroring `contract/defaults`, or switch these fields to the existing `SIGNATURE` type and move
the body out of `helpText`. Add a placeholder ("Type your initials"). As a side effect this
resolves the ~250-word accessible names those three inputs currently carry.

#### R28. F-04-5: The submit confirmation has no links and no decision timeline

`flow` / tier 1 / every applicant, once per cycle / **S**
Post-submit terminal screens on `/apply/[slug]`

**What is wrong.** The post-submit screen is a heading, one sentence ("Thanks, your application
was received. Check your email for a confirmation."), and no links or buttons at all; the only exit
is the unlabelled header logo. It gives no decision timeline and no route to the status tracker the
review step had promised one click earlier ("you can track your application here in the portal").
Returning to the cycle later lands on an equally terminal "Application submitted / You have already
submitted this application" page.

**Fix.** Add a primary "Track your application" link to `/apply` on both terminal states, plus a
line stating when decisions go out (from the cycle, or a configurable copy string).

#### R29. F-04-6: The portal lists the same cycle twice with contradictory calls to action

`ia` / tier 1 / every applicant with a draft or a submitted application / **S**
`/apply/page.tsx`

**What is wrong.** The same cycle is listed twice with contradictory calls to action: once under
"Your applications" as "Continue your application / Continue", and again under "Open applications"
as "Start application". Both link to the identical URL. An applicant with unsaved-looking work
reasonably reads "Start application" as "start over". After submission the "Start application" row
is still offered and leads to the dead-end already-submitted page.

**Fix.** Filter `openCycles` to exclude slugs already present in `myApps` before rendering the
"Open applications" list.

#### R30. F-04-7: A cycle deep link, signed out, names no cycle, no date, and no role

`ia` / tier 1 / every applicant, at the top of the funnel / **S**
`/apply` sign-in card

**What is wrong.** `/apply/{slug}` signed out redirects to `/apply?next=...` and shows a generic
"Apply to HAVEN Free Clinic" sign-in card that names no cycle, no closing date, no role
description, and no time estimate. Someone following a poster or QR link for a specific cycle must
verify an email address before learning anything about what they are applying to or whether it is
even open.

**Fix.** When `next` resolves to a cycle slug, or exactly one cycle is open, render that cycle's
title, its `closesAt`, and a one-line expectation ("about 15 minutes; your answers save as you
go") above the sign-in controls.

#### R31. F-04-15: Browser Back shows the portal with no draft (provisional)

`flow` / tier 1 / any applicant who uses browser Back mid-application / **M**
`/apply/page.tsx:22`

**What is wrong.** Pressing browser Back from the wizard returned to `/apply` showing no "Your
applications" section at all, only "Open applications / Start application", despite a DRAFT row
existing with 15 answers. A manual reload of the same URL then showed "Continue your application".
At exactly the moment an applicant fears their work is gone, the app shows them a page that says
it is.

**Provisional, and why.** Re-attributed on review. `/apply/page.tsx:22` already declares
`export const dynamic = "force-dynamic"`, which rules out the server route cache as the mechanism
and makes the original fix's first half a no-op against code already present. `force-dynamic`
makes a stale server render less likely, not more, so the finding is probably real; the more
likely source is the Next 16 client router cache holding a stale snapshot across back/forward
navigation, which was not independently confirmed with a second reproduction. **Reproduce before
fixing.**

**Fix.** Add a `router.refresh()` when the wizard unmounts so the portal home re-fetches on
return, or make wizard steps real routes so Back moves between steps instead of leaving the form
entirely.

#### R32. F-04-17: Signature pads show the empty canvas and the text input at the same time

`visual` / tier 1 / every accepted volunteer / **S**
Onboarding contract signature pads

**What is wrong.** Clicking "Type instead" adds a text input below the drawing canvas but leaves
the empty canvas visible at full size, so the volunteer sees an unfilled signature box directly
above the field they just typed into, with no cue which one counts. The field label reads "initial
below" while the typed input's placeholder reads "Type your full name".

**Coverage note.** Only typed mode was exercised; canvas stroke capture is unverified.

**Fix.** Hide the canvas in typed mode and the text input in draw mode. Make the label and the
placeholder agree on initials versus full name.

#### R33. F-07-2: Shift cards omit the weekday and do not link to who else is working

`ia` / tier 1 / every scheduled volunteer before every shift / **S**
`src/app/(app)/schedule/page.tsx:287`, `:279`, `src/platform/dates/display.tsx:32-35`,
`src/app/(app)/schedule/full/page.tsx:18`

**What is wrong.** A card reads exactly "Jun 6, 2026 / VADM / Volunteer / Triage". The clinic runs
on Saturdays, so volunteers think in weekdays, and the dashboard's next-shift hero already formats
it that way ("Saturday, August 1"); `/schedule` drops the weekday because it renders
`<CalendarDate value={shift.clinicDate} />` with no `opts`. Separately, the date is an inert
`<span>`, so a volunteer asking "who am I with on Aug 1" has to leave for "Full schedule" and hunt
the right pill out of eighteen rather than clicking the date in front of them.

**Fix.** Two changes on one line. Pass the options through
(`opts={{ weekday: "short", month: "short", day: "numeric", year: "numeric" }}`, which
`CalendarDate` already forwards to `formatCalendarDate`), then wrap the date in a `Link` to
`/schedule/full?date={dateKey}`; `dateKey` is already in scope one line above and
`/schedule/full` already accepts that query param.

#### R34. F-07-7: The full schedule does not know who you are

`ia` / tier 1 / every volunteer checking who they are working with, every clinic day / **S**
`src/app/(app)/schedule/full/page.tsx:15`, `:107`, `:126`, `:149`

**What is wrong.** `FullSchedulePage` calls `await requireModuleAccess("schedule")` and discards
the returned session, so no person id ever reaches the render. Every volunteer is an identical
`<span className="text-sm text-foreground-soft">{v.name}</span>`, and directors and shadows
likewise. Walked on the persona's own next shift: their name sits between two others with no
marker of any kind, and the page offers no search box, no filter, and no "my department" anchor
(measured: `document.querySelectorAll('input').length === 0`). On the fixture's single department
that costs a moment; against the shipped catalog of 36 departments it means scanning several
screens of names for your own.

**Fix.** Keep the session (`const session = await requireModuleAccess("schedule");`), then in each
of the three person lists compare `p.id === session.personId` and render the matching row with a
"You" badge plus emphasis and a row tint. While the id is in hand, sort the department cards so
the ones the viewer is scheduled in come first, and add `id={department.code}` to each `<section>`
so R38's jump nav has targets.

#### R35. F-07-8: The clinic date strip gives no anchor for today

`visual` / tier 1 / every volunteer browsing more than the default date / **S**
`src/app/(app)/schedule/full/page.tsx:60-64`, `:66`,
`src/modules/schedule/engine/display.ts:32-35`

**What is wrong.** Measured: 18 pills wrapping to 2 rows and 96px of vertical space at 1200px.
Exactly one pill is styled differently, the *selected* one (brand fill `rgb(0,53,107)` versus
`rgb(248,250,252)` for the other seventeen), and selection is also the only thing that moves when
you click. On arrival the brand pill happens to sit on the next clinic date, but the instant a
volunteer clicks a past week to check it, every trace of where today falls is gone: nine past pills
and nine future pills, all identical. The labels come from `displayDate(key)`, which by
construction emits only "June 13th" with no weekday and no year, so there is nothing in the text to
orient on either.

**Fix.** Style the strip on three states rather than one. Compute `todayKey` the way `fullSchedule`
already does, then render pills before it in the muted palette, give the first pill at or after it
a persistent `ring-2 ring-brand` plus a visible "(next)" suffix so it stays identifiable even when
a different pill is selected, and keep the solid brand fill for the selected pill. Add a thin
vertical rule between the last past and first future pill.

#### R36. F-07-10: A pending request shows no date, no owner, and no expected wait

`ia` / tier 1 / every volunteer with a request in flight, for as long as it is in flight / **S**
`src/app/(app)/schedule/page.tsx:299-310`

**What is wrong.** Walked immediately after submitting: the card read exactly "Change requested:
drop (pending director review)" with a "Cancel request" button, and the banner said "Your director
will review it." No submitted date is rendered even though `pendingReq.createdAt` is already in
scope and used two lines later; no approver is named even though `createRequest` resolved the exact
list via `requestApproverRecipients(departmentId, term.id)` when it emailed them; and the one
escalation affordance, "Remind directors", is hidden behind a five-day threshold with nothing on
screen saying that threshold exists. For the first five days the volunteer sees a static line with
no timestamp and no named owner, cannot tell whether waiting is normal, and has no idea an
escalation is coming.

**Fix.** Render the facts already in hand. Add "Requested {date}" to the pending line, thread the
approver names into `MyTermSchedule.pendingRequests` from the same `requestApproverRecipients` call
`createRequest` already makes, and render "With {names} for review". Replace the hidden-until-day-5
button with a control that is always present and disabled before the threshold, labelled "You can
remind your directors in {n} days".

#### R37. F-07-6: The swap button fires on one click, the drop button needs two

`flow` / tier 1 / every volunteer submitting a swap, first attempt / **S**
`src/app/(app)/schedule/page.tsx:341`, `:362`

**What is wrong.** The two request forms have inverted safety. "Request drop", which affects only
the person clicking it, is a `ConfirmButton` requiring two deliberate clicks within 3s. "Request
swap", which reassigns a second volunteer's Saturday and immediately emails that person, both
department approvers and the requester, is a plain one-click submit button. A single programmatic
click submitted with no interstitial. `createRequest` sends `schedule-swap-submitted-partner` to
the named partner as part of the same call, so a mis-click on a `<select>` sitting immediately
left of the button puts a wrong name in a colleague's inbox. Cancelling afterwards removes the
pending row but sends no retraction.

**Fix.** Swap the swap button for the `ConfirmButton` already imported and used one form above,
with a label that names the consequence. It is a submit control inside the same kind of form, so
it needs no other change. If the inconsistency is meant to be the other way round, drop the
confirm from the drop form instead; what should not survive is the lighter gate sitting on the
heavier action. See also R65, the same inversion on the director side.

#### R38. F-07-9: The department grid has no search, filter, or jump navigation

`visual` / tier 1 / every volunteer on a real clinic date, every time / **M**
`src/app/(app)/schedule/full/page.tsx:79`, `prisma/department-catalog.ts`

**What is wrong.** Measured against the live DOM: the single real department card, with only four
people in it, is 229px tall; the grid resolves to two columns at a 1200px viewport, so the third
column only appears at 1280px and up. Cloning that minimal card to 30 and re-reading
`document.documentElement.scrollHeight` gives 4,263px, or 5.3 viewport heights, against 840px for
the one-department fixture. That is a floor: the shipped catalog holds 36 departments and real
cards carry more than four names. Across those five-plus screens there is no search, no filter, no
sticky header, no department jump list, and no collapse control, and department order is whatever
the service returns.

**Fix.** Add a sticky control row directly under the date strip: a client-side text filter that
hides non-matching sections by department code and name, plus a wrapping row of department-code
chips that anchor-jump to the `id={department.code}` sections R34 adds. Order the grid with the
viewer's own departments first, and render departments with nobody scheduled as a single collapsed
row rather than a full card. Ship after R34, which supplies the session and the anchor ids.

#### R39. F-05-6: The gate's only help is a sentence that is not a link

`ia` / tier 1 / every new volunteer who gets stuck, which includes everyone waiting on
verification / **S**
`src/app/get-started/page.tsx:64-66`, `src/platform/branding/support.ts`

**What is wrong.** The only help on the gate is the plain sentence "Need help? Contact your
recruitment director." It is not a link, it names no person, and it gives no email. This sits on
the one screen in the app with no navigation, no search, and no account menu, so a volunteer who
is stuck (for example anyone in the R1/R18 verification wait) has no actionable route to a human.
The signed-out `/login` page one step earlier does better: it renders "Contact the HAVEN Free
Clinic IT team" as a real `mailto:` link.

**Fix.** Replace the sentence with the existing `SupportLink` primitive and `getSupportContact()`,
already used elsewhere for the configurable `branding.supportEmail`, so it renders a real mailto.
Where the volunteer has an ACTIVE `TermMembership`, prefer that department's recruitment-director
contact and name them.

#### R40. F-05-7: Certificate rejections show raw developer error strings

`flow` / tier 1 / every volunteer who uploads anything but a PDF, or a large scan / **S**
`src/modules/my-info/services/my-info.ts:250-254`,
`src/modules/my-info/components/hipaa-panel.tsx:141`

**What is wrong.** Uploading a `.png` produced the banner `Invalid mime type "image/png"; only
application/pdf is accepted`. That is the raw `CertificateValidationError` message written for
developers, passed through `?certError=` and rendered verbatim. The sibling messages come from the
same templates: `File extension must be .pdf; got "{name}"` and `File too large: {n} bytes exceeds
the {maxMb} MB limit`, the last of which reports raw bytes. None says how to fix the problem, and
the file selection is cleared so the volunteer has to re-pick. The size limit is never stated up
front either: the field's only hint is "PDF only.", so the first time anyone learns there is a cap
is when a phone photo of a certificate is rejected in bytes.

**Fix.** Give `CertificateValidationError` a `kind` field (`"type" | "extension" | "size"`) and map
it to member-facing copy at the two redirect sites: type and extension become "That file is not a
PDF. Download the certificate from Workday as a PDF and upload that, or use your device's Print to
PDF option."; size becomes "That file is larger than the {maxMb} MB limit. Try downloading the
certificate again from Workday rather than scanning a printout." Change the field hint to "PDF
only, up to {maxMb} MB" by threading `uploads.maxMb` into `HipaaPanel`.

#### R41. F-05-8: The profile step never says which field is actually missing

`ia` / tier 1 / every new volunteer, once per semester / **S**
`src/modules/onboarding/services/step-config.ts:33`, `src/app/get-started/profile/page.tsx:48`

**What is wrong.** The first blocking step opens with four read-only fields (Name, NetID, Epic ID,
Date of Birth) occupying the top half of the card, two of which read "Not set" and carry the
instructions "Contact the IT team to update your Epic ID" and "Set during onboarding; contact the
IT team to correct it". Only below that do the editable fields appear, and only one of them was
actually blocking: Phone. Nothing on the page says which field is missing, so the volunteer scans a
form of nine fields for the one empty required box, past two "Not set" values that read as further
problems and invite an unnecessary email to IT. The step is also titled "Profile & agreements" but
renders only `MyInfoForm`; there are no agreements anywhere on it.

**Fix.** Render a one-line summary above the form derived from the same predicate the engine uses
(`deriveProfileTaskState`: contactEmail and phone): "One thing left: add a phone number so we can
reach you about shifts." Move the read-only identity block below the editable fields, and drop the
"Not set" plus contact-IT text for Epic ID and Date of Birth on the onboarding variant, where
neither is required to pass. Rename the step to "Your contact details", or add the agreements the
title promises.

#### R42. F-05-9: The action feed has no heading and repeats the navigation

`ia` / tier 1 / every volunteer, every visit to the dashboard / **M**
`src/app/(app)/page.tsx:425-451`, `src/app/(app)/action-cards.ts:21-34`

**What is wrong.** The ranked action feed renders as three unlabelled tiles between the shift hero
and the "Modules" heading, with no heading of its own. The grid below it, which does have an `h2`,
repeats the same destinations, and the top nav repeats them again: Schedule appears three times on
one screen, My Info twice, Learning twice, Support twice. Nothing distinguishes "what to do next"
from "everywhere you can go", which is the question a first-time user is asking. Meanwhile the one
panel that flags a problem, the "Your status" rail showing amber "Not yet cleared", has no
corresponding action card, because `ActionCardInput` has no EHS input at all and cannot produce
one.

**Coverage note.** Measured against a populated dashboard. The true first-visit empty state was not
reachable with any persona.

**Fix.** Give the feed a heading that names it ("Do next") so it reads as ranked rather than as a
second shortcut row, and drop from the Modules grid any module already present in the top nav for
that viewer. Separately, thread the EHS task state into `ActionCardInput` so the feed can surface
the item the status rail is already flagging, or, if EHS stays coordinator-recorded per R13, stop
flagging it in the rail so the two panels agree.

#### R43. F-06-9: Training reads as actionable before the makeup window opens

`flow` / tier 1 / every gated volunteer between joining and the term's in-person training date /
**M**
`src/modules/onboarding/engine/status.ts:26-29`,
`src/modules/onboarding/services/onboarding.ts:105-113`,
`src/app/get-started/training/page.tsx:40-45`

**What is wrong.** The checklist presents training as actionable before the makeup window opens.
The row renders "Volunteer training / Action needed / Finish this term's training to be cleared for
shifts" with a "Go to training" button. `deriveTrainingTaskState` derives that state from
`TrainingState` and `attemptsUsed` only, with no access to `makeupOpen` or `inPersonTrainingDate`,
so it renders identically whether the makeup is available or not. Before the in-person date, the
CTA leads to a page whose only content is a notice explaining the live session and when the makeup
opens. That destination copy is good; the problem is that the volunteer had to click into a dead
end to read it, and the checklist counts a step nobody can act on yet among four amber "Action
needed" chips.

**Coverage note.** The checklist half was walked; the pre-window destination was read from source,
because the fixture cycle's in-person date is already past.

**Fix.** Thread `makeupOpen` and `inPersonTrainingDate` from `getMyTrainingForTerm` into the
training task entry in `computeOnboardingForTerm`, and give the row a distinct waiting presentation
when the makeup is not yet open: a neutral "Scheduled" badge, the description "In-person session on
{date}. Your director marks you complete when you attend.", and either no CTA or one labelled "See
details". Keep it counted as incomplete so the gate is unchanged.

#### R44. F-06-6: Nothing tells a learner what a course expects or that progress saves

`ia` / tier 1 / every volunteer opening an assigned course for the first time / **M**
`src/app/get-started/learning/page.tsx:32-42`,
`src/app/(app)/learning/[courseId]/ScormPlayer.tsx:169-174`

**What is wrong.** The list card carries a title, the admin's free-text description, and a status
badge, and that is all. Opening the course adds a numbered table of contents; there is no module
count, no time estimate, and no course-level progress line such as "1 of 2 complete". Nowhere does
anything say progress is saved: the only save-related copy in the player is the failure alert "Your
progress could not be saved". Progress *is* saved (confirmed by completing a module, leaving via
the header, and returning to find the badge moved from "Not started" to "In progress"), but the
learner has no way to know that before they leave, so the safe assumption is to sit through the
whole thing in one sitting.

**Fix.** On the list card, render "N modules, M complete" beside the badge from the `ScoProgress`
rows already loaded for the player. In the player, add a header line "Module {i+1} of {n}" and a
persistent muted line "Your progress saves automatically, you can leave and come back." Add a
nullable `Course.estimatedMinutes`, expose it in the `/learning/manage` course form, and render
"About {n} min" on the list card so the estimate is authored rather than guessed.

#### R45. F-06-4: Shift preferences sit below the Submit button and default to a fabricated 4

`flow` / tier 1 / every volunteer, every term, plus every director reading shift preferences in the
builder / **M**
`src/app/(app)/training/training-quiz.tsx:237-277`, `:211-233`, `:249`,
`src/modules/recruitment/services/training.ts:318-322`,
`src/app/(app)/schedule/builder/page.tsx:1022-1033`

**What is wrong.** The shift-preference form ("Minimum shifts wanted this term", availability,
feedback) renders *below* the quiz's primary Submit button on a 5,332px page, and it is saved only
as a side effect of submitting the quiz. Three consequences, all walked. (a) A volunteer who
submits at the button never scrolls past it and never sees the form. (b) `minShiftsWanted` has
`defaultValue={intake.minShiftsWanted ?? "4"}`, so "4" is persisted as a stated preference even
when untouched, and the builder then renders it to schedulers as "Wants 4+ shifts this term". (c)
After passing, the training route redirects away and the quiz is replaced by the "Cleared for the
term" hero, so the form is unreachable forever; a grep confirms `minShiftsWanted` has no other
write site. The page's own copy says "Most people attend the live session", meaning most volunteers
never see this form at all.

**Fix.** Move the intake card above the quiz card so it is passed on the way to the submit button,
and drop the `?? "4"` default in favour of an unselected placeholder option so an unstated
preference stays null instead of becoming a fabricated "4". Separately, add a "Shift preferences"
panel to `/my-info` writing the same three `Training` columns for the live term, so the preference
is editable after clearance and reachable by volunteers who cleared via live attendance.

#### R46. F-06-5: "Back to courses" lands on the checklist

`flow` / tier 1 / every gated volunteer leaving a course, every time / **S**
`src/app/(app)/learning/[courseId]/ScormPlayer.tsx:105-112`, `:120-138`,
`src/app/(app)/learning/actions.ts:6-9`, `src/platform/auth/onboarding-allowlist.ts:10-13`

**What is wrong.** The header link labelled "Back to courses" (`href="/get-started/learning"`)
lands on `/get-started`, the checklist, one level past the course list. Reproduced 4 of 4 times.
Network evidence: the RSC GET for `/get-started/learning` returns 200, then a server-action POST
fired by the player's unmount cleanup (`persistCmiAction`) responds with
`x-action-redirect: /get-started;push`, and the router follows it. Navigating to
`/get-started/learning` any other way, including the checklist's own "Open courses" link, works, so
the redirect is specific to a persist action racing the departure. The learner ends up one screen
further from where the label promised, with a moment of "did that save?" attached.

**Fix.** Flush on unmount through the beacon endpoint the component already uses for `pagehide`
(`POST /api/learning/persist-cmi`) rather than through `persistCmiAction`. That route authenticates
with `auth()` directly and never runs `requirePersonSession`, which the onboarding allowlist
documents as deliberate, so it cannot emit a redirect that overrides the navigation. Keep
`persistCmiAction` for in-session commit and finish saves, which are not racing a route change.

#### R47. F-06-7: A completed course shows no completion date and no term

`ia` / tier 1 / every returning volunteer, every term after their first / **S**
`prisma/schema.prisma:1637`, `src/modules/learning/services/enrollment.ts:113-129`, `:333-340`

**What is wrong.** A finished course shows a green "Complete" badge and nothing else. The card
reads "UX Audit Course / Complete" with no date, and the player adds only "You have completed this
course." The data exists and is not being read: `CourseProgress.completedAt` is a real column
stamped once on rollup, but `getMyCourses` selects only `lessonStatus`. `CourseProgress` is also not
term-scoped, so a course finished two terms ago still reads "Complete" for the current term. A
returning volunteer asking "did I do this one for *this* semester" cannot answer it from the app.
The sibling `/training` surface already gets this right, with a "Completed {date}" chip.

**Scope note.** This row covers the missing label only. The same unscoped model also lets a
prior-term completion satisfy the current term's blocking learning gate, which is **B1** and is
more serious. Fixing this row does not fix that; it only makes it visible. Ship them together.

**Fix.** Add `completedAt` to the `getMyCourses` select and to `MyCourseRow`, and render "Completed
{date}" under the badge on both `/learning` and `/get-started/learning`, matching the `/training`
chip. Where the completion predates the active term's `startDate`, render it muted with "(previous
term)" so the staleness is visible rather than implied.

#### R48. F-06-10: Module titles truncate where there is room to show them

`visual` / tier 1 / every learner on a multi-module course whose titles run past roughly 24
characters, which the two-module fixture already does / **S**
`src/app/(app)/learning/[courseId]/ScormPlayer.tsx:178`, `:196`

**What is wrong.** Walked at 1200px: "Module 2: Knowledge check" renders as "Module 2: Knowledge
ch..." while the sidebar column had unused width and the entire left gutter of the page was empty.
The nav is pinned to `md:w-56` and the title span carries `truncate` with no `title` attribute, so
hovering reveals nothing either. Real SCORM module titles are routinely longer than the fixture's,
and this list is the only thing telling a returning learner which module is which.

**Fix.** Widen the nav to `md:w-64 lg:w-72`, swap `truncate` for `line-clamp-2` so a long title
wraps to two lines instead of being cut, and add `title={s.title}` to the span as a hover fallback.
The completion check and the score chip already sit outside the truncating span.

#### R49. F-08-11: "Awaiting requester" is third person and the notification says nothing

`ia` / tier 1 / every requester whose ticket is ever blocked on them, on the state designed to
unblock it / **M**
`src/modules/support/components/status-badge.tsx:20-22`,
`src/modules/support/services/manage.ts:185-207`, `:203`,
`src/platform/notifications/notify.ts:92-94`, `src/platform/email/templates/support.ts:104`

**What is wrong.** When a ticket is waiting on the volunteer, every in-app surface says so in the
third person, and the one that pings them does not say it at all. `/support` shows the row as
"Awaiting requester" and the detail page shows an "Awaiting requester" badge over a Conversation
reading "No replies yet.", so the volunteer is given a third-person sentence about somebody called
"the requester" and no call to action. The label is deliberately viewer-neutral and the source says
why: it also renders on manager surfaces where "Awaiting you" would read as awaiting the manager.
`setStatus` does notify, but the in-app row carries none of the information: `notify()` builds the
inbox row's title and body from the Teams payload, which `setStatus` passes as
`title: "IT Support #N update"` and `summary: updated.subject`. Verified in the database after the
transition: the row reads "IT Support #2 update" / "Duo push not arriving on my phone", with no
status anywhere in it. The email template is the only artifact that names the state, and it repeats
the same third person.

**Fix.** Two changes. (1) Make the badge viewer-aware: give `SupportStatusBadge` a
`viewer: "requester" | "manager"` prop and render `AWAITING_REQUESTER` as "Awaiting your reply" for
the requester. Both call sites already know which they are (`RequestList` takes `showRequester`,
`TicketDetail` takes `isRequester`), so it is a prop thread, not new state; on the requester's
detail view pair it with a line pointing at the reply box below. (2) Put the status in the
notification: pass a title naming the new status and a summary naming the action when the status is
`AWAITING_REQUESTER` ("IT needs a reply from you before they can continue."). `STATUS_LABELS` is
already imported there for the email.

#### R50. F-08-13: Unread is a 6px dot that also knocks the list out of alignment

`visual` / tier 1 / every user with a mixed read/unread list, which is everyone after their first
week / **S**
`src/platform/ui/notification-bell.tsx:146`, `:140-160`,
`src/app/(app)/notifications/page.tsx:73-74`, `:69-81`

**What is wrong.** Measured on the bell dropdown across all four rows: read and unread share an
identical class string, an identical transparent background, and an identical title style
(computed weight 500). The only difference is a 6x6px `bg-brand` dot, which pushes unread titles to
x=814 against x=800 for the read one. `/notifications` repeats the pattern one size up: an 8px dot
with the same identical backgrounds and weight-500 titles, titles at x=81 unread against x=65 read,
and the word "Unread" present only as `sr-only` text, so it is never visible. Scanning a list for a
6px dot is the whole unread affordance in both places, and the ragged left edge makes the list read
as misaligned rather than as two states.

**Fix.** Render the dot slot at a fixed width for every row (an invisible spacer on read rows) so
titles share one left edge, tint the unread row (`bg-brand/5`), and set the unread title to
`font-semibold` against `font-normal text-muted-foreground` for read. Apply the same three rules in
both files so the bell and the full page agree.

#### R51. F-08-14: The notifications page reorders the list and drops the unread affordance

`ia` / tier 1 / every user who clicks "View all" from a bell showing unread, once the list outgrows
one page / **S**
`src/platform/notifications/inbox.ts:50`, `:64`, `src/app/(app)/notifications/page.tsx:56-58`

**What is wrong.** Observed with four notifications: the bell listed them in one order; clicking
"View all" produced a different one, interleaving read and unread. The reorder is deliberate and the
services disagree by design: the bell sorts unread-first, with a comment explaining that this keeps
the dropdown honest against the unread badge, while `listNotifications` for the page sorts strictly
by `createdAt`. The page has no unread filter and no tabs (its only control is "Mark all as read")
and pages at `NOTIFICATIONS_PAGE_SIZE`, so a user who followed the badge to deal with three unread
items lands on a chronological page where those items are scattered among read ones, identifiable
only by R50's dot.

**Fix.** Carry the bell's promise onto the page. Add an "Unread only" filter (a `?unread=1` param
threaded into `listNotifications`' `where` as `readAt: null`, with a count in the label) rendered as
a pair of NavForm tabs beside "Mark all as read", and default the page to the bell's ordering by
reusing the same `orderBy` array so read and unread do not interleave unless the user asks for
strict chronology.

#### R52. F-08-3: Nothing says the incident form is not monitored in real time

`ia` / tier 1 / every reporter with something happening right now, which is the case the form is
worst at / **S**
`src/app/(app)/incidents/page.tsx:93`

**What is wrong.** Measured against the rendered page: `/911|emergency|urgent.*call|call
.*immediately/i` matches nothing in `main`. The page description is "File a Professional Standards
Incident Report. Anyone signed in may report a concern about anyone.", and the only urgency
affordance is the section 6 radio, whose sole effect is one word in a reviewer's email. There is no
stated review interval anywhere in the module. A volunteer watching an unsafe handoff happen has a
24-field web form and no idea whether anyone will read it in the next hour or the next week.

**Fix.** Add an `Alert tone="warning"` immediately under the PageHeader, before the form: "This
form is reviewed during clinic business hours and is not monitored in real time. If someone is in
immediate danger, call 911. If a patient is at risk right now, escalate to the attending or the
Executive Director on duty before filing." Resolve the escalation contact from `getSupportContact()`
or a new ops setting rather than hardcoding it, the way the login page already resolves its IT
contact.

#### R53. F-08-4: Filing a report tells you what was stored, not what happens next

`flow` / tier 1 / every reporter, on the surface they will revisit to find out what happened / **S**
`src/app/(app)/incidents/mine/page.tsx:74`, `src/modules/incidents/services/report.ts:345-373`

**What is wrong.** Submitting redirected to `/incidents/mine?submitted=2` with the banner reading
exactly "Report #2 submitted.", and the detail page's entire "Reporting details" block is "Reported
by / Anonymity / Submitted / Strike requests". No owner, no expected turnaround, no statement that
they will be contacted, and no route to add information or withdraw the report. The app does notify
the reporter when a report is resolved or dismissed, and does *not* notify on the `UNDER_REVIEW`
transition, so a reporter watching the status badge sees nothing move for the entire review and is
never told to stop watching.

**Fix.** Say the two things already true. In the success banner: "Report #2 submitted. The clinic's
incident reviewers have been notified. You will get a notification when the report is resolved or
dismissed." On the detail page, add a "What happens next" line under the status badge with the same
sentence, plus the support contact for anything the reporter needs to add, since there is no in-app
follow-up path. Both are static copy over facts the services already guarantee.

#### R54. F-08-10: A refresh destroys the whole AVS form with no warning

`flow` / tier 1 / every clinician interrupted mid-visit, which is the normal condition in a clinic /
**S**
`src/modules/clinic/avs/form-state.ts:3`, `src/modules/clinic/avs/avs-tool.tsx:33`, `:38-63`

**What is wrong.** The tool holds every field in a `useReducer` over `initialAvsData` with no
persistence of any kind, and the page description says so plainly: "Nothing is saved." Measured on
the live page: `typeof window.onbeforeunload` is `"object"` (null), so no unload guard is installed,
against a form measured at 2406px of scroll height. The team clearly thought about accidental loss
in one place, arming "Clear / New summary" so it only wipes on a second click within 3s, but the far
more likely loss (a navigation on a shared clinic laptop) is unguarded.

**Fix.** Add a `beforeunload` guard that arms whenever any field differs from `initialAvsData`, so
the browser's own confirm dialog catches a refresh or a close. It is a small `useEffect` over the
existing `data` object and needs no new state. If ops wants more, mirror the same dirty check into a
`sessionStorage` draft keyed to nothing patient-identifying, but the unload guard alone closes the
common case.

#### R55. F-08-7: The Spanish handout's last line is hardcoded English

`visual` / tier 1 / every Spanish-language handout / **S**
`src/modules/clinic/avs/avs-pdf.tsx:179-182`, `src/modules/clinic/avs/strings.ts`

**What is wrong.** Decoded from the generated `es` PDF: the disclaimer correctly reads "Este resumen
es para sus registros y no es un expediente médico completo. Comuníquese con la clínica si tiene
preguntas." and is immediately followed by "Questions? Contact HAVEN Free Clinic at
hfc.it@yale.edu." That sentence is a hardcoded English literal, the only string in the document that
does not come from the `STRINGS[lang]` table every other label goes through.

**Fix.** Add `footerContact` to both language entries in `strings.ts` as a template ("¿Preguntas?
Comuníquese con {org} en {contact}." / "Questions? Contact {org} at {contact}."), surface it on
`LocalizedSummary` in `buildSummary`, and interpolate it instead of the literal. Ship with R7.

#### R56. F-08-8: The patient handout prints the internal IT mailbox as the patient's contact

`ia` / tier 1 / every patient who reads the handout and tries to use the address on it / **S**
`src/app/(app)/clinic/avs/page.tsx:5-11`, `src/platform/branding/support.ts:12-18`

**What is wrong.** The generated PDF reads "Questions? Contact HAVEN Free Clinic at
hfc.it@yale.edu." That value is `branding.supportEmail`, the same setting `getSupportContact()`
resolves and labels "Contact the {orgName} IT team". That helper's own doc comment scopes it to
"signed-out pages (sign-in, 404, welcome)", so the AVS is reusing an internal IT address well
outside its intent. One setting now serves two audiences with opposite needs, and a patient with a
question about their diagnoses is pointed at the address that handles password resets.

**Fix.** Split the setting. Add `branding.patientContact` to the settings registry (label
"Patient-facing contact", hint "Printed on patient handouts such as the After Visit Summary") and
read that in the AVS page instead of `branding.supportEmail`, falling back to the org's main clinic
line rather than to the IT address. Leave `branding.supportEmail` as the internal contact
everywhere else.

#### R57. F-08-9: Two different handouts download under one filename

`flow` / tier 1 / any clinician producing more than one handout in a session, and anyone doing an
English and Spanish pair / **S**
`src/modules/clinic/avs/avs-tool.tsx:92`

**What is wrong.** Generating in English produced `AVS-Garcia-2026-07-25.pdf`; switching to Español
and generating again produced `AVS-Garcia-2026-07-25.pdf`, which replaced the first file in the
download directory. The template is `AVS-${lastName}-${visitDate}.pdf`, carrying neither the
language nor any disambiguator. A clinician who wants to hand a patient the Spanish copy and file
the English one has two identically named files, or one, and no way to tell from the name which is
which.

**Fix.** Extend the template to include `data.preferredLang`, and append a short time or counter
suffix so a regenerated handout for the same patient and date does not silently replace the earlier
one.

---

### Band 3: tier 2, blocks

The staff member cannot finish the task from this UI, or finishes it while wrong about what
happened. Ranked below every tier-1 `costs-time` item because the population is a handful of
trained people who repeat the flow and have a colleague to ask. Every one of these is `S`.

#### R58. F-09-1: The approval queue cannot tell a live request from a stale one

`flow` / tier 2 / every schedule director who manages swap and drop requests, ongoing through the
term / **S**
`src/modules/schedule/components/pending-requests.tsx:66-94`, `:96-116`, mounted at
`src/app/(app)/schedule/builder/page.tsx:991-997`; `src/modules/schedule/services/requests.ts:651-691`

**Distinct from R3, deliberately.** R3 patches the requester's dropdown and the submission-time
service guards. This panel's gap survives that fix: a request that was valid when filed goes stale
during the pending-to-approval window, and the panel still shows no date framing.

**What is wrong.** The panel renders every queued request identically no matter how old its date
is: `requesterDateLabel` is a bare `displayDate(...)` string with no past or future framing, and
the Approve and Deny controls are the same one-click buttons regardless. `approveRequest` was
re-read end to end and checks scope, `PENDING` status, schedule-row validity, and swap collisions,
but never compares `req.requesterDate` or `req.targetDate` to now. A director clearing this queue
has no way, from the panel itself, to tell a live request from a stale one, and approving a stale
drop or swap silently deletes the `ShiftAssignment` row that records a shift the person actually
worked.

**Evidence note.** Code-read. The absence of a date comparison in `approveRequest` is read directly
from source, not observed at runtime.

**Fix.** In `pending-requests.tsx`, compute `todayKey` the way the rest of the module does and
compare it to `isoDateKey(request.requesterDate)` (and `targetDate` for swaps). Render a
`Badge tone="warning"` ("Past date") on any pending row whose date has passed, and change its copy
from "Drop on June 6" to "Drop on June 6 (already happened)" so a director sees the risk before
clicking Approve, independent of whatever backend guard R3 adds.

#### R59. F-09-7: "Record decision" never says the applicant is notified from another page

`flow` / tier 2 / every recruitment director recording a routed-applicant decision, each cycle /
**S**
`src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx:284-320`; compare
`src/app/(app)/recruitment/interviews/[interviewId]/page.tsx:228`

**What is wrong.** The "Department decision" card's routed-decision branch lets a director pick
Accept, Reject, or Waitlist and submit via `decideRoutedAction` with a button labeled "Record
decision", and no text anywhere in that branch says Accept only records an internal decision and
does not notify the applicant until a separate "Release decisions" step is run on the Decisions
page. There is not even a link to that page from here. The sibling surface for the same decision
states this explicitly: the director-track interview page carries "Accept creates an acceptance,
released from the Decisions page." directly under its own decision form. A director who clicks
"Record decision" with Accept selected has every reason to believe the applicant now knows.

**Evidence note.** Code-read. Confirmed by the line's absence from the full text of the branch and
its presence at the cited line on the interview page.

**Fix.** Add the interview page's own line, adapted, directly under the form, with the "Decisions"
word linked to `/recruitment/cycles/{id}/decisions`.

#### R60. F-11-2: "Reset to built-in default" resets to the admin's master template instead

`ia` / tier 2 / recruitment directors resetting a cycle's contract override, once an admin has ever
customized the master template / **S**
`src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx:250`,
`src/modules/recruitment/contract/template.ts:35-41`, `:65-68`,
`src/modules/recruitment/contract/resolve.ts:34-40`, `src/app/(app)/admin/contract/page.tsx:34-61`

**What is wrong.** The per-cycle contract editor's reset button reads "Reset to built-in default",
but `resetCycleContractLayout` only deletes the cycle's own override row; the next read falls
through to `resolveContractLayout`, whose documented precedence is "cycle override -> global
default -> code default". So a director who clicks that button while the org's admin has ever saved
a custom master template does not get the original built-in text back; they silently get whatever
the admin's master template currently says. `/admin/contract`'s own `hasOverride` copy confirms this
is a real, expected state. Nothing on the per-cycle page acknowledges that a master-template layer
exists between "this cycle's edits" and "the code default" the button names, and nothing on
`/admin/contract` links to any specific cycle, so a director cannot go check what the master
template contains before clicking. The two editors share the same component and the same underlying
setting (`onboarding.contractTemplate`): one feature rendered on two disconnected pages in two
modules.

**Evidence note.** Code-read. The precedence chain and the button copy are read directly from
source.

**Fix.** Rename the per-cycle button to "Reset to master template" (or "Reset to org default") when
a master template exists for the cycle's track, and add a one-line link from the per-cycle editor to
`/admin/contract?track=...` so a director can see what the fallback contains before resetting into
it.

#### R61. F-10-2: Approving a strike on an anonymous report silently excludes the directors

`flow` / tier 2 / every `incidents.manage` reviewer who approves a strike request tied to an
anonymous report; narrow but high-stakes when it occurs / **S**
`src/app/(app)/incidents/[id]/page.tsx:354-374`, `src/modules/incidents/services/report.ts:1035`,
`src/modules/incidents/services/strike-notifications.ts`,
`src/app/(app)/incidents/strikes/strike-row.tsx:90`

**Distinct from R9, deliberately.** R9 is the reporter not knowing who reads their name. R61 is the
reviewer not knowing their own approval click will silently exclude directors. Different actor,
mechanism, and consequence.

**What is wrong.** The "Approve strike" form gives the reviewer a category select and a notes field,
with no text anywhere on the page stating that approving a strike on an anonymous report
automatically marks the resulting `DisciplinaryAction` confidential. That branch lives in
`decideStrike` (`confidential: report.anonymous`) and its consequence is real: `notifyStrikeIssued`
skips every department director when `action.confidential` is true. The page surfaces
`report.anonymous` itself, in the unrelated "Reporting details" card above, but nothing connects
that fact to what clicking "Approve strike" is about to do. The "Confidential" badge only appears
afterward, on the separate `/incidents/strikes` ledger.

**Evidence note.** Code-read. The confidentiality derivation and the notification gate are read
directly from the two service files.

**Fix.** Add a line inside the "Approve strike" form when `report.anonymous` is true: "This report
was submitted anonymously, so the resulting strike will be marked confidential and the subject's
department directors will not be notified." Surface the same fact next to the "Confidential" badge
on `/incidents/strikes` so it reads consistently before and after the decision.

---

### Band 4: tier 2, costs-time

Trained staff get there, slower. All `S`, all code-read.

#### R62. F-09-2: "Save quiz settings" does not mention that the questions live elsewhere

`flow` / tier 2 / every recruitment director setting up a term-training cycle, each cycle / **S**
`src/app/(app)/recruitment/cycles/[id]/page.tsx:204-249`, `src/modules/recruitment/cycle-nav.ts:58`

The Training card's quiz-settings form (pass %, max attempts, in-person training date and location)
ends in a button labeled "Save quiz settings", with no text or link anywhere on the card indicating
that the actual keyed quiz questions live on a separate page. That page exists and is reachable only
from the persistent cycle-workspace tab bar. A director who fills in this card and clicks "Save quiz
settings" has a reasonable basis for believing the quiz is configured. **This is a plausible
contributing cause of R6**, the unpassable unkeyed quiz. **Fix:** add a link "Add or edit quiz
questions" under the form, plus a "0 questions" / "12 questions" count so an empty quiz is visible
from the page a director actually lands on after creating a cycle. Ship with R6.

#### R63. F-10-1: "Assign to all departments" silently overrides the department picks beside it

`ia` / tier 2 / every learning manager assigning a course to specific departments, each course /
**S**
`src/app/(app)/learning/manage/[courseId]/page.tsx:76-93`,
`src/modules/learning/services/courses.ts:66-82`,
`src/app/(app)/volunteers/ehs/manage/[trainingId]/page.tsx:71-73`

The "Assign to all departments" checkbox and the per-department checkbox grid sit in the same form
with no text, disabled state, or visual link between them, but they are not independent settings:
`setCourseAssignment` writes `assignToAll` and the `departmentIds` list as two separate columns, and
the read side gates on `assignToAll` alone, making the department list inert whenever it is checked.
A manager can tick specific departments, leave "Assign to all" checked from a prior save, click
"Save assignment," and the course still goes to everyone with no on-screen indication their picks
did nothing. The EHS training edit page has the identical `requiredForAll`-overrides-`departmentIds`
relationship but at least carries a hint sentence; the Learning course page has no equivalent text
at all. **Fix:** disable or gray out the department grid when "Assign to all" is checked, and add
the same one-line hint EHS already uses. Apply the disabled-state treatment to the EHS page too,
since its hint alone does not stop the checkboxes staying live.

#### R64. F-10-3: The support triage table has no priority column

`ia` / tier 2 / every `support.manage_requests` holder triaging the master ticket queue, on every
visit / **S**
`src/modules/support/components/request-list.tsx:36-75`, `:40-45`,
`src/modules/support/components/request-filters.tsx:102-117`,
`src/modules/support/services/tech-request.ts:164`

`TechRequestListRow` carries `priority`, `RequestFilters` lets a manager filter `/support/all` by it
(LOW/MEDIUM/HIGH/CRITICAL), and the single-ticket detail view lets a manager set it. But the shared
`RequestList` table both `/support` and `/support/all` render never displays it: the columns are `#`,
`Subject`, `Category`, `Requester`, `Status`, `Updated`, with no Priority column and no
`PriorityBadge` anywhere in `status-badge.tsx`. This is the table meant for clinic-wide IT triage,
and it has no visual hierarchy for the one field that exists to drive triage. **Fix:** add a
Priority column with a small `Badge` toned by priority, mirroring the `EPIC_STATUS_TONE` pattern,
shown at least on the manager (`showRequester`) variant.

#### R65. F-09-6: Publish is one click, Unpublish needs a confirm

`flow` / tier 2 / every schedule director publishing a department's schedule, a handful of times per
term / **S**
`src/app/(app)/schedule/builder/page.tsx:667-684`, `:670-675`, `:677-681`,
`src/modules/schedule/services/publication.ts:29-56`

Publish and Unpublish are opposite, equally reversible actions on the same `SchedulePublication`
toggle (confirmed: neither sends any notification), but they are guarded asymmetrically. Unpublish is
a `ConfirmButton`; Publish, the action that makes a possibly incomplete schedule visible to the whole
department, is a plain one-click submit. The action more likely to expose an unfinished schedule is
the one that needs no confirmation. **Fix:** wrap Publish in the same `ConfirmButton` pattern used
two lines away. Same inversion as R37 on the volunteer side; the two are worth settling with one
rule.

#### R66. F-09-5: The day-view date strip ignores the current clinic date it already has

`flow` / tier 2 / every schedule director using the default Day view, every session across a
multi-week term / **S**
`src/app/(app)/schedule/builder/page.tsx:700-724`, `:152`,
`src/modules/schedule/services/builder.ts:757-764`,
`src/modules/schedule/components/builder-grid.tsx:367-382`

The Day-view clinic-date strip (the default view) styles a pill only by whether it is the currently
*selected* date. It never uses `currentClinicDateKey`, which the service layer already computes
(ET-aware "today") and which the Grid view *does* use to give the current clinic date a persistent
`bg-brand text-white` header cell independent of selection, with the prop documented as "Clinic date
to highlight as the 'current week' wayfinding cue". So in the default view, clicking a past date to
review it paints that past date with the exact treatment the app uses elsewhere to mean "this is the
current week," while the actual current week reverts to plain the moment you look away. **Fix:** add
a persistent marker independent of `isSelected` (a dot or `ring-1 ring-brand`) on the pill where
`key === currentClinicDateKey`, mirroring the semantics `BuilderGrid` already applies to the same
value.

#### R67. F-09-4: Cycle lifecycle actions have no card, heading, or explanation

`flow` / tier 2 / every recruitment director who touches cycle lifecycle controls, each cycle / **S**
`src/app/(app)/recruitment/cycles/[id]/page.tsx:169-202`, `:194-200`, `:150-152`,
`src/app/apply/[slug]/wizard-steps.ts:30-35`, `src/modules/recruitment/services/submissions.ts:118`

The cycle's lifecycle actions (Publish, Close, Reopen, Archive, plus "Enable/Disable renewal branch")
render as a bare flex row with no `Card`, no `SectionHeader`, and no explanatory copy, while every
other control on the page is wrapped in a `Card` with a heading and, for Application window, a full
sentence explaining what the setting does. The renewal toggle reads only "{Disable/Enable} renewal
branch" with zero hint text about what a "renewal branch" is. Its effect is live and public:
`acceptsRenewals` controls whether the public apply wizard offers an intro step and the
RENEWAL/TRANSFER applicant path at all. **Fix:** wrap the row in a `Card` with a `SectionHeader`
("Cycle status"), matching the treatment every other section gets, and add one sentence under the
renewal toggle: "Lets returning and transferring members apply through a renewal path on the public
form."

#### R68. F-10-5: The "Added to EHS?" column affects nothing and says nothing

`flow` / tier 2 / `volunteers.manage_compliance` holders using the EHS dashboard, every time they
touch that column / **S**
`src/app/(app)/volunteers/ehs/page.tsx:48-63`, `src/platform/ehs/engine/applicability.ts`,
`src/platform/ehs/services/flag.ts`

The "Added to EHS?" column sits directly left of the real per-training completion cells, styled with
the same pill and button treatment (`Added`/`Add`, primary versus outline), so it reads as one more
compliance signal. It is not: `addedToEhs` is a bare boolean on `Person` that
`requiredTrainingsForMember` and `missingTrainings` never read, so toggling it has zero effect on
anyone's clearance or the COMPLETE/MISSING cells beside it. Its only other appearances are the legacy
Airtable import and email-audience targeting. Understanding it correctly requires knowing about the
retired Airtable tracker, which is knowledge held entirely outside the app. **Fix:** add a hint line
under the column header ("Administrative flag carried over from the legacy roster tracker; does not
affect compliance status or the columns to the right."). If the field has no remaining operational
purpose beyond email targeting, consider whether it belongs on the compliance dashboard at all.

#### R69. F-11-1: Subcommittees are a recruitment concept editable only inside Admin

`ia` / tier 2 / recruitment cycle leads who need a new subcommittee, a handful of times a year, and
only the subset who also hold `admin.manage_subcommittees` plus `admin.access` / **S**
`src/platform/modules/registry.ts:147`,
`src/app/(app)/recruitment/cycles/[id]/subcommittees/page.tsx:35`, `:80-83`

Subcommittees are entirely a recruitment concept (applicants rank them, the recruitment team assigns
accepted applicants to them, per the description text on both pages), but creating or editing one
exists only at `/admin/subcommittees`, gated on `admin.manage_subcommittees` and the module-level
`admin.access`, both distinct from `recruitment.access`. The per-cycle "Assign subcommittees" page
reads the list into a plain `<Select>` with no create option, no link to `/admin/subcommittees`, and
no text hinting where subcommittees come from. This is the clearest instance in the admin module of a
nav item that mirrors the database schema (one table, one flat CRUD page) rather than the workflow it
serves. **Fix:** add a permission-aware "Manage subcommittees" link from the per-cycle page, mirroring
the pattern already used on `/admin/email`, or move subcommittee CRUD into the Recruitment module's
own nav.

#### R70. F-11-3: Campaigns and Templates appear in no nav and no command palette

`ia` / tier 2 / `admin.send_email_campaign` and `admin.manage_email_templates` holders, a population
that need not overlap with `admin.manage_sync` / **S**
`src/platform/modules/registry.ts:138-153`, `:150`, `src/app/(app)/admin/email/page.tsx:291-311`,
`src/platform/ui/command-palette.tsx:70-72`, `src/platform/ui/app-shell.tsx:87,91`,
`src/platform/modules/access.ts:92`

`/admin/email/campaigns` (compose and send bulk email) and `/admin/email/templates` (edit the copy of
every platform email) are full features, but neither is registered in the admin module's `nav` array.
The command palette's page index is built from exactly that array, and `pageIndex(items)` only
appends a hardcoded personal-pages block. So Cmd+K, built specifically to solve "a page findable only
by someone who already knows it exists", cannot find either page. The sole path in is landing on
`/admin/email` first and noticing two small underlined text links in the page header, rendered only
when the viewer holds the target page's own permission. A person holding `admin.send_email_campaign`
but not `admin.manage_sync` would not even see the "Email" tab that hosts those links, since the nav
item gates on `admin.manage_sync`. **Fix:** register "Campaigns" and "Templates" as their own
permission-gated sub-items in the admin module's `nav` array, so both surface in the tab row and the
command palette like every other admin page. See the coverage note on the related RBAC edge case.

#### R71. F-11-4: Three unrelated surfaces are named "Notifications"

`ia` / tier 2 / the small population of `admin.manage_sync` and `admin.manage_settings` holders
looking for the channel-routing controls, layered on top of every signed-in user who already carries
a different meaning for the word / **S**
`src/platform/modules/registry.ts:151`, `src/platform/settings/registry.ts:288-306`,
`src/app/(app)/notifications/page.tsx:54`, `src/app/(app)/admin/notifications/page.tsx:2`, `:168-177`

The personal inbox at `/notifications` is what every signed-in user already associates with the word.
The admin nav tab "Notifications" opens `/admin/notifications`, which its own file comment describes
as a "Teams message monitoring dashboard": a delivery log with per-row Retry, nothing about
preferences. The actual per-notification-type channel routing (Email / Teams DM / Both) is a settings
category also named "Notifications", rendered as a section on `/admin/settings`. The admin
notifications page is self-aware enough to paper over the collision in prose ("Choose Email, Teams, or
Both per notification type in Settings > Notifications"), but the fix was a sentence, not a rename.
**Fix:** rename the admin nav tab to what it is, for example "Message log" or "Teams delivery",
freeing "Notifications" for the settings category that actually controls notification behavior.

#### R72. F-11-5: Saving one setting returns you to the top of a 44-field page

`flow` / tier 2 / the `admin.manage_settings` holder(s) doing a multi-field settings pass, most
acutely the one-time setup of the 23 notification-channel selects / **S**
`src/app/(app)/admin/settings/page.tsx:45-69`, `:127-130`, `:140`, `:142-210`

Every one of the roughly 44 settings on this page (six categories) is its own `<form>` with its own
Save button; there is no batch save. `updateAction` and `resetAction` both redirect to a bare
`/admin/settings?saved=1` with no hash or anchor, so saving any single field reloads the page at the
very top, and the lone "Saved." banner gives no indication which field it refers to. An admin working
through a long section (Notifications, the last category, is 23 fields deep) has to scroll back down
past every earlier category after each individual save, once per field. **Fix:** give each `<section>`
an `id={category}` and redirect both actions to `/admin/settings?saved=1#{category}`; the category is
already in scope at both call sites via `def.category`.

#### R73. F-09-3: The cycle emails pages lose their breadcrumb trail

`ia` / tier 2 / every recruitment director customizing cycle-specific emails, each cycle / **S**
`src/app/(app)/recruitment/cycles/[id]/emails/[key]/page.tsx:1-93`, `emails/page.tsx:1-44`,
`src/platform/ui/breadcrumb-context.tsx:32-36`, `src/platform/modules/registry.ts:167`,
`breadcrumb-trail.ts:46-48`

Both cycle-emails pages never call `SetBreadcrumb`, unlike every other cycle sub-page. The breadcrumb
override is keyed by exact pathname, so these two routes fall through to the generic
`buildBreadcrumbs` fallback, and that fallback resolves to nothing useful here: the recruitment
module's only nav entry has an `href` equal to `moduleHref`, and the `parentSection` lookup explicitly
excludes any nav item whose `href === moduleHref`. The rendered trail is therefore just "Hub >
Recruitment" with no cycle name and no link back to the specific cycle. The page's own `PageHeader`
does not fill the gap either: the title is the email template's name and the description is only
"Customized for this cycle" / "Using the default". A director editing a template has no on-page way to
confirm which cycle's email they are looking at. **Fix:** add `SetBreadcrumb` with `cycleTrail(...)`
to both pages, mirroring every sibling. The `[key]` page makes no `recruitmentCycle` query at all
today, so the fix adds one for `cycle.title`, the same shape already used in `emails/page.tsx`.

---

### Band 5: tier 1, polish

It works and it reads badly. Every one of these is `S`, and several are a single string.

#### R74. F-08-16: Three empty states in one release, three different shapes

`visual` / tier 1 / every new volunteer, on their first pass through the hub / **S**
`src/app/(app)/incidents/mine/page.tsx:78-84`,
`src/modules/support/components/request-list.tsx:28-34`,
`src/app/(app)/notifications/page.tsx:61`

Walked all three with genuinely zero rows. `/incidents/mine` is the good one: a centered column, a
sentence, and a primary "Report a concern" button. `/support` is a padded `Card` containing the four
words "No requests yet." and no action at all, so the only route onward is the module sub-tab.
`/notifications` is a bare `<p className="text-sm text-muted-foreground">No notifications yet.</p>`
with no card, no centering, and no action. The module a volunteer is most likely to hit first with
nothing in it (support) is the one with no way forward. **Fix:** standardize on the
`/incidents/mine` shape, ideally as a shared `EmptyState` primitive taking a message, an optional
explanation, and an optional action. Give `/support` the missing CTA ("Submit a request" pointing at
`/support/new`) plus a line on what the module is for, and give `/notifications` the same centered
treatment with an explanatory line.

#### R75. F-05-10: A dashboard action tile clips to "Request a s..."

`visual` / tier 1 / every volunteer with upcoming shifts / **S**
`src/app/(app)/page.tsx:427`, `:445`

The middle action tile renders as "Request a s..." with the label clipped mid-word. The grid is fixed
at `sm:grid-cols-4` while only three cards were produced, so each tile is sized to a quarter of the
row and the label carries `truncate`, clipping "Request a swap" even though roughly a quarter of the
row to the right is empty. **Fix:** size the grid to the number of cards actually rendered, or drop
`truncate` from the label line and let it wrap to two lines while the `sub` line keeps truncating.

#### R76. F-04-20: The confirmation email subject reads "application application"

`visual` / tier 1 / every applicant, once per cycle / **S**
`src/platform/email/templates/recruitment.ts`

The submission confirmation subject rendered "We received your Summer 2026 volunteer application
application". The template is "We received your {{ cycleTitle }} application" and the app's own
default cycle naming ends in "application", so the doubled word is the normal case, not an edge case.
**Fix:** change the `defaultSubject` to "We received your application: {{ cycleTitle }}".

#### R77. F-04-19: A brand-new applicant is greeted "Welcome back, Ux"

`visual` / tier 1 / every applicant who signs in by email link / **S**
`/apply/page.tsx`

A brand-new applicant with no prior application is greeted "Welcome back, Ux": "welcome back" for
someone who has never been here, and a first name invented from the email local part
(`ux.cold@example.com` and `ux.applicant@yale.edu` both render "Ux"). Every magic-link applicant hits
this, because the cookie path carries no `personId` and no Entra name, so the email fallback always
wins. **Fix:** greet "Welcome" when `myApps.length === 0`, and drop the email-local-part fallback,
greeting without a name when neither `Person.name` nor the Entra `firstName` is available. The SSO
variant of this is unverified; see Coverage.

#### R78. F-04-21: Step titles and option labels do not match their contents

`ia` / tier 1 / every applicant / **S**
Default application template

Step 3 is titled "Medical and language experience" but contains a single medical-licensure question;
every language question is on step 4, "Languages". Step 5's two checkboxes are labelled with the raw
strings "VADM dual option" and "INTP dual option", and each explanatory paragraph sits below its
checkbox at the same spacing as the next checkbox, so it is ambiguous which box each paragraph
describes. Steps 6 and 7 ask two near-identical questions on consecutive pages ("Are you flexible in
your department choice?" then "Would you be willing to switch departments?") with nothing explaining
the difference. **Fix:** rename step 3 to "Medical experience". Relabel the step-5 options in plain
language ("Vaccine Administration (dual role)", "Interpretation (on-call interpreter)") and tighten
each option's help text against its own label. Merge the two department-flexibility questions onto
one step, or add help text distinguishing them.

#### R79. F-04-22: The training acknowledgement is missing the word "at"

`visual` / tier 1 / every accepted volunteer / **S**
`src/modules/recruitment/contract/training-date.ts:15-18`, `:7`

The acknowledgement reads "I acknowledge that I can attend the training on Saturday, May 30 Yale
Physicians Building, 800 Howard Avenue, Room 1A or will otherwise inform my directors". A space does
separate the date from the address (`formatTrainingLocation` prepends one by design), so "no
separator" would overstate it; the defect is the missing word "at" between them, on the one line that
tells the volunteer where and when to show up. **Fix:** move "at" into `formatTrainingLocation` so it
returns `" at " + trimmed` when a location is set and `""` when it is not, rather than hardcoding "on
{{trainingDate}} at {{trainingLocation}}" in the contract defaults. `formatTrainingDate` already
returns the literal "the scheduled training date" when `inPersonTrainingDate` is null, so a hardcoded
"at" in the template would leave a dangling "on the scheduled training date at " once
`trainingLocation` is also null.

#### R80. F-08-15: "Mark all as read" is offered on an empty notifications page

`flow` / tier 1 / every user on their first visit, and every user of a quiet account / **S**
`src/app/(app)/notifications/page.tsx:56-58`, `:60`, `src/platform/notifications/inbox.ts:88`

Walked with zero notifications: the page renders "Mark all as read" as an enabled button above the
text "No notifications yet." The button is rendered unconditionally, above the `rows.length === 0`
branch, and its action runs an `updateMany` that matches nothing, reports nothing, and leaves the
page identical. The bell's own dropdown gets this right, hiding its "Mark all as read" when the list
is empty. **Fix:** move the form inside the non-empty branch, or gate it on
`rows.some((n) => !n.readAt)`.

#### R81. F-08-12: The ticket header prints "Submitted" twice, meaning two things

`visual` / tier 1 / every requester reading their own ticket in any non-initial state / **S**
`/support/[id]` sub-header

Observed while a ticket was in the awaiting state: the sub-header read "#2 · DUO MFA · Submitted Jul
28, 2026" immediately above a status badge reading "Awaiting requester", and while the ticket was in
its initial state the same two elements both read "Submitted". The reader has to work out that the
first is a date verb and the second is the lifecycle state. **Fix:** relabel the sub-header's date to
"Opened Jul 28, 2026", leaving "Submitted" to mean only the status. One string.

---

### Band 6: tier 2, polish

#### R82. F-10-4: Resetting a learner's progress confirms with a bare "Confirm?"

`flow` / tier 2 / learning managers resetting a learner's course progress, an infrequent action /
**S**
`src/app/(app)/learning/dashboard/page.tsx:94`

The per-row "Reset" button uses `ConfirmButton`'s default `confirmLabel`, a bare "Confirm?", even
though resetting wipes a learner's SCORM completion and forces a retake. Every other destructive
`ConfirmButton` in this scope names its consequence: "Offboard {name}? This removes all their active
memberships.", "Delete this disciplinary action? This cannot be undone.", "Confirm strike?",
"Unmark?". This is the one instance in scope that falls back to the generic label, so a manager
scanning a 25-row completion table and misclicking one row gets a confirm step that does not remind
them what they are about to erase. **Fix:** give it a descriptive `confirmLabel` naming the learner
and the consequence, matching the pattern used everywhere else.

---

## Needs its own brainstorm

Six items, all `L`. These are **not backlog items** and should not be estimated, scheduled, or
handed to someone as a ticket. Each one needs a decision made before anyone writes code, and in
four of the six the decision is a data-model or policy question, not a UI question.

Two of them are tier-1 `blocks` findings. They are here because a design decision comes first, not
because they are less serious than anything in "Ship these first."

### B1. F-06-12: A course completed once satisfies the learning gate in every later term

`flow` / tier 1 / **blocks** / every returning volunteer, in their second and every later term
`prisma/schema.prisma:1632-1651`, `:1474`, `src/modules/learning/services/enrollment.ts:118-121`,
`src/modules/onboarding/engine/status.ts:31-37`,
`src/modules/onboarding/services/onboarding.ts:60-70`

**What is wrong.** `CourseProgress` has no term field, unlike its sibling `Training`, which carries
`termId`. `getMyCourses` scopes *assignment* by term but its progress query filters on `personId`
and `courseId` only, so a two-year-old completion is returned as this term's status.
`deriveLearningTaskState` then returns COMPLETE, the checklist row goes green, and the blocking
learning step clears without the volunteer opening anything. The surrounding system plainly
evaluates per term: `computeOnboardingForTerm` computes every task for a passed `term`, and its own
doc comment records that learning was specifically changed to accept a term id so the checklist and
the schedule builder's clearance map would agree for a given term. Learning is now the one input to
that per-term decision that cannot vary by term, so it silently answers "already done" for all of
them.

**Why it needs a brainstorm.** Whether a given course *should* recur is a real policy question and
the model cannot express it, so it picks "no course ever recurs" by default without saying so
anywhere. Annual-refresh content plainly should recur; a one-off orientation module plainly should
not; and some will want "recurs yearly" rather than "recurs each term", which a per-term flag
cannot express. The decision also has to cover what happens to a member mid-flight when an admin
flips a live course from `ONCE` to `PER_TERM` (does an in-progress attempt reset, does a currently
cleared volunteer become uncleared), whether the reopened course reuses the same `CourseProgress`
row or starts a new per-term one for audit purposes, and whether a recurring course needs a
deadline, which folds straight into **B4**.

**Shape of the fix, once decided.** Add `Course.recurrence` (`ONCE` or `PER_TERM`, defaulting to
`ONCE` so today's behavior becomes explicit rather than accidental) and add `termId` to
`CourseProgress` mirroring `Training`, backfilling existing rows to the term containing their
`completedAt`. Scope the `getMyCourses` progress lookup by `termId` for `PER_TERM` courses and
leave it unscoped for `ONCE` courses. Surface the setting in the `/learning/manage` course form and
render "Retake each term" on the learner card. Ship R47 alongside so the staleness is visible.

### B2. F-04-2: The onboarding contract has no draft save of any kind

`flow` / tier 1 / **blocks** / every accepted volunteer, once per cycle

**What is wrong.** The contract is one 4,719px page (5.9 viewport heights) with no draft save.
After filling the HIPAA completion date and attaching the certificate PDF, a reload left both
empty; only server-prefilled Person fields survived. Nothing on the page warns that work is not
saved. The form requires a HIPAA certificate PDF that a new volunteer must leave the page to obtain
from Yale's training site, so the ordinary path through this form is to lose everything typed,
including all five signatures.

**Why it needs a brainstorm.** Where partial contract state lives (a `draftAnswers` JSON column on
`OnboardingContract` versus a separate draft row), what happens to a half-filled contract when a
director resends or the link expires, and whether drawn signature strokes are persisted or
deliberately re-collected each time. That last one is a policy question about what a signature
means, not a storage question.

**Interim mitigation that needs no decision.** Add a notice above the first field ("Nothing is
saved until you submit. Have your HIPAA certificate PDF ready before you start.") and a
`beforeunload` guard once the form is dirty. That is `S` and can ship immediately without
prejudging the design.

### B3. F-07-3: Nothing in the app says when a shift starts or where to go

`ia` / tier 1 / `costs-time` / every volunteer, most acutely every first-term volunteer, before
every shift
`prisma/schema.prisma:1094-1119`, `src/platform/settings/registry.ts:69-308`

**What is wrong.** The shift card carries date, department code, role, and tags, and stops there.
This is a data-model gap, not a rendering one: `ShiftAssignment` has `clinicDate`, `role`, and four
tag booleans and no time or place columns; a grep for `startTime`, `endTime`, `location`,
`clinicHours`, and `address` across `src/modules/schedule/` and `prisma/schema.prisma` returns only
unrelated hits; and the admin settings registry has keys for time zone, branding, and reminder
intervals but none for a clinic time or address. The two facts a volunteer most needs before showing
up are carried entirely outside the app, by email and word of mouth, on the one screen that exists
to tell them when they are working.

**Why it needs a brainstorm.** Does time hang off `Term` (one set of clinic hours for the
semester), off each entry in `Term.clinicDates` (which would need those to stop being a bare
`DateTime[]`), off `Department` (departments plausibly start at different times), or off
`ShiftAssignment` (maximum flexibility, maximum authoring burden)? Does location vary by
department, given that some are remote and the schema already carries a `remote` tag per
assignment? Is a single clinic address enough, or does the Food Pharmacy sit somewhere else?
Whatever shape is chosen has to reach the `schedule-reminders` cron email, the dashboard next-shift
hero, `/schedule/full`, and the AVS generator's assumptions, so the fan-out deserves a plan before
the migration.

### B4. F-06-8: Learning modules have no deadline anywhere in the model

`ia` / tier 1 / `costs-time` / every volunteer gated on learning modules, every term
`prisma/schema.prisma:1585-1613`

**What is wrong.** The `Course` model carries `isActive`, `audience`, `position`, and the SCORM
columns and nothing date-bound, and neither learner-facing list renders a due date. Yet the learning
step blocks scheduling, and the checklist tells the volunteer "You cannot be scheduled until each
one is done" without saying by when. A volunteer with a shift on Saturday and a course "In progress"
has no way to know whether it is urgent, and a director has no lever short of email. This is also
why the module has no overdue state, no reminder, and no sort order by urgency.

**Why it needs a brainstorm.** Where the deadline lives. A single date on `Course` is simplest but
wrong for a course assigned to several departments with different clinic calendars. A date on
`CourseDepartment` fixes that but still cannot express "due two weeks after the volunteer is
onboarded", which is what a rolling intake actually needs. A per-term assignment row would express
all three but is a new table and a migration for existing progress. The choice also decides whether
the reminder is a fixed date, a relative offset, or both, and whether an overdue course should
escalate the onboarding step to something the schedule builder surfaces. Worth settling alongside
the existing compliance and shift-reminder cron, which already owns the "chase people about a
deadline" job.

**Settle B1 and B4 together.** They are the same missing per-term assignment concept seen from two
sides.

### B5. F-04-18: The application and the contract use incompatible form models

`ia` / tier 1 / `costs-time` / every accepted volunteer

**What is wrong.** The same person, days apart, is given two incompatible form models for the same
kind of task: a 12-step wizard with a progress rail, per-field inline errors, and 800ms autosave for
the application, then a single 5.9-screen scroll with native browser validation, no progress
indication, and no save for the onboarding contract. Everything learned in the first form is wrong
in the second.

**Why it needs a brainstorm.** Whether the onboarding contract adopts the recruitment wizard shell
or both converge on a shared multi-step form primitive, and how the contract's block model
(sections, agreements, `visibleWhen`) maps onto wizard steps without breaking the client and server
visibility parity the contract already guarantees. Note that adopting the wizard shell would subsume
**B2** for free, since the wizard already has autosave; deciding B5 first may make B2 moot.

### B6. New: Migrate the remaining inline flash alerts to toasts

`flow` / tier 1 / `costs-time` / every user, every action on roughly 30 to 40 pages

**What is wrong.** Nothing new. This is the second half of R11, staged separately because building
the toast system is small and converting the pages is not.

**Why it is here.** This is the one item in this appendix that does **not** need a design
brainstorm: the design is fully settled in
`docs/superpowers/specs/2026-07-28-ux-audit-flow-friction-design.md`. What it needs is a **migration
plan**: which of the 121 `?error=` sites and 37 `?saved=` sites convert, in what order, and a
per-page ruling on the migration rule (page-level flash confirmations become toasts, form-bound
validation stays inline). It is rated `L` on volume, not on uncertainty. Sequence it directly after
R11 and treat it as a series of small PRs rather than one.

---

## Themes

The cross-cutting patterns are more useful than any single row, because each one is a single
decision repeated rather than N independent defects.

### 1. The schedule surfaces have no concept of "now"

**R3, R14, R35, R36, R58, R66, B3.** Seven findings across both tiers and four different files, all
the same absence. `/schedule` renders past and future shifts with byte-identical styling. The change
request flow will happily offer, accept, and confirm a swap with a date seven weeks gone. The date
strip on `/schedule/full` marks only the pill you clicked, so the moment you look at a past week you
lose today. The builder's Day view ignores a `currentClinicDateKey` that the service layer already
computes carefully and the Grid view already uses. The approval queue shows no date framing at all. A
pending request shows no timestamp. And beneath all of it, no shift anywhere in the app has a time of
day.

The striking part is that the data is present every time. `todayKey` is computed correctly in
`fullSchedule`. The dashboard already filters shifts by it. `BuilderGrid` already highlights on it.
Six of the seven are display or guard changes over values already in scope. This is not a hard
problem; it is one that nobody has framed as a single problem.

### 2. Actions that look terminal but silently require a second step elsewhere

**R59, R62, R60, R69, R45, R19.** "Record decision" records a decision the applicant will never hear
about until someone runs "Release decisions" on a different page. "Save quiz settings" saves the
settings and not the questions, which live on a tab it does not link to. "Reset to built-in default"
resets to the admin's master template, which lives in a different module. The subcommittee you need
is created in Admin, from a page Recruitment does not link to. Shift preferences are saved as a side
effect of submitting a quiz. Verifying a certificate unblocks a person who is never told.

In every case the second step exists and works. What is missing is one sentence or one link at the
point of the first click. Five of the six fixes are a line of copy.

### 3. Onboarding and training gates report contradictory state

**R1, R13, R18, R43, R47, B1.** The checklist and the step page disagree about the same certificate,
one click apart. The progress counter counts five steps and releases at four, so it can never fill,
and the "Not yet cleared" pill that follows from the same split never clears for anyone, ever. The
reassuring copy in the verification wait renders only in the branch where the PDF parser failed. The
training row says "Action needed" before there is any action to take. A course completed two terms
ago reads as done for this one.

The pattern underneath is that gating is computed in one place (`computeGating` over blocking tasks)
and *displayed* in another (`summarize` over all tasks, `cleared` versus `onboarded`,
`deriveHipaaTaskState`'s two-way collapse of a four-state model). Every one of these is a display
layer that lost information the engine already had.

### 4. Gate integrity is weak in more than one place

**B1, R5, R6, R22, R23, R13.** A prior-term course completion clears this term's blocking learning
step. A failed quiz hands over the full answer key and takes an immediate resubmission, so a
`Training.status = COMPLETE` row can certify competence nobody demonstrated. An unkeyed quiz blocks a
gate that cannot be passed. The application's stated four-shift eligibility minimum is not enforced
anywhere. A `.txt` file was accepted as a cover letter, and the same unset `acceptedTypes` field
short-circuited the *server-side* allow-list check, not just the client hint. The gate releases at 4
of 5 while telling the volunteer it needs 5.

These are UX findings, filed from the outside, but four of the six are really integrity defects that
happen to be visible from a browser. They are worth reading alongside the correctness audits rather
than as polish.

### 5. The confirm gate is on the lighter action

**R37, R65, R82.** "Request drop" affects only you and takes two clicks; "Request swap" reassigns a
colleague's Saturday and emails three people, and takes one. "Unpublish" takes two clicks;
"Publish", which exposes a possibly unfinished schedule to a whole department, takes one. Every
destructive `ConfirmButton` in the learning and volunteers modules names its consequence except the
one that wipes a learner's completion, which says "Confirm?". The `ConfirmButton` primitive exists
and is used correctly nearly everywhere; the failures are all about *which* action got it.

### 6. The app has the data and does not show it

**R14, R33, R34, R36, R41, R47, R53, R64, R66.** `CourseProgress.completedAt` is stamped and never
selected. `pendingReq.createdAt` is in scope two lines above where it would be rendered.
`requestApproverRecipients` resolves the exact approver list to email them and the requester is never
told who they are. `requireModuleAccess` returns a session that `/schedule/full` throws away, which
is the only reason you cannot find your own name on it. `TechRequestListRow` carries `priority`, the
filter bar filters on it, the detail page sets it, and the triage table does not show it. In almost
every case the fix is to render a value that has already been fetched.

### 7. Defaults that answer on the user's behalf

**R10, R45.** The incident form ships with "No" pre-checked on the question that decides whether a
report is flagged as an immediate risk, and the flag is read as `=== "yes"`, so silence reads as
"routine". The training intake ships `minShiftsWanted` defaulted to "4", which is persisted as a
stated preference and rendered to schedulers as "Wants 4+ shifts this term" for people who never saw
the field. Both defaults are invisible, both are load-bearing downstream, and in both cases the
honest value is null.

### 8. One feature rendered on two disconnected pages

**R60, R69, R70, R71, R73.** The onboarding contract has a per-cycle editor and a master-template
editor that share a component and a setting and link to neither. Subcommittees are a recruitment
concept with a CRUD page in Admin. Campaigns and Templates are full features registered in no nav
array, and therefore invisible to the command palette built specifically to find pages like them.
Three unrelated surfaces are named "Notifications". The cycle emails pages fall out of the breadcrumb
system their siblings all use.

This is the admin module's structural signature: nav that mirrors the database schema rather than the
workflow. It is worth checking against the pending nav IA program (stages 3 and 4) before shipping
any of it, though the tier-2 sweep judged these to be about missing entries and cross-links rather
than about the top-nav mechanism that program owns.

---

## What works well

Recorded deliberately, so the fixes above do not accidentally undo it. Several findings are about
the *absence* of something that already exists three screens away, which is only visible because
these are good.

**The apply wizard.** Its own Back button preserves every answer, and the review step's per-section
Edit links return to Review rather than dumping the applicant back into the linear flow. Draft
autosave is real and visible ("Saved" under the step heading), and every one of the fixture draft's
ten answers came back prefilled. Conditional questions expand inline with no reload, and department
supplement sections appear and disappear correctly. The review step lists every section with its
answers and states what happens after submit; it is the strongest screen in either applicant journey.
The post-submission status tracker (Submitted, In review, Interview, Decision) is clear. The
magic-link sign-in confirms the address before signing anyone in and states the 30-minute expiry.

**The onboarding gate's mechanics.** Saving the profile step redirects back to the checklist, the row
flips to a green "Done" badge, and the counter advances, which is a clear confirmation with no banner
needed. Every step page carries "Back to checklist" and a live "N of 5 complete" readout. The gate is
honest that steps can be done in any order. Completed and pending steps are visually distinct without
relying on colour alone. There is a "Wrong account? Sign out" escape, which matters because SSO can
land the wrong identity on a page with no navigation.

**The HIPAA panel's parsing.** It reads the completion date out of the PDF and shows what it read
("Detected completion date: Jun 29, 2026"), which is genuinely more than the volunteer could supply
themselves. The certificate rejection preserved scroll position, so the error banner was in the
viewport rather than a thousand pixels above the fold.

**The quiz failure path itself.** Failing produced a clear result card, scrolled the learner back to
the top to see it, moved focus to the score heading, and marked every question inline. The attempt
budget is visible before the first submit and updates after each one. R20 and R21 are about what
happens around this, not about the result card. The zero-question guard already exists and reads
well; R6 is asking for that exact card to also cover the unkeyed case, not for new copy. The
pre-window training notice answers the three questions a volunteer would have; R43 is only about
getting them there without a dead-end click. Progress in the SCORM player really does persist; R44 is
about saying so. The onboarding player correctly hides the app shell, so no tab can eject a gated
learner.

**Prior iteration is visible in the admin and support modules.** The Epic request tabs, the campaign
review flow, and the roster panel all carry the marks of real bugs already fixed: double-send guards,
arm-then-confirm on bulk email, a dirty-form guard remounted on `updatedAt` to fix a stale-guard bug,
chronological sort fixes, last-admin protection, director-shift guards before removal. The tier-2
sweeps found fewer findings in those files than elsewhere, and that is why.

**`/incidents/mine`'s empty state** is the one the other two should copy (R74), and `CertificateViewer`
closing its modal and calling `router.refresh()` on success is the right pattern for a table-row
confirmation.

---

## Provenance

Assembled 2026-07-29 from eight working fragments produced by eleven audit tasks between 2026-07-28
and 2026-07-29. The fragments were removed in the same commit that added this document, so this file
is the single record; nothing load-bearing from them was dropped in the assembly.





