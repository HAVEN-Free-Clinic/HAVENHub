# Term transition and bulk offboarding (2026-08-07)

## Problem

Offboarding works one person at a time, and nothing in the app knows a term transition is
happening.

Today the flow is: a director opens `/volunteers/offboarding`, reads their department cards, and
clicks Flag on each person who is not coming back. A `volunteers.manage_offboarding` holder then
clicks Offboard on each row of the flagged table. `executeOffboard` does the rest correctly, and the
Epic side is already strong: each offboard queues a `DEACTIVATE` EpicRequest, and `/support/epic`
turns the accumulated queue into a bulk YNHH deactivation PDF, spreadsheet, and ticket
([[offboard-epic-revocation]], [[itcm-term-epic-batch]]).

Three gaps sit above that.

**Nobody computes who is leaving.** There is no comparison anywhere between the current term's
roster and the next term's. Renewal is only ever recorded on the way in: a returning member
re-applies through the portal as applicant type `RENEWAL` and `promoteContracts` writes their
new-term membership, or ops carry a roster forward with `copyRosterFromTerm`. Activating the next
term (`activateTerm`) swaps term statuses and never touches a person. So identifying the
non-renewers is done by eye, against department cards that show the current term only.

**The work is per-click.** A term with 38 departures is 38 flags and 38 offboards.

**Teams removal has no list at all.** The app's Graph scopes are `Mail.Send`,
`Channel.ReadBasic.All`, `Chat.Create`, and `ChatMessage.Send` (`src/platform/email/oauth.ts`). It
posts messages into Teams and has never managed team or group membership. There is also no CSV or
roster export anywhere in the app to hand to whoever does the removals by hand.

There is also a timing trap. The department cards list ACTIVE memberships **in the ACTIVE term**,
and `OffboardFlag` is unique on `(personId, termId)` against that term. Once the term flips, last
term's people are gone from those cards and cannot be flagged there at all; the only remaining path
is `/admin/people/[id]` one person at a time. The transition report has to exist to make the
pre-flip window usable.

## Scope

In: a Transition report deriving three buckets from the roster and the next term, bulk flag, bulk
execute, and two CSV exports.

Out: any change to what a single offboard does, any Teams API integration, any renewal-solicitation
email, and any schema change. This feature adds no tables and no columns.

## Bucket derivation

Inputs are the ACTIVE term (`getActiveTerm`) and the next term (`getNextTerm`, the newest PLANNING
term). With no next term the tab renders an empty state linking to Admin > Terms rather than
guessing at a transition.

The population is everyone holding an ACTIVE membership in the active term. Directors see only
their `manageableDepartmentIds`; `volunteers.manage_offboarding` holders see clinic-wide. This is
the same split `offboardingView` already applies, so no new permission is introduced.

Each person lands in exactly one bucket:

| Bucket | Test | Default selection |
|---|---|---|
| Returning | Holds an ACTIVE membership in the next term | Not selectable |
| Pending | No next-term membership, but a SUBMITTED application exists in a cycle whose `termId` is the next term | Shown, unchecked |
| Not returning | Neither | Checked |

Pending is shown-but-unchecked for the same reason the Epic roll-up carries its `optional` flag: a
decision in flight must not be swept into a default-checked bulk action, but silently omitting the
person would hide someone ops needs to see.

### Matching an application back to a member

`Applicant.applicantPersonId` is the clean link and is always populated for `RENEWAL` and
`TRANSFER`, since the apply wizard gates both on being signed in. It is null for an anonymous
applicant, so a current member who applied as `NEW` without signing in would have no link.

Misclassifying that person as Not returning is the dangerous direction, because Not returning is
default-checked for bulk flag. So the lookup matches on `applicantPersonId` first, then falls back
to `Applicant.emailLower` against the person's `contactEmail` and their `netId@yale.edu`.

### Chips

Bucket is one axis; these render as badges on the row and do not change the bucket:

- **draft application** when a DRAFT application exists for the next term's cycle. A draft does not
  count as renewing, but the human should see it before flagging.
- **flagged** when an `OffboardFlag` already exists for this person in the active term.
- **self-withdrew** when that flag was raised by the person themselves
  ([[offboard-convergence]] covers the withdrawal path).

A person can be Returning and still carry a flag raised elsewhere. That is legitimate (a graduating
director swept up by a roster copy, then flagged on their department card), so the report shows the
chip and does not override the bucket. The row stays unselectable on this tab; the flag is acted on
from the Flagged tab as usual.

## Services

### `src/modules/volunteers/services/transition.ts`

