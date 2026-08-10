# Recruitment onboarding: bulk actions

Date: 2026-08-07

## Problem

`/recruitment/cycles/[id]/onboarding` is where SRR turns accepted applicants into
roster members. It already has a shape of multi-select, but a shape that fights
the job:

- Two separate forms on one page. A checkbox column at the top feeds "Send /
  resend onboarding links". A second, duplicated list at the bottom feeds
  "Promote selected". The same person appears twice, in two different widgets,
  depending on what you want to do to them.
- No select-all, no counter, no range select. A cycle with 80 acceptances means
  80 individual clicks to send a first round of links.
- No filtering and no search. Finding "everyone in PCAR who has submitted" is a
  visual scan of the whole table.
- Withdraw is one row at a time only, so clearing a batch of stale links is a
  click, a confirm, a full page navigation, repeated per row.
- `EXPIRED` is invisible. `isContractExpired` exists in the service and is
  enforced on the applicant side, but the admin table renders an expired link
  identically to a fresh one, as "Sent". The single most actionable state on the
  page cannot be seen, let alone filtered for.

## Goals

- One table. Select rows once, then choose an action.
- Send links, Promote, and Withdraw all available in bulk from that selection.
- Filter by status and department, and search by name, then act on the result.
- Selection ergonomics: select-all, indeterminate header state, shift-click
  ranges, a live count, and a clear control.
- Surface `EXPIRED` as a first-class status.

## Non-goals

- **Column sorting.** Not asked for, and filtering plus search covers the
  retrieval need.
- **Pagination.** A cycle is low hundreds of acceptances. Worth revisiting past
  roughly 500 rows, where shipping every row to the client starts to cost.
- **Bulk actions on other recruitment pages.** Decisions and Waitlist have their
  own flows and their own risks.
- **Undo for withdraw.** Withdraw hard-deletes the contract row and its blobs.
  Making it reversible is a different, larger change (soft delete plus a
  retention policy).

## Design

### Row model

The page derives one flat row per acceptance, entirely on the server:

```ts
type OnboardingRowState =
  | "NO_CONTRACT"  // accepted, never sent
  | "SENT"         // PENDING, link live
  | "EXPIRED"      // PENDING, expiresAt in the past
  | "SUBMITTED"    // applicant completed it, ready to promote
  | "PROMOTED"     // on the roster
  | "CONFLICT"     // accepted by more than one department

type OnboardingRow = {
  acceptanceId: string
  contractId: string | null
  firstName: string
  lastName: string
  departmentCode: string
  state: OnboardingRowState
  onRoster: boolean
  customAnswers: { label: string; value: string }[]
}
```

`CONFLICT` takes precedence over any contract state, matching what the page does
today: a conflicted acceptance cannot be onboarded or promoted regardless of
where its contract got to.

Two pieces of logic move out of the page and into pure, unit-tested helpers:

- **State derivation**, including the expiry comparison. This must happen in the
  server loader and never in client render, because `Date.now()` in render
  violates the lint purity rule and would make the component non-deterministic.
- **Custom answer resolution**, currently a 30-line IIFE embedded in JSX. It
  resolves each answer key against the contract's frozen `templateSnapshot` so
  that internal `confirm__<agreementId>` keys and stale answers are dropped. That
  logic is worth testing and is not worth reading inside a table cell.

### Data projection

`listOnboarding` returns `contract: true`, the entire `OnboardingContract` row.
Today that is safe: the page is a server component, so it never leaves the
server.

Moving the table to a client component changes that. `OnboardingContract` carries
`token` (a standing credential: whoever holds it can submit onboarding as that
applicant), plus `dateOfBirth`, `phone`, signature records, and HIPAA file
metadata. Passing rows straight through would serialize all of it into the RSC
payload and ship it to every browser that loads the page.

So the page projects to the narrow `OnboardingRow` above before crossing the
boundary. Nothing not listed in that type reaches the client.

### Table component

A single client component owning filter and selection state:

```
┌──────────────────────────────────────────────────────────────┐
│ [Search name…] [Status ▾] [Dept ▾]        7 selected · Clear │
│ [Send links (3)] [Promote (4)] [Withdraw (7)]                │
├──┬───────────────┬──────┬────────────────────────────────────┤
│▣ │ Applicant     │ Dept │ Status                             │
│☑ │ Ona Boarder   │ SRHD │ [Submitted]  View  Withdraw        │
│☑ │ Ray Chen      │ PCAR │ [Expired]    Withdraw              │
│  │ Sam Ortiz     │ SRHD │ [Conflict]                         │
└──┴───────────────┴──────┴────────────────────────────────────┘
```

