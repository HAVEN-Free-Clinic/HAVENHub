# Epic access pipeline: an honest request, and a batch that closes (2026-09-22)

## Problem

The Epic pipeline can generate a request beautifully and then lose track of it completely.

Three facts, each verifiable in the code today:

**`SUBMITTED` does not mean submitted.** `epic.ts:585` says so outright: *"the YNHH email is sent
manually, so 'SUBMITTED' only records intent to submit."* The status flips the instant
`/api/support/epic/generate` returns a PDF. The admin's browser downloads two files and renders a
copyable email body next to the static text `To: helpdesk@ynhh.org`. Whether that mail ever leaves
is outside the system. A batch that was generated and forgotten is byte-for-byte indistinguishable
from one YNHH is actively working: both read SUBMITTED, both leave the Pending tab, both start a
days-open counter, and both drive their linked `TechRequest` to `AWAITING_YNHH`.

**Nothing chases anything.** No cron touches `EpicRequest` or `YnhhTicket`. The entire aging
apparatus is a client-side span that turns red past five business days
(`epic-request-tabs.tsx:335`) on a tab nobody has a reason to open.

**The return has no vocabulary.** `completeRequest` has two exits, COMPLETED and CANCELLED. YNHH
routinely comes back partial: some accounts created, one name mismatched, one already existing
under a different ID. The only way to record a refusal today is to cancel the request, which
discards the reason and makes YNHH's decision look like our own withdrawal.

Around those three, a fourth: closing the loop with the member is entirely manual. When a batch of
sixty comes back, an admin types sixty Epic IDs into sixty inputs, then clicks sixty arm-and-confirm
email buttons. Nothing records that a member was told, so nothing can notice when one was not.

This spec makes the request honest and the batch closeable.

## Scope

Two halves of one pipeline, specified together because the second depends on the first.

**Making the request honest.** `sentAt` on the batch, access dates persisted on the request, the
`REJECTED` outcome, the invisible-deactivation fix, and the cron that chases all of it.

**Closing a returned batch.** A dedicated batch page: upload the sheet YNHH returned, reconcile it
against what was asked, complete in bulk, and email the members in bulk with a compliance soft
block.

Not in scope, and each named again at the end with its reasoning: sending to YNHH from the Hub,
the Intercom Epic handoff, and any change to the outgoing spreadsheet's columns.

## The send gap, and what we are doing about it

The right fix is for the Hub to send the YNHH email itself. It is not the fix in this spec.

`EmailLog` has no attachment support: the model carries `toEmail`, `subject`, `html` and sender
fields, and the transport interface takes an `EmailMessage` with no attachment channel. Every
outbound path in the app is body-only. Adding attachments means schema work, transport work across
Graph and Maileroo, and a size-limit and retention story for binaries that currently live only in
the admin's Downloads folder. That is a subsystem, and bundling it here would sink the batch work
behind it.

So the interim is an explicit acknowledgement:

```prisma
model YnhhTicket {
  /// When an admin confirmed they sent this batch to YNHH. Null means the
  /// artifacts were generated but the email may never have left: the send is a
  /// manual copy-paste, so this is the only signal that distinguishes a batch
  /// YNHH is working from one that was generated and forgotten.
  sentAt    DateTime?
  sentById  String?
}
```

Two consequences make this more than bookkeeping.

The days-open counter moves to count from `sentAt`, not `submittedAt`. Days since we generated a
PDF is not a number anyone should act on; days since YNHH received it is.

A batch with no `sentAt` after a day becomes the cron's first check. The failure this spec is most
concerned with, generated and forgotten, is precisely the one that was previously unobservable and
now has a name and a nag.

The upgrade path stays open: when `EmailLog` learns attachments, `markBatchSent` becomes the
fallback rather than the norm, and nothing else in this design changes.

## Data model

Additive only. No backfill.

