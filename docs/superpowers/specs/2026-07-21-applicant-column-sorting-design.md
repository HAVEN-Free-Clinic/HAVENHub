# Applicant roster column sorting

**Date:** 2026-07-21
**Status:** Approved, pending implementation

## Problem

The applicants roster at `/recruitment/cycles/[id]/applicants` renders in a fixed
order: submission recency (`submittedAt desc`, then `createdAt desc`), applied in
the Prisma query in `listApplicantsForReview`. Reviewers cannot reorder it.

The concrete ask from ops: after a scoring round, find the highest-scoring
applicants. Today that means reading all 50 rows on a page and comparing by eye.
The same problem applies to every other column: there is no way to group by stage,
by decision, or by type.

Sorting should be available on every column, not just Committee avg.

## Approach

The page already loads the full applicant list into memory, then filters by
decision and slices for pagination (`page.tsx:52-57`). Sorting slots into that
existing pipeline as one more in-memory step. No query changes, no new indexes,
no pagination rework.

Sort state lives in the URL as `?sort=<key>&dir=asc|desc`, mirroring the
`DecisionFilter` precedent. Three consequences, all wanted:

1. Sorted views are shareable and survive a refresh.
2. Sorting composes with the existing `decision` filter.
3. The page stays a **server component**. Headers render as `next/link` `<Link>`s
   with a precomputed href, so no client JS and no `"use client"` boundary. This
   follows the repo's soft-nav convention (`Link`, never a bare `<a href>`).

Invalid or unknown `sort` / `dir` values fall back to the default order rather
than erroring, matching how `decision` is validated against an allowlist today.

### Rejected alternatives

- **Client-side sort with `useState`.** Would force a `"use client"` boundary on
  the roster, lose shareability, and reset on every navigation.
- **Push ordering into `listApplicantsForReview`.** The service applies
  department-scope filtering in JS *after* the query, so a DB-level sort would
  still need reconciling with the filter. In-memory sorting after filtering is
  both simpler and correct.

## Components

### 1. `SortableTH` (new, `src/platform/ui/table.tsx`)

Added alongside the existing `TH`, which stays untouched so no current table
changes behaviour.

Takes the column's sort key, the active sort state, and an `hrefFor` callback
(the same shape `Pagination` already uses). Renders:

- `aria-sort` on the `<th>`: `"ascending"`, `"descending"`, or `"none"`.
- A lucide chevron, `aria-hidden` with `className="h-3.5 w-3.5"`, per the
  `global-nav.tsx:194` precedent. `ChevronUp` when ascending, `ChevronDown` when
  descending, `ChevronsUpDown` when the column is inactive.
- The header label wrapped in a `Link`, so the whole header is one click target
  and is keyboard reachable for free.

### 2. `applicant-sort.ts` (new, `src/modules/recruitment/engine/`)

The pure comparator module. No React, no Prisma. This is where the real logic
lives and where the tests point.

Exports the sortable column keys and a comparator factory taking a key plus a
direction. Per-column semantics:

| Column | Sorts on | Notes |
| --- | --- | --- |
| Name | Last name, then first name | Roster convention. `localeCompare`, so accented names ("Renée") sort correctly. |
| Email | Displayed text | `localeCompare` |
| Type | Displayed `applicantTypeLabel` | `localeCompare` |
| Committee avg | Numeric average | Unscored rows forced last in **both** directions |
| Stage | Index into `APPLICATION_STAGE_ORDER` | Pipeline order, not alphabetical |
| Ranked | Joined `departmentChoices` text | `localeCompare` |
| Decision | Index into `ROSTER_DECISION_ORDER` | Precedence order, not alphabetical |

Two design rules worth stating explicitly:

**Unscored rows sink.** An applicant with no committee scores renders as `-`.
Those rows sort last whether the direction is asc or desc, so the column always
answers the question the reviewer clicked it to ask. Descending surfaces the
top-scored; ascending surfaces the genuinely low-scored, not a screenful of
blanks.

**Stage and Decision sort by meaning, not by label.** Alphabetical ordering would
put "Awaiting scoring" next to "Decided" and "Accepted" next to "None", which
tells a reviewer nothing. Sorting by pipeline position groups the roster the way
the process actually runs.

**Ties keep submission recency.** `Array.prototype.sort` is stable, so rows with
equal sort values retain the incoming `submittedAt desc` order. No secondary
comparator needed; this is asserted in tests so a future refactor cannot silently
break it.

### 3. Ordered arrays (new exports, existing files)

- `APPLICATION_STAGE_ORDER` in `src/modules/recruitment/engine/application-stage.ts`:
  `["AWAITING_SCORING", "SCORING", "ROUTED", "INTERVIEWING", "DECIDED"]`
- `ROSTER_DECISION_ORDER` in `src/modules/recruitment/engine/decision-summary.ts`:
  `["ACCEPTED", "WAITLIST", "REJECTED", "NONE"]`

Both currently exist only as union types whose declaration order already encodes
the intended sequence. Promoting that to an exported `as const` array makes the
ordering explicit and typed rather than implicit in `Object.keys()` order.

### 4. Wiring (`applicants/page.tsx`)

- Parse and validate `sort` / `dir` from `searchParams` alongside `decision`.
- Apply the comparator **after** the decision filter and **before** the page
  slice, so page counts stay correct.
- Sorting resets to page 1, exactly as `DecisionFilter` already deletes `page`.
- `hrefFor` at line 150 currently hand-concatenates the query string. It will not
  survive a third parameter, so it moves to `URLSearchParams`. This is a
  necessary consequence of the feature, not incidental refactoring.

## Toggle behaviour

Two-state: clicking a column toggles ascending and descending. First click is
ascending for text columns and **descending for Committee avg**, since the
overwhelmingly common intent there is "show me the top scorers".

Tri-state (a third click clearing back to recency order) was considered and
rejected as less predictable. The default order remains reachable by
re-navigating to the roster.

## Data flow

```
listApplicantsForReview(cycleId, personId)   // submittedAt desc
  -> filter by ?decision                      // existing
  -> sort by ?sort / ?dir                     // NEW, stable
  -> slice to page                            // existing
  -> render
```

## Testing

Unit tests against the comparator, which is where the logic is. The header is a
link and the page wiring is three lines; neither warrants its own harness.

Cases:

- Each of the seven column keys sorts correctly ascending and descending.
- Unscored applicants land last in **both** directions when sorting by
  Committee avg.
- Stage and Decision follow pipeline and precedence order, verified against a
  deliberately non-alphabetical fixture.
- Accented names (`Renée`) sort adjacent to their unaccented neighbours, not
  after `Z`.
- Equal values preserve input order (tie stability).
- An unknown `sort` key or `dir` value leaves the list in its default order.

## Out of scope

- Multi-column sorting.
- Persisting a reviewer's preferred sort across sessions.
- Sorting any other table in the app. `SortableTH` is built as a reusable
  primitive, but this change adopts it in exactly one place.
