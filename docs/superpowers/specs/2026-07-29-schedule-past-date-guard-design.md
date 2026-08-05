# The schedule change-request flow has no concept of a past date (2026-07-29)

## Problem

`src/modules/schedule/services/requests.ts` contains **no comparison of any clinic date to now**.
Verified: zero matches. Every consequence below follows from that one absence.

**Swap.** `eligibleSwapPartners` filters on term, department, role, active membership, the actor's
busy dates, and partners already on the requester date. It never compares a clinic date to today,
and it sorts ascending, so the stalest option is offered first. Measured across all four cards
offering swaps at the term midpoint, each `<select>` held the same five options and every one was
in the past. Selecting one submitted successfully and left the card reading "Change requested:
swap with Uxa Pending (July 11th) (pending director review)". The volunteer wanted off a future
shift, believes a swap is in motion, and has filed something that can only be denied.

**Drop.** The change disclosure renders for every shift with no date condition. Walked on a shift
seven weeks past: the form submitted, the server accepted, the banner confirmed, the pending count
went 0 to 1.

**And the part that is not merely UX.** `approveRequest` has no date precondition either. A
director clearing the queue runs `planApply`, which for a drop issues a `deleteMany` on
`ShiftAssignment`. That row is the record that this person worked that day. Approving a stale drop
silently erases attendance history.

Found in the 2026-07-29 UX audit (PR #474): finding **R3** (F-07-4 + F-07-5, ranked 3rd of 88,
tier 1) and its deliberately-distinct companion **R58** (F-09-1, tier 2). The audit is explicit
that they ship together, because R58's gap survives R3's fix: a request that was valid when filed
goes stale during the pending-to-approval window.

## Goals

Stop offering, accepting, and approving change requests for clinic dates that have already
happened, and make a stale queued request visible to the director who has to dispose of it.

## Non-goals

- Any change to how swaps are planned or applied when the dates are valid. `planApply` is untouched.
- Retroactively cleaning up stale requests already in the database. See "Consequences".
- The wider "no concept of now" theme the audit names, for example past shift cards rendering
  identically to future ones on `/schedule`. This fixes the request flow only.

## Design

### 0. One shared today-key, not a fourth copy

`src/modules/schedule/services/builder.ts:760-766` already resolves the display-zone calendar day
and documents why the obvious approach is wrong:

> "Today" is the display-zone (ET) calendar day: a raw `isoDateKey(new Date())` is a UTC day key
> that rolls over at ~8pm ET, so for the last few hours of a clinic day it would highlight next
> week instead of today.

That reasoning is load-bearing and easy to get wrong, and this change needs the same value in
three more places. Extract it once, with the comment, and have `builder.ts` call the extraction
too. Do not retype `formatForDateInput(now, await getDisplayTimeZone())` a fourth time.

This is the same lesson as the department-names branch, where a shared generator replaced two
literals that could drift.

### 1. Stop offering the past

In `eligibleSwapPartners`, add `isoDateKey(p.clinicDate) >= todayKey` to the existing filter.

The `swapPartners.length === 0` branch already exists and renders "No eligible swap partners for
this shift." So the honest empty state is already built; it was simply unreachable because five
impossible options always filled the list.

### 2. Close the API, not just the UI

In `createRequest`, next to the existing clinic-date validation, throw
`RequestValidationError("That clinic date has already passed.")` when either the requester date or
the target date is in the past.

The UI no longer offering a past date is not the same as the server refusing one. A stale form left
open in a tab, a replayed request, or a future caller all reach the service directly.

### 3. Protect attendance history

In `approveRequest`, add the matching precondition so a queue-clearing director cannot delete a
`ShiftAssignment` for a shift that already happened.

The error must tell the director what to do instead, because Deny is the correct disposition for a
stale request and the guard makes Approve permanently unavailable. Something like: "This request is
for a clinic date that has already passed. Deny it instead."

### 4. Say so on the card

On `/schedule`, compute `isPast` alongside the existing `dateKey` and replace the change disclosure
on past shifts with a muted "This shift has passed." line.

### 5. Make a stale request visible in the approval queue

In `pending-requests.tsx`, compute the same today-key and compare it to the request's dates. Render
a clear stale marker on the row and make the Approve control unavailable for a stale request, since
the service will now refuse it anyway. A director must not click Approve, get an error, and have to
reason about why.

## Consequences

**Requests already queued for past dates become deniable but not approvable.** That is intended:
approving one would erase attendance history. Deny is the correct disposition and remains
available. This is why R58 ships alongside R3 rather than after it; without the panel work, a
director meets an error message instead of a labelled row.

**No data migration.** Stale rows keep their `PENDING` status until someone denies them. Nothing
about them becomes invalid, and nothing silently changes state.

## Testing

- `eligibleSwapPartners` excludes a partner whose only free date is in the past, and still includes
  one whose free date is today or later. **Today itself must be included**, not excluded; the
  boundary is `>=`, and a volunteer asking for a swap on the morning of a clinic day is a real case.
- `createRequest` throws for a past requester date, throws for a past target date, and still
  accepts a valid future pair.
- `approveRequest` refuses a request whose date has passed, and still approves a valid one.
- Denying a stale request still works. This is the escape hatch the whole design depends on.
- The shared today-key resolves the display-zone day, not the UTC day. A test fixing the clock to a
  late-evening ET instant must still yield that day's key, which is the bug the `builder.ts` comment
  warns about.

## Risks

- **The boundary is the whole fix.** Off by one in either direction is a real defect: excluding
  today blocks legitimate same-day requests, and including yesterday leaves the hole open. Both
  directions need a test.
- **Timezone handling is the part most likely to be got wrong**, which is precisely why this reuses
  an existing, commented implementation rather than writing a fourth one.
- **A director may currently have stale requests queued.** After this ships they can only be denied.
  If any director expected to approve one, that expectation was already wrong: approving would have
  deleted a worked-shift record.
