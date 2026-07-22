# ITCM term Epic batch roll-up

Date: 2026-07-22

## Problem

After a term's onboarding forms are collected, ITCM has to work out by hand who
needs an Epic account request sent to YNHH, and of which kind. Nothing in the app
produces that list.

Today the only automatic source is `promotion.ts`: when a contract is promoted and
`contract.epicNeeded && !person.epicId`, it raises one `PENDING` `EpicRequest` of
kind `NEW`. That covers first-time members with no Epic account and nobody else:

- A **returning member** who already has an Epic ID gets no request at all, so
  nothing renews their access for the new term.
- A member **switching departments** gets no request, so their Epic access is
  never modified to match the new department.
- Members who join the roster through `copyRosterFromTerm`, the Airtable importer,
  or a manual roster add never pass through `promotion.ts` at all, so they are
  invisible to the only automatic path.

The `/support/epic` **Pending** tab (`listPendingEpicRequests`, `itcm.ts:715`)
shows whatever requests happened to be raised, as a flat chronological list. It is
not grouped by kind, not scoped to a term, and its single "Create YNHH ticket"
button will bundle a `NEW` and a `RENEW` into one ticket even though YNHH uses
different forms and different cover emails per kind.

Nothing anywhere checks onboarding clearance before an Epic account is requested.
`loadClearanceMap` (`src/modules/onboarding/services/clearance.ts`) already computes
per-person semester clearance in one batched call, but `/support/epic` does not read
it. The only pre-submit guards are `Person.status === "ACTIVE"` and the
epicId-presence checks.

## Goal

Give ITCM one screen that, for a chosen term, lists every roster member who needs
an Epic request, split into **NEW**, **MODIFY**, and **RENEW**, each group
submittable as a single YNHH batch that produces the service-request PDF, the bulk
spreadsheet, and the cover email. Every row carries the person's onboarding
clearance so nobody is activated before they have completed onboarding.

## Approach

Derive the classification live from the roster on every page load; materialize
`EpicRequest` rows only when ITCM submits a batch.

Rejected alternative: writing a request row per person up front (extending
`promotion.ts` to raise RENEW/MODIFY plus a sweep for roster carry-forwards). Rows
stamped once go stale — a later department change or a manually entered `epicId`
leaves the wrong kind sitting in the queue — so it needs a reconcile sweep anyway,
and it requires a backfill for members already on the roster.

Deriving live needs no migration and no backfill, and the kind is always current: if
someone switches department the day before submission they move from RENEW to
MODIFY on their own.

## Placement

A new **"Term batch"** tab on `/support/epic`, added to the existing `Tab` union in
`src/modules/support/components/epic-request-tabs.tsx` alongside `generate`,
`pending`, `tracker`, and `history`. The existing Pending tab stays as it is.

The tab targets a **selectable term, defaulting to the ACTIVE term**. Ops run the
next term ahead of the active-term flip and YNHH turnaround is measured in business
days, so ITCM must be able to prepare a batch before the target term goes active.

## Data model

No schema changes. Everything is derived from existing tables:
`TermMembership`, `Person.epicId`, `Department.requiresEpicDirector` /
`requiresEpicVolunteer`, `OnboardingContract.epicNeeded`, `EpicRequest`, and the
clearance inputs `loadClearanceMap` already reads.

## Classification

New file `src/modules/support/services/epic-rollup.ts`. The decision logic is pure
and separated from the IO so it can be unit-tested without a database.

### Does this person need Epic?

Per ACTIVE `TermMembership` in the target term, resolve the department requirement
with the existing helpers in
`src/modules/recruitment/contract/epic-requirement.ts`:

- `epicRequirementFor(department, membership.kind)` → `ALL` | `SOME` | `NONE`.
- `ALL` → needs Epic.
- `NONE` → contributes nothing.
- `SOME` → needs Epic when the person's `PROMOTED` `OnboardingContract` for this
  term set `epicNeeded`, **or** the person already has an `epicId`.