State is `{ query, status, dept, selected }`. The department filter options are
derived from the rows themselves rather than the `Department` table, so the
control only ever offers departments actually present in this cycle.

Per-row actions (View, Withdraw) stay on the row. They are how you deal with one
person, and removing them to force everything through selection would be a
regression for the single-row case.

### Selection semantics

**Selectable rows are those any action can touch:** not `CONFLICT`, not
`PROMOTED`. A conflicted row is blocked upstream on the Decisions page; a
promoted row is on the roster and its reversal is offboarding, not withdrawal.
Neither renders a checkbox, so select-all can never pick up a row where every
action is a no-op.

**The checkboxes are the form inputs.** Each selected row contributes an
`acceptanceId` value directly, so there is no hidden-input mirror to keep in sync
with React state.

**Filtering prunes the selection to visible rows.** Select 40, then filter to
PCAR, and the selection becomes the PCAR subset. The alternative (retaining
hidden selections) means a Withdraw can destroy contracts the operator cannot
see at the moment they confirm. Scoping selection to what is on screen makes the
blast radius equal to the visible list, always.

The header checkbox reflects and controls the visible selectable set: checked
when all are selected, indeterminate when some are.

### Action bar and eligibility

Each action has its own eligibility predicate over the selection:

| Action | Eligible states |
|---|---|
| Send links | `NO_CONTRACT`, `SENT`, `EXPIRED` |
| Promote | `SUBMITTED` |
| Withdraw | `SENT`, `EXPIRED`, `SUBMITTED` |

Buttons show their own eligible count ("Promote (4)") and disable at zero. On a
mixed selection the action runs on the eligible subset and reports the rest, per
the agreed semantics: promoting a selection of 10 with 4 submitted promotes those
4 and says so.

The counts rendered on the buttons are advisory. The server recomputes
eligibility from the database and is the only authority. A stale page cannot talk
the server into promoting something that is not `SUBMITTED`.

**Withdraw is gated by the existing `ConfirmButton`** (two-click arm and confirm,
already used for the single-row withdraw) with a count-aware armed label:

> Withdraw 7? Deletes 4 submitted contracts + signatures

This spells out the irreversible part, because `withdrawContract` deletes the row
along with its signature blobs and HIPAA certificate.

### Server actions

All three take the same `acceptanceId[]` payload and resolve what they need from
the database. Unifying the payload on `acceptanceId` means the client never
computes or submits contract ids, and eligibility is decided in exactly one
place.

Every action already scopes its query to the cycle in the URL, which stays.

- `sendLinksAction`: unchanged in mechanism. The reporting changes, below.
- `promoteAction`: resolves the selected acceptances to their `SUBMITTED`
  contracts and calls the existing `promoteContracts`, which already refuses
  non-submitted and conflicted rows and counts them as skipped.
- `withdrawContractsAction`: new, replacing the single-contract action. Resolves
  the selection to non-`PROMOTED` contracts and loops the existing
  `withdrawContract`, counting withdrawn, skipped, and failed. The per-row
  Withdraw button submits a one-element selection to this same action.

### Messaging

Today `sendLinksAction` catches `ContractError` and counts it as `failed`, which
renders as a red error banner. Under bulk selection that is wrong: selecting a
promoted row and hitting Send is an ordinary, expected non-event, not a failure
demanding a retry.

So each action partitions into three buckets and words them differently:

- **acted on**: the work that happened.
- **not eligible**: expected, informational, no action needed.
- **failed**: an unexpected error. Still surfaced as an error, because a failure
  here means a person is absent from every roster for the term and someone has
  to retry.

All three keep redirecting with `?msg=` and `?err=`. Both params are already
registered in the toast flash registry scoped to `/recruitment/cycles/*/onboarding`
and pass their value through as the message, so no registry change is needed.

## Testing

- **Unit**: row state derivation (including the expiry boundary), custom answer
  resolution against a template snapshot, and the per-action eligibility
  predicates.
- **Component**: select-all across a filtered set, indeterminate header state,
  shift-click ranges, selection pruning when a filter changes, per-action counts,
  and the absence of checkboxes on `CONFLICT` and `PROMOTED` rows.
- **Action**: bulk withdraw, cycle scoping (an id from another cycle is ignored),
  and the three-way acted / not-eligible / failed reporting split.
- **E2E**: update `recruitment-onboarding.spec.ts` for the new markup.

## Pre-existing defect fixed here

`e2e/recruitment-onboarding.spec.ts:102` clicks
`button:has-text("Send onboarding links")`. Commit `735be20e` renamed that button
to "Send / resend onboarding links" and did not update the test, so the selector
cannot match. The test is rewritten against the new UI as part of this work.
