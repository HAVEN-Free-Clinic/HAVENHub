# Schedule Builder — Unified Date View

Date: 2026-06-08
Status: Approved (design)
Area: `src/app/schedule/builder/page.tsx`, `src/modules/schedule/components/`

## Problem

The schedule builder splits three jobs across separate modes/views:

- **Assign shifts** mode — current schedule + an "Available to assign" list with inline
  assign buttons.
- **View availability** mode — a per-member availability editor across all clinic dates.
- **Day view / Grid view** toggle — the grid is a cross-date matrix.

A director building a day's schedule wants all of it in one place: who is already
assigned, who said they are free, who is not, and the ability to add anyone to the
shift as a volunteer or a shadow without switching tabs.

Separately, PR #11 collapsed the URL `mode` handling so `?mode=shadow` silently
resolves to `assign`, stranding the grid's shadow-assignment logic as unreachable
dead code (review issue #2). This design removes that dead path.

## Goal

One per-date screen that shows the current schedule and availability overlap side by
side, with inline "add as volunteer / shadow / director" on every member — available
or not. Keep a separate editor for bulk availability overrides. Remove the grid view.

## The unified view (default screen, per selected date)

Layout: two columns plus the existing sidebar (capacity, readiness, pending requests —
unchanged). This is the screen shown when no `mode` param is present.

### Column 1 — Assigned (unchanged)

Existing rendering kept as-is:

- Directors — brand left-border card, Remove.
- Volunteers — emerald left-border card, tag toggles, optional reason + Remove.
- Shadows — amber left-border card, Remove.

### Column 2 — "Available to assign"

Keeps the `Available to assign` section heading (the e2e test keys off it), but the
member list is split into two labeled subsections:

1. **Available — said yes**: unassigned members whose resolved availability includes
   the selected date. Emerald accent (current "available" styling). Action buttons per
   member:
   - `Assign as volunteer`
   - `Assign as shadow`
   - `Assign as director` — only for `kind === "DIRECTOR"` members.

2. **Not available**: the remaining unassigned members. Dimmed card styling with a
   `not free` badge. The **same** three buttons, but rendered with an amber/warning
   tone so the director sees they are overriding stated availability. Assignment still
   succeeds — availability is advisory in `setAssignment`, not a gate.

No confirmed-vs-application-tier marker is shown (kept simple). Within each subsection
members are sorted by name.

Sorting note: the current single list sorts available-first by name. The split makes
that ordering explicit (available subsection, then not-available subsection), so the
`sortedUnassigned` helper is replaced by partitioning unassigned members into the two
groups.

## Navigation changes

- Remove the `Assign shifts / View availability` tab pair.
- Remove the `Day view / Grid view` toggle from the hero.
- Add a single `Edit availability` button in the hero that links to the existing
  availability-override editor via `?mode=availability`. The editor view gains a
  `Back to assigning` link back to the unified view.
- Default screen (no `mode`) renders the unified view. `?mode=availability` renders the
  `AvailabilityView` editor (unchanged behavior).

## Cleanup (closes review issue #2)

- Delete the `BuilderGrid` import and usage from `page.tsx`.
- Delete the file `src/modules/schedule/components/builder-grid.tsx`.
- Remove the `view` URL param everywhere it appears: `PageProps`, `HrefParams`,
  `buildHref`, the `view` local, the hero toggle, and the hidden `view` input in the
  department selector form.
- Collapse `mode` handling to two states: the availability editor (`?mode=availability`)
  and the unified default.
- Replace the tripled `/** Schedule Builder page. */` JSDoc with a single block, and
  update the file-header URL-params doc to drop the `view` and `shadow` lines.

`BuilderCell` remains in use for the assign and tag buttons. Once the grid is gone its
`grid` and `grid-filled` variants (`src/modules/schedule/components/builder-cell.tsx`)
are dead; remove those two variants and their branches so the component only carries the
`assign | tag | remove` variants the unified view uses.

## Data (no service changes)

All required data already comes from `builderView`:

- `members[].availability.dates` — dates the member is free (for the available/not-free
  partition).
- `assignmentsByDate[dateKey]` — current schedule (role + tags) for Column 1.
- `members[].kind` — gates the `Assign as director` button.

`setAssignment` already accepts `role: VOLUNTEER | SHADOW | DIRECTOR` and enforces that
DIRECTOR requires a director-kind membership. No service or schema changes are needed.

## Testing

- `e2e/schedule.spec.ts` "Builder assign round trip" keys off the `Assigned` and
  `Available to assign` h2 headings and a substring "Assign" button — all preserved, so
  it should continue to pass. Verify after implementation.
- Other builder e2e tests (capacity panel, RHD readiness, request round trip) navigate
  to `/schedule/builder` without `view`/`mode` params and assert on the sidebar/heading;
  removing the toggles does not affect them. Verify.

## Out of scope

- The session `maxAge` timeout and hardcoded "Summer 2026" banner (separate review
  issues, separate fixes).
- Any new color palette beyond the existing brand/emerald/amber role colors.
- Rebuilding the grid matrix — it is removed, not reworked.
