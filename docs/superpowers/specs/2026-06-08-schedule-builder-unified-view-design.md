# Schedule Builder — Unified Day View + Grid

Date: 2026-06-08
Status: Approved (design, rev 2)
Area: `src/app/schedule/builder/page.tsx`, `src/modules/schedule/components/`

## Problem

The schedule builder spreads its work across a `view` toggle (Day / Grid) and a `mode`
toggle (Assign shifts / View availability). Two issues:

1. A director building one day's schedule has to flip between "assign" and "view
   availability" to see who said they are free. They want the schedule and the
   availability overlap (who said yes, who is not free) on one screen.
2. PR #11 collapsed the URL `mode` handling so `?mode=shadow` silently resolves to
   `assign`. The grid still contains full shadow-assignment logic, but there is no UI
   left to reach it — so directors can no longer assign shadows from the grid (review
   issue #2). The grid itself is valuable and stays; the fix is to make shadow
   assignment reachable again, not to remove it.

## Goal

- **Day view**: one per-date screen showing the current schedule next to who is
  available ("said yes") and who is not ("not free"), with inline assign-as-volunteer /
  shadow / director on every member.
- **Grid view**: keep the member x clinic-date matrix (directors rely on it) and restore
  the ability to assign shadows there via an explicit role toggle.
- A single availability-override editor, reachable from both views.

No service, engine, or schema changes — all data already comes from `builderView`.

## URL params

- `?dept=<id>` — selected department (unchanged).
- `?date=<YYYY-MM-DD>` — selected clinic date (unchanged).
- `?view=grid` — show the Grid view; default (absent) shows the Day view. (The internal
  default value stays `"saturday"` to avoid churn; the user-facing label is "Day".)
- `?gmode=shadow` — in the Grid view, an empty-cell click assigns a SHADOW; default
  (absent) assigns a VOLUNTEER. Ignored outside the grid.
- `?mode=availability` — show the availability-override editor (full width), over either
  view; default (absent) shows the assign experience.

## Render routing

```
if mode === "availability"        -> AvailabilityView editor (unchanged)
else if view === "grid"           -> grid role toggle + BuilderGrid(mode = gmode)
else                              -> Day view (two columns + sidebar)
```

## Day view (default)

Two columns plus the existing sidebar (capacity, readiness, pending requests — unchanged).

### Column 1 — Assigned (unchanged)

- Directors — brand left-border card, Remove.
- Volunteers — emerald left-border card, tag toggles, optional reason + Remove.
- Shadows — amber left-border card, Remove.

### Column 2 — "Available to assign"

Keeps the `Available to assign` section heading (the e2e test keys off it). The member
list is split into two labeled subsections:

1. **Available — said yes**: unassigned members whose resolved availability includes the
   selected date. Emerald accent. Buttons per member: `Assign as volunteer`,
   `Assign as shadow`, plus `Assign as director` for `kind === "DIRECTOR"` members.
2. **Not available**: the remaining unassigned members. Dimmed card + a `not free` badge.
   The same three buttons, each labeled with a trailing warning marker so the director
   sees they are overriding stated availability. Assignment still succeeds — availability
   is advisory in `setAssignment`, not a gate.

No confirmed-vs-application-tier marker (kept simple). Within each subsection, members are
sorted by name.

## Grid view

The existing `BuilderGrid` matrix is kept. Above the table, add a role toggle:

```
Assigning as:  [ Volunteer ]   Shadow
```

It is two links that set `?gmode=assign|shadow` (preserving the other params). The page
passes the resolved `gmode` to `BuilderGrid` as its `mode` prop, driving the existing
cell behavior:

- **Volunteer** (`gmode=assign`): empty cell -> assign VOLUNTEER; filled cell -> unassign.
- **Shadow** (`gmode=shadow`): empty cell -> assign SHADOW; filled SHADOW cell -> unassign;
  other filled cells are read-only (role changes happen in the Day view).

`BuilderGrid`'s old read-only `availability` mode is removed — availability now lives only
in the editor, and the grid never receives that mode. The grid's `mode` prop type narrows
to `"assign" | "shadow"`, and the `mode === "availability"` branch in `GridCell` is
deleted. The `BuilderCell` `grid` / `grid-filled` variants are kept (the grid still uses
them).

## Navigation

- Keep the **Day / Grid** toggle in the hero.
- Remove the **Assign shifts / View availability** tab pair (the `mode` tabs). Replace it
  with a single hero `Edit availability` button that links to `?mode=availability`; the
  editor shows a `Back to assigning` link back to the default view.
- When `mode === "availability"`, the hero hides the Day/Grid toggle and shows only
  `Back to assigning`.
- The grid role toggle renders only in the Grid view, directly above the matrix.

## Cleanup

- Replace the tripled `/** Schedule Builder page. */` JSDoc with one block, and rewrite
  the URL-params doc to list `?view`, `?gmode`, and `?mode=availability`.
- Update the `BuilderGrid` header comment to describe the `assign | shadow` modes only.

## Data (no service changes)

All required data already comes from `builderView`:

- `members[].availability.dates` — dates the member is free (available/not-free split,
  and the grid's muted-cell styling).
- `assignmentsByDate` — current schedule (role + tags) for Column 1 and the grid cells.
- `members[].kind` — gates the `Assign as director` button.

`setAssignment` already accepts `role: VOLUNTEER | SHADOW | DIRECTOR` and enforces that
DIRECTOR requires a director-kind membership.

## Testing

- `e2e/schedule.spec.ts` "Builder assign round trip" keys off the `Assigned` and
  `Available to assign` headings and a substring "Assign" button — all preserved.
- Add Day-view coverage: a shadow assignment via `Assign as shadow`, and assertion that
  both subsections render.
- Add Grid coverage: switch the role toggle to Shadow and assign a shadow from a grid
  cell.

## Out of scope

- The session `maxAge` timeout and hardcoded "Summer 2026" banner (separate review
  issues, separate fixes).
- Any new color palette beyond the existing brand/emerald/amber role colors.
- Reworking the grid's matrix layout itself (only the shadow-reach toggle and the dead
  availability branch change).