```
transitionView(viewerPersonId): { activeTerm, nextTerm, rows }
bulkFlag(actorPersonId, personIds, note?): BulkResult
bulkExecuteOffboard(actorPersonId, personIds): BulkResult

type BulkResult = {
  succeeded: { personId: string; name: string }[]
  skipped:   { personId: string; name: string; reason: string }[]
}
```

`transitionView` returns `nextTerm: null` for the empty state. Each row carries the person, their
current-term departments and role, the bucket, the chips, and `selectable`.

Both bulk functions loop the existing per-person functions, `flagForOffboarding` and
`executeOffboard`. Neither reimplements any part of an offboard. The scope check, the last-admin
guard, the audit rows, and the Epic, shift-request, credential, and wallet side effects all come
from the single-person path, so the bulk path cannot drift from it.

The service lives beside `offboarding.ts` rather than inside it. `offboarding.ts` is already 395
lines and answers "flag and execute one person"; the transition report answers "who is going where
next term". Keeping them separate also means a director opening the Flagged tab does not pay for
the transition roll-up.

### Permissions

No new permission. `flagForOffboarding` runs `actorCanManageTarget` internally, so a director
bulk-flagging outside their departments gets those rows back as skipped rather than a 403 for the
whole batch. `bulkExecuteOffboard` checks `volunteers.manage_offboarding` once up front, and
`executeOffboard` re-checks per person as defense in depth.

That gives the Transition tab three visibility tiers. A director sees their own departments' rows
and can bulk flag them. A `volunteers.manage_offboarding` holder additionally sees clinic-wide rows,
can bulk offboard, and sees the export button. A director without that permission does not see the
export button at all, since the route is gated on it.

### Failure isolation

A try/catch per iteration, mapping typed errors to readable reasons:

| Error | Reason shown |
|---|---|
| `OffboardForbiddenError` | the error's own message |
| `LastAdminError` | the error's own message |
| `PersonNotFoundError` | "Person no longer exists." |
| anything else | `log.error` with `errorAttrs`, row reads "Unexpected error, see logs" |

The loop always continues. Successes stand. Repeat execution is safe: `setPersonStatusField` gates
the credential snapshot on a real ACTIVE to OFFBOARDED transition and guards duplicate `DEACTIVATE`
creation, so a person offboarded twice is a no-op with an extra audit row.

### The batch cap

`bulkExecuteOffboard` refuses more than 25 person ids per call, throwing
`TransitionBatchTooLargeError`.

`revokeWalletPasses` runs an 8s per-call vendor timeout per pass, outside the offboard transaction.
During a wallet outage a 38-person batch would spend over 300s in that loop alone and lose its tail
to the function limit. 25 bounds the worst case near 225s with headroom. The UI states the cap and
enforces it on selection; nothing is silently truncated.

The cap lives in the service, so it applies to every caller: the Transition tab and the Flagged
tab's bulk execute both hit it.

`bulkFlag` is pure database work and takes no cap. It applies one optional note to every person in
the batch, matching the note field on the existing per-person Flag control.

### Audit and analytics

Per-person rows are unchanged: `offboard.flag`, `person.offboard`, `offboard.execute`, and the
`volunteer_offboarded` PostHog event fire from inside the existing functions. Each bulk call adds
one summary audit row carrying the counts, following the `roster.copy` precedent.

## UI

`page.tsx` becomes a thin server shell: authenticate, resolve `?tab=`, load only that tab's data,
render `TabRow` plus the tab component. Server actions stay in the page and pass down, matching the
current file. The `?tab=` search param mirrors the Epic tabs, so the URL is shareable and the back
button works.

Three components under `src/modules/volunteers/components/`:

- `transition-tab.tsx`, client, owns selection state, renders the three bucket sections, the bulk
  flag and bulk offboard buttons, and the export button.
- `department-tab.tsx`, today's director cards lifted unchanged.
- `flagged-tab.tsx`, today's flagged table plus selection for bulk execute and the offboarded-this-term
  export.

Tab order is Transition, By department, Flagged. Transition is the default when a next term exists,
otherwise By department, so the page behaves exactly as it does today outside a rollover.