```prisma
model EpicRequest {
  /// What we asked YNHH for, persisted rather than only printed. The end date
  /// reaches the PDF, the spreadsheet and the cover email today and is then
  /// discarded, so the system cannot answer "whose Epic access expires this
  /// month" and has to infer renewals from roster diffs instead.
  accessStartDate     DateTime?
  accessEndDate       DateTime?

  /// Why YNHH refused, or any note recorded at resolution. Paired with
  /// REJECTED; a cancellation writes no note today and the reason is lost.
  outcomeNote         String?

  /// When the member was told their account is ready, and with which of the
  /// three Epic templates. Null on a COMPLETED request is a real defect the
  /// cron reports: the account exists and nobody told them.
  memberEmailedAt     DateTime?
  memberEmailTemplate String?
}

enum EpicRequestStatus {
  PENDING
  SUBMITTED
  COMPLETED
  REJECTED   // new
  CANCELLED
}
```

`REJECTED` is additive to the enum, the same shape of migration that added `DEACTIVATE` to
`EpicRequestKind`. It is distinct from `CANCELLED` and the distinction is the point: CANCELLED
means we withdrew the request, REJECTED means YNHH declined it. Conflating them, which is what the
code forces today, means a person's history cannot tell you whether to re-raise.

Three call sites have to learn the new value, and missing any one of them is the likely bug:

- `closeTicket` refuses to close while any request is `PENDING` or `SUBMITTED`. REJECTED is
  resolved, so a batch with a refusal in it must still be closeable.
- `onEpicResolved(actor, requestId, outcome)` takes `"COMPLETED" | "CANCELLED"`. It gains
  `"REJECTED"`, and its "no sibling still SUBMITTED" check counts REJECTED as settled.
- `epic-rollup-classify.ts` must not treat a REJECTED request as blocking a fresh one. This is a
  gain over today: a rejection preserves its reason and still unblocks re-raising.

## The batch stage is derived, never stored

`YnhhTicket.status` is `OPEN | CLOSED`. The temptation is to widen it to model SENT, ACKNOWLEDGED,
RETURNED. We are not doing that, because a stored status that a human must remember to advance is
exactly the failure this spec exists to fix. `SUBMITTED` is a stored status nobody advances, and it
lies.

Instead the stage is a pure function of facts that are written as a side effect of real work:

```
deriveBatchStage({ status, sentAt, serviceRequestNumber, requests }) -> BatchStage
```

| Stage | Condition | The single next action |
|---|---|---|
| `CLOSED` | `status === "CLOSED"` | none |
| `GENERATED` | `sentAt` null | Mark as sent to YNHH |
| `SENT` | `sentAt` set, no `serviceRequestNumber` | Record the RITM when it arrives |
| `ACKNOWLEDGED` | RITM set, every request still SUBMITTED | Upload the returned sheet |
| `RETURNED` | some requests resolved, some still SUBMITTED | Finish reconciling |
| `RECONCILED` | none SUBMITTED, some COMPLETED with `memberEmailedAt` null | Email the members |
| `DONE` | all resolved, all completed members emailed | Close the batch |

`CLOSED` is checked first so historical tickets, which will all have a null `sentAt`, render as
closed rather than as "never sent". That ordering is load-bearing and gets its own test.

This lives in `epic-batch-stage.ts` with no database access, mirroring the split
`epic-rollup-classify.ts` already established: pure classification in one file, the batched loader
in another.

## Reconciling the returned spreadsheet

YNHH returns the XLSX we sent, with the Epic ID column filled in.

### Matching

All of the parsing and matching risk lives in one pure module, `epic-return-match.ts`, which takes
parsed rows and the batch's requests and returns a decision without touching the database:

```ts
type MatchResult = {
  matched:   Array<{ requestId: string; epicId: string; via: "yaleId" | "email" | "name" }>;
  ambiguous: Array<{ row: SheetRow; candidates: BatchRequest[] }>;
  unmatched: SheetRow[];
  missing:   BatchRequest[];   // asked for, absent from the return
};
```

Matching is layered, in this order, on columns the sheet already carries: Yale University ID
(`netId`), then E-Mail Address, then normalised legal name. Reading is via `exceljs`, already a
dependency because it is what writes the sheet.