A person needs Epic if any of their memberships resolves to yes. A person whose only
signals are `SOME` with no contract and no `epicId` is **undecided**: they still
appear in the roll-up, in the NEW group, marked `optional` and unchecked by default.
By definition they have no `epicId`, so NEW is always their derived kind. This exists
so a carried-forward roster member in a `SOME` department is never silently dropped.

A person whose memberships all resolve to `NONE` does not appear in the roll-up.

### Which kind?

`classifyEpicKind` is pure, taking the person's `epicId`, their target-term
department ids, and their prior-term department ids:

| Condition | Kind |
| --- | --- |
| No `epicId` | `NEW` |
| Has `epicId`, no prior HAVEN term | `MODIFY` |
| Has `epicId`, holds a membership in a department they did not hold in their prior term | `MODIFY` |
| Has `epicId`, same department set as their prior term | `RENEW` |

"Prior term" is the most recent `Term` by `startDate` strictly before the target
term's `startDate` in which the person held an ACTIVE `TermMembership`.

The no-prior-term-but-has-epicId case is `MODIFY` because such a person has a YNHH
Epic account that needs the `YM HAVEN FREE CLINIC` department added — which is
exactly what the existing `bulk_mod` cover email describes ("They already have an
Epic account, but need access to the department YM HAVEN FREE CLINIC").

Comparison is on department ids only, not on `kind` (DIRECTOR vs VOLUNTEER). A
volunteer promoted to director in the same department is a RENEW; if ops later want
a role change to force MODIFY, that is a one-line change to the pure function.

### Overrides on the derived kind

- **Explicit kind wins.** A person with an open `PENDING`, un-ticketed `EpicRequest`
  whose `techRequestId` is set was given that kind deliberately by a human working a
  support ticket. That request's kind places the row, and the row is marked
  *from ticket #N*.
- **Already in flight.** A person with a `SUBMITTED` request (already on a ticket)
  appears in their group as read-only, marked with the ticket, and cannot be
  selected. This prevents a second submission for someone already sent to YNHH.
- **Adopted.** A person with an open `PENDING`, un-ticketed request that has no
  `techRequestId` (promotion's row) is selectable and marked *queued*; submitting
  adopts that row rather than creating a second one.
- **Open deactivation.** `DEACTIVATE` never places a row — it has its own pipeline
  and no group here. But a person on the roster with an open `DEACTIVATE` request is
  a contradiction (being revoked and granted at once) and would in any case hit the
  different-kind conflict at submit, so they get `blockedReason: "has an open
  deactivation request"` and render unselectable in their derived group.

### Loader

```ts
export type EpicRollupRow = {
  personId: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  epicId: string | null;
  /** Target-term departments, for display: "SRR", "SRR -> JCTP" for a MODIFY. */
  departments: { id: string; name: string; kind: Track }[];
  priorDepartments: { id: string; name: string }[];
  kind: EpicRequestKind;           // NEW | MODIFY | RENEW
  kindSource: "derived" | "ticket";
  /** SOME-department member with no contract signal and no epicId. */
  optional: boolean;
  clearance: ClearanceSummary;     // from loadClearanceMap
  /** Set when the person already has an open request. */
  existingRequest: {
    id: string;
    status: "PENDING" | "SUBMITTED";
    ticketId: string | null;
    techRequestNumber: number | null;
  } | null;
  /** Non-null when the row cannot be submitted at all, with the reason. */
  blockedReason: string | null;
};

export type EpicRollup = {
  term: { id: string; code: string; name: string; endDate: Date };
  groups: Record<"NEW" | "MODIFY" | "RENEW", EpicRollupRow[]>;
};

export async function loadTermEpicRollup(termId: string): Promise<EpicRollup>;
```

All IO is batched: one membership query for the target term, one for candidate prior
terms, one department query, one contract query, one open-`EpicRequest` query, one
`loadClearanceMap` call. Rows sort by name within each group.

## Clearance

Each row shows the result of `loadClearanceMap(personIds, termId)`.

**Warn only; never block.** A row that is `cleared` is checked by default. A row that
is not fully cleared shows an amber chip listing the missing task keys and starts
unchecked, so submitting one is a deliberate act by the ITCM director. The server does
not reject an uncleared person.

The existing hard invariants stay hard, because they are data integrity rather than
policy, and the service layer already enforces them:

- the person must be `ACTIVE` (`Person.status`);
- `NEW` requires no `epicId`;
- `MODIFY` and `RENEW` require an `epicId`.

A row violating one of these gets `blockedReason` set and renders unselectable with
the reason shown, so the batch is never rejected wholesale at submit time for a
condition the screen could have shown up front.

## Submit

One submit control per group, with a shared authorizer picker (`listEpicAuthorizers`,
already the current term's ITCM directors) and an access end date defaulting to the
target term's `endDate`.

Group to request type:

| Group | n = 1 | n > 1 |
| --- | --- | --- |
| NEW | `new_individual` | `bulk_new` |
| MODIFY | `mod_individual` | `bulk_mod` |
| RENEW | `renew_individual` | `bulk_renew` |

Submitting POSTs to the existing `/api/support/epic/generate` with the selected
person ids, the authorizer, the end date, and the target `termId`. The response is
unchanged: base64 PDF, base64 XLSX, and the cover email draft, which the tab renders
with the same download and copy affordances the Generate tab uses.

### Change 1: `bulk_renew` request type, and `bulk_mod` re-mapped to MODIFY

`bulk_mod` is currently labelled "Modify / Renew - Bulk" and `route.ts:433` maps it
to `EpicRequestKind.RENEW`, so a modify batch is recorded as a renewal today. For the
three groups to track honestly:

- Add `bulk_renew` to `RequestType` in `src/modules/support/services/itcm-pdf.ts`,
  with a `SECTION_IX` entry (same wording as `bulk_mod`; both are MOD/REACT requests),
  a `PDF_FILENAMES` entry reusing the `MOD_REACT ... Multiple Users` filename, an
  `EMAIL_BODIES` entry with the renew-flavoured bulk text, a `REQUEST_TYPE_LABELS`
  entry ("Renew - Bulk"), and an `EMAIL_SUBJECTS` entry in
  `epic-request-form.tsx`. It maps to kind `RENEW`.
- Re-point `bulk_mod` to kind `MODIFY` and relabel it "Modify - Bulk".

`isNew` and `isDeactivate` in `itcm-pdf.ts` need no change: `bulk_renew` is neither,
so it takes the same PDF branches `bulk_mod` does today.

This is a deliberate behaviour change to the Generate tab: its single "Modify /
Renew - Bulk" option becomes two, and a batch submitted through the modify option is
now tracked as `MODIFY` rather than `RENEW`. The generated PDF is unchanged in both
cases; only the cover email wording and the recorded kind differ.

### Change 2: `submitEpicRequests` adopts instead of conflicting

`submitEpicRequests` (`itcm.ts:624`) currently throws `SupportConflictError` for any
person with an open `PENDING`/`SUBMITTED` request. Promotion's `PENDING NEW` rows
therefore make a submit skip tracking and return a `trackingWarning`, leaving the
original row orphaned as PENDING while the batch goes to YNHH untracked.

Change it to adopt, mirroring what `reconcileDeactivationRequests` already does on
the DEACTIVATE path. Inside the existing transaction, per person:

- An open `PENDING` request with `ticketId: null` **and the same kind** is claimed
  onto the new ticket via an atomic
  `updateMany({ where: { id, status: "PENDING", ticketId: null }, data: { status: "SUBMITTED", ticketId } })`.
  A claim matching zero rows means a concurrent submit won; throw
  `SupportStateError("...refresh and try again")` and roll back.
- An open request with a **different kind**, or one already `SUBMITTED` onto a
  ticket, still raises `SupportConflictError` naming the person.
- A person with no open request gets a new `SUBMITTED` request as today.

The existing person-level validation (ACTIVE, NEW ↔ no `epicId`, MODIFY/RENEW ↔
`epicId`) is unchanged and still runs before any write.

This fixes the orphan for the Generate tab as well, and is what lets both surfaces
share one code path.

### Change 3: optional `termId` on the generate route

`/api/support/epic/generate` resolves the term with `getActiveTerm()` for its
membership lookup and its `findMirrorPerson` calls. Accept an optional `termId` in
the POST body, defaulting to the active term when absent, and pass it to
`findMirrorPerson` (which already takes a `termId` option) and to the membership
query. Authorizers continue to resolve from the current term's ITCM directors
regardless of the target term, since the person signing the form is whoever is in
the ITCM director seat now.

## Two queues coexisting

The Pending tab stays, so a promotion-origin `PENDING` row is visible in both places.
Safety comes from the atomic claim in Change 2: whichever surface submits second
matches zero rows and gets "already submitted, refresh", never a duplicate ticket or
a re-pointed request. The Term batch tab marks adopted rows as *queued* so it is
visible why a row appears on both screens.

## Permissions

`support.manage_requests`, the same gate the rest of `/support/epic` uses. The page
already calls `requirePermission("support.manage_requests")`; the new tab inherits it,
and the generate route's own `can()` check is unchanged.

## Testing

**Pure unit tests** (`epic-rollup.test.ts`, no database) for `classifyEpicKind` and
the needs-Epic resolution:

- no `epicId` → NEW;
- `epicId` + no prior term → MODIFY;
- `epicId` + department added → MODIFY;
- `epicId` + department dropped → MODIFY;
- `epicId` + department swapped → MODIFY;
- `epicId` + identical departments → RENEW;
- `epicId` + same department, VOLUNTEER → DIRECTOR → RENEW;
- `ALL` department → needs Epic;
- `NONE` department → excluded;
- `SOME` + contract `epicNeeded` → needs Epic, not optional;
- `SOME` + existing `epicId` → needs Epic, not optional;
- `SOME` + neither → appears in NEW, `optional: true`;
- multi-department member where one department is `NONE` and one is `ALL` → included.

**Loader tests** against the throwaway pg on :5434: a NONE-department member never
appears; a member with a `SUBMITTED` request is present but `blockedReason`-free and
unselectable via `existingRequest.status`; a ticket-origin `PENDING MODIFY` for
someone whose derived kind is RENEW lands in the MODIFY group with
`kindSource: "ticket"`; prior-term resolution picks the most recent prior term, not
the oldest.

**Adoption service tests** for the changed `submitEpicRequests`: adopts a same-kind
un-ticketed PENDING row (asserting the row's id is reused, not duplicated); conflicts
on a different-kind open row; conflicts on an already-ticketed SUBMITTED row; a
concurrent double-submit leaves exactly one ticket and the loser throws.

**Route test** that `bulk_mod` now records `MODIFY` and `bulk_renew` records `RENEW`.

Run `npm run lint` over the whole repo before pushing, per the repo's pre-push
convention.

## Out of scope

- Epic account expiry dates. `Person` stores no expiry, and
  `OnboardingContract.epicIdExpiration` is collected but never carried to `Person`.
  Renewal here is term-driven: every returning member renews each term.
- DEACTIVATE. It keeps its existing dedicated pipeline
  (`listPendingDeactivations` / `reconcileDeactivationRequests`) and does not appear
  in the roll-up.
- Emailing YNHH from the app. The cover email stays a draft the ITCM director sends
  themselves, as today.
- Merging or retiring the Pending tab.