Bulk actions are server actions that **return** their `BulkResult`; the tabs render it through
`useActionState`. That keeps per-person skip reasons intact ("34 offboarded, 4 skipped: Jane Doe,
would leave no admin"), preserves the selection, and avoids smuggling reasons through a query
string. The action calls `revalidatePath` so the tables refresh underneath. The result type is
plain strings and numbers only; no Prisma instances cross the boundary
([[use-client-plain-data-proxy]]).

Rendering uses the existing `Table`, `Badge`, `Checkbox`, `ConfirmButton`, `SectionHeader`, and
`Alert` primitives. The tab row is in-page, not the module nav, so the 1280px nav width guard is
untouched ([[nav-width-guard-is-e2e]]).

## CSV export

### `src/platform/csv.ts`

A pure `toCsv(headers, rows)` with RFC 4180 escaping: quote any field containing a comma, quote,
CR, or LF, and double any internal quote. Names like `O'Brien, Jr.` and a pasted newline inside a
flag note both have to survive it. No domain knowledge, trivially unit-tested.

### Email derivation

Domain knowledge, so it stays out of `csv.ts`: `netId@yale.edu` when a netId exists, else
`contactEmail`, else blank with the row still exported so nobody silently vanishes from the list.

The Yale domain is already hardcoded separately in `member-magic-link.ts` and `match-person.ts`.
Rather than add a fourth copy, this adds `yaleEmailForNetId` next to `netIdFromUpn` in
`src/platform/auth/match-person.ts`, where NetID-to-address knowledge already lives.

### Route

`POST /api/volunteers/offboarding/export`, gated on `volunteers.manage_offboarding`.

| Body | Population |
|---|---|
| `{ scope: "selection", personIds }` | exactly those people, from the Transition tab |
| `{ scope: "offboarded-term" }` | `Person.status` OFFBOARDED holding a REMOVED membership in the active term |

The second scope is the population whose Teams access should already be gone. Both go through one
row builder and one `toCsv` call.

Columns: name, email, netId, contactEmail, departments, role. A person holding several memberships
gets their department codes semicolon-joined in one field, and role reads DIRECTOR when any of
those memberships is a directorship, otherwise VOLUNTEER. One row per person, never one per
membership, since the consumer is deduplicating a removal list.

Response is `text/csv` with `Content-Disposition` from the existing `src/platform/content-disposition.ts`
helper and a filename like `haven-offboarding-FA25-2026-08-07.csv`. The client uses `fetch` plus a
Blob object URL, so the download does not disturb the tab's selection state.

Member emails leave the system here, so the route writes an `offboarding.export` audit row with the
scope and the row count.

## Error handling

| Condition | Behavior |
|---|---|
| No next term | Transition tab empty state linking to Admin > Terms |
| No active term | Unchanged from today: empty page |
| Selection over 25 for execute | `TransitionBatchTooLargeError`, inline `Alert` |
| Partial bulk failure | Successes stand, skipped rows listed with reasons |
| Export non-2xx | Inline `Alert`, no silent no-op |
| Two concurrent bulk executes | Safe as-is: the last-admin guard is Serializable per person and a repeat offboard is idempotent |

## Testing

Against the project test database ([[test-db]]).

**Bucket classification**
- Next-term membership resolves to Returning.
- Submitted application linked by `applicantPersonId` resolves to Pending.
- Submitted application matched **only** by the `emailLower` fallback resolves to Pending. This is
  the regression guard for the misclassification that would feed a default-checked flag.
- Draft application resolves to Not returning, carrying the draft chip.
- Neither signal resolves to Not returning.

**Scoping**
- A director sees only their manageable departments.
- A `manage_offboarding` holder sees clinic-wide.
- No next term returns no rows and `nextTerm: null`.

**Bulk mutations**
- `bulkFlag` is a no-op on an already-flagged person and writes no second audit row.
- `bulkFlag` reports an out-of-scope person as skipped rather than throwing.
- `bulkExecuteOffboard` continues past a last-admin refusal mid-batch; the people after it are
  offboarded.
- `bulkExecuteOffboard` throws over the cap.

**CSV**
- Pure unit tests: commas, embedded quotes, newlines, empty list, blank email.

**Export route**
- 401 without `volunteers.manage_offboarding`. Every other API route in this codebase
  (`support/epic/generate`, `learning/upload-url`) returns 401 for both unauthenticated and
  unauthorized, so this one does too rather than becoming the lone 403.
- Both scopes produce the expected rows.
- Audit row written.

**End to end**

One light Playwright spec: open Transition, bulk flag a Not returning person, confirm they appear on
Flagged, confirm the export downloads. Label assertions anchored rather than substring
([[e2e-open-badge-substring-flake]]).

## Verification

Full `npx eslint src e2e` ([[lint-walks-gitignored-design-system]]), typecheck, and the test suite,
reading actual counts rather than a piped tail ([[piped-test-exit-code-masks-failure]]).

## Build location

Implementation goes in its own worktree on a fresh branch off `main`. The current worktree is on
`feat/volunteer-passport` with uncommitted passport changes.