**We are not adding a correlation column to the outgoing sheet.** Embedding an `EpicRequest` id
would make matching trivial, and it is tempting. The outgoing document is YNHH's own
`Service Request Form_V5.5` template. An unexpected column risks a bounce from a process we do not
control and cannot test against, and a bounced batch costs more than a hand-resolved row. If YNHH
later confirms extra columns are ignored, adding one is a strictly additive change to this design.

### Applying

Nothing is written until the admin has seen the match. The review shows all four buckets, with
ambiguity and unmatched rows requiring an explicit decision rather than a guess.

`applyReturnedSheet` is **all-or-nothing per row, not per batch**. One unparseable Epic ID must not
roll back thirty-nine good completions. Each row is its own attempt with its own try/catch, and the
result reports per-row outcomes, following `attending-access.ts:268`'s sequential loop rather than
a single wrapping transaction.

Two refusals are stated rather than silently resolved:

- An Epic ID that already belongs to a different `Person` is refused for that row with a stated
  reason. Silently reassigning it would corrupt the mirror lookups that every future request in
  that department depends on.
- A request that is no longer SUBMITTED (cancelled while the sheet sat in someone's inbox) is
  skipped with a reason, never re-opened.

`completeRequest`'s existing discipline is preserved exactly: the atomic `updateMany` claim scoped
to PENDING/SUBMITTED, and the claim release when the `Person.epicId` write fails. That release
exists because the pre-audit-14 behaviour left COMPLETED requests whose person never got an ID and
which nothing could retry. Bulk application must not reintroduce it.

## Telling the members, in bulk

### Why `notify()` and not `queueEmails`

`queueEmails(db, template, inputs[], opts)` is the purpose-built chunked batch enqueue, and it is
the wrong tool here.

It writes an `EmailLog` row and nothing else. `notify()` additionally writes the `Notification`
inbox row and honours the admin-configured per-type channel routing, including the Teams path and
its fallback. `epic-activation` is registered with `defaultChannel: "email"`, but the routing is
admin-configurable at runtime and a bulk path that quietly ignores it would make the setting a lie
for the highest-volume send in the module.

So: a sequential `notify()` loop with per-row try/catch, copying `attending-access.ts` exactly.
Clinic batches run 60 to 150 people. `queueEmails` matters at thousands, and is named here as the
escape hatch if batch sizes ever justify trading the inbox row away.

The loop is sequential rather than `Promise.all` for the same reason `attending-access.ts` is:
concurrent writes against shared rows race, and a rollout that half-completes is worse than one
that takes four seconds.

### The result shape

```ts
type BulkEmailResult = {
  sent: number;
  skipped: Array<{ name: string; reason: string }>;
};
```

Skip reasons are member-specific and all of them are real: no `contactEmail` on file, already
emailed, request not COMPLETED. The skipped list is audited with the counts and surfaced in the
flash message, so an admin learns *who* did not get the mail rather than only how many.

This matters because the existing campaign machinery deliberately reports `excludedNoEmail` as a
bare count and never names anyone. That is the right call there, where naming would leak directory
existence to a delegated sender. It is the wrong call here: this is a `support.manage_requests`
holder acting on a roster they already see in full, and "three people did not get told" without
saying which three is not actionable.

### Double-send guard

An atomic `updateMany` scoped to `memberEmailedAt: null` claims the rows **before** any mail is
rendered or queued. A double-submitted form claims zero rows the second time and sends nothing.
This is the same claim-then-act shape `executeRun` uses for campaign dispatch and `completeRequest`
uses for its own status flip.

### Why this cannot be a campaign

Recorded because it will otherwise be re-proposed: campaign bodies are validated against exactly
two permitted variables, `firstName` and `name` (`campaigns/service.ts:664-682`). An Epic ID or a
temporary password cannot ride in one. The batch send must go through a registered descriptor, and
`epic-activation` already is one, with `epicActivationContext` and a `temporaryPassword` read from
settings at send time so IT can rotate it without a deploy.

## The compliance soft block

Gate: `cleared`, the full six-step bar (profile, HIPAA, volunteer training, director training,
learning, EHS), read once per batch through `loadClearanceMap(personIds, termId)` via the
`@/platform/clearance` facade. One call for the batch, never a per-person recompute.

The interaction is the house pattern, stated as policy in `term-batch-tab.tsx:12-16`: *"Clearance
is a warning, never a block."*

| Condition | Default | Marker | Selectable |
|---|---|---|---|
| `cleared` | checked | none | yes |
| not `cleared` | **unchecked** | `<Badge tone="warning">Missing: HIPAA, EHS</Badge>` | **yes** |
| no `contactEmail` | unchecked | `<Badge tone="critical">No email on file</Badge>` | **no** |

The third row is the one worth defending. `tone="critical"` and a disabled checkbox are reserved in
this codebase for genuine refusals, and the convention is consistent enough to rely on. A missing
HIPAA certificate is a judgement call an ITCM director is entitled to override; a person with no
email address cannot be sent an email by anyone, at any time, for any reason. Rendering those two
the same way would teach admins to ignore the critical badge.

## The cron that does not exist

`/api/cron/epic`, the first scheduled job in the application to touch Epic at all. It computes a
digest and delivers it to the current ITCM directors through `notify()`.

| Check | Threshold | Catches |
|---|---|---|
| Generated, never marked sent | 24h | the batch that was forgotten |
| Sent, no RITM recorded | 48h | YNHH never acknowledged |
| Open batch, no movement | 5 business days | the stall the red span was meant to catch |
| COMPLETED, `memberEmailedAt` null | 24h | account exists, member not told |
| PENDING request, no ticket | 7 days | promotion and attach rows aging in the queue |
| `accessEndDate` approaching | 30 days | renewals, from expiry rather than roster diff |
| PENDING DEACTIVATE, person ACTIVE again | any | **visible on no surface today** |

That last row is a live invisibility bug, not a new feature. `listPendingEpicRequests` filters
`kind: { not: "DEACTIVATE" }` and `listPendingDeactivations` filters `person.status != ACTIVE`, so
a pending deactivation for someone who has been reactivated appears in neither, cannot be
cancelled, and still counts against the one-open-request-per-person guard. This is the identical
shape of the bug the comment at `itcm.ts:1019-1025` records having already shipped once for
promotion rows, where it *"deadlock[ed] Epic provisioning for new members."* The cron reports it and
the Pending tab gains a third bucket with the inline fix.

Two operational requirements, both from things that have gone wrong here before:

- Register a `cron.lastSuccess.epic` heartbeat in the `Setting` table, the fastest liveness check
  the platform has.
- **Verify after deploy that the schedule was actually provisioned.** Cron schedules here are
  hand-provisioned externally and drift from the docs; a prior audit found six of ten had never
  run. A cron that is specified, merged, and never scheduled is worse than no cron, because the
  digest's absence reads as "nothing to report."

Auth follows the existing routes: bearer token with `timingSafeEqual`, and each check wrapped so
one failure cannot take down the others or the heartbeat.

## Surfaces

**`/support/epic/batch/[ticketId]`**, new, gated on `support.manage_requests`. Laid out by stage,
leading with the single next action from the table above. Holds the sent acknowledgement, the RITM
field, the upload and match review, the reconcile table, and the member-email section.

**The Tracker tab** becomes an index. Each row keeps its summary and days-open (now counted from
`sentAt`) and links into the batch page. The per-request controls that make it dense today move to
the batch page, where they have room.

**The generate result panel** gains the sent acknowledgement inline, so marking a batch sent is one
click in the flow rather than a separate trip. This is the difference between a step people take
and a step people skip.

**The Pending tab** gains the reactivated-deactivation bucket described above.

## Folded-in review findings

Fifteen findings from the review of #941 land here rather than in a separate pass, because several
are the same code this spec rewrites.

Load-bearing:

- **The start date is inert.** It is collected into React state and rendered and never sent: not in
  the `runEpicGeneration` payload, not in the route's destructure, not on the PDF. It gains a real
  home, `Text75` (the PDF's "New Hire start date", hardcoded to `today` at `itcm-pdf.ts:325`) and
  the spreadsheet's Start Date column, and persists as `accessStartDate`.
- **Prefilling the end date breaks deactivations.** That field doubles as the effective
  deactivation date; defaulting it to the term end dates a mid-term offboarding months out, and
  kills the `if (!endDate)` guard that forced a deliberate choice. Never prefilled for deactivate
  types.
- **The person picker widened to the wrong term.** It unions the *previous* term; the people
  actually missing are the incoming class, whose memberships sit on the *next* (PLANNING) term.
  Scope becomes live plus next plus previous, with a term badge on anyone outside the live roster,
  and a rank-based dedup so a member promoted this term is never listed under a stale role.

The rest, folded without ceremony: the ordering key on the dedup query, per-department duplicate
listing for anyone who changed departments, blank mirror fields for non-live-term people, two
inputs sharing one `Field` label, the dead `placeholder` on a date input, missing range validation,
the fourth hand-rolled copy of `isoDateKey`, the narrowed `select` on a loader the page already
documents as too large, and three docstrings describing pre-#941 behaviour.

## Error handling

| Failure | Behaviour |
|---|---|
| Sheet will not parse | Named error, nothing written |
| Row matches nobody | Shown for manual resolution, never auto-applied |
| Row matches two people | Surfaced as ambiguous, requires an explicit pick |
| Epic ID belongs to someone else | That row refused with a stated reason |
| Request no longer SUBMITTED | Skipped with a reason, never re-opened |
| One row fails during apply | That row only; the rest commit |
| `Person.epicId` write fails | Existing claim-release preserved |
| Member has no email | Critical badge, checkbox disabled, counted and named |
| Cron check throws | Wrapped; siblings and the heartbeat still run |

## Testing

Pure modules carry the load, which is why the risky logic was put in them.

- `epic-batch-stage.ts`: every stage, and specifically that CLOSED short-circuits a null `sentAt`.
- `epic-return-match.ts`: match by each of the three keys, near-miss names, ambiguity, rows in the
  sheet with no request, requests with no row.
- `epic-batch.ts` against the test database: per-row isolation on apply, the Epic ID conflict
  refusal, the double-send claim, every skip reason.
- The `REJECTED` call sites: `closeTicket` closes over a rejection, `onEpicResolved` settles,
  rollup does not block a re-raise.
- e2e for the batch page, since server-rendering is the only thing e2e really guards here.

Test database notes that apply: Postgres on 5434 with a per-worktree `TEST_DATABASE_URL`, and the
full lint run before pushing, since typecheck and tests both miss the eslint boundary rules.

## Migration

Additive columns, one additive enum value, no backfill. Existing rows take nulls and the derived
stage handles them correctly because CLOSED is checked first.

Two standing hazards apply. `prisma migrate dev` folds pre-existing drift into a new migration, so
the generated SQL needs trimming to just these changes before commit. And rewriting or squashing a
migration on an open PR breaks the Neon preview database with `P3018 / 42P07`, so once this is
pushed the migration file is immutable and a correction ships as a new migration.

## Out of scope

**Sending the YNHH email from the Hub.** The real fix for the send gap. Blocked on `EmailLog`
attachment support, which is a subsystem. `sentAt` is the honest interim and the upgrade path is
unchanged by anything here.

**The Intercom Epic handoff.** An Epic ask raised in chat never becomes an `EpicRequest`, by design,
because the intake needs a government ID and a date of birth and none of it may be collected in
chat. Six verified gaps remain open, including that Fin has no Epic tool at all and so can tell a
member they are "cleared to work at clinic this term" when they have no Epic account. Its own spec.

**The outgoing spreadsheet's columns.** Reasoning under Matching, above.

**A DB constraint for one-open-request-per-person.** Acknowledged at `epic.ts:130-132` as a
find-then-create with no backstop. Unchanged here; at clinic scale a manager cancels the duplicate,
and a partial unique index is a separate, riskier migration.
