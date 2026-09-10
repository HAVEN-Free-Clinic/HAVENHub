"use client";

/**
 * BuilderGrid -- the member x clinic-date matrix.
 *
 * A client component since the builder became interactive: a cell click writes
 * through {@link useBuilderBoard} (optimistic locally, one small POST, no
 * navigation) instead of submitting a form that redirected back to this same URL
 * and re-ran the entire page load. Assignments come from the board rather than a
 * prop, so a change made in the Day view -- or by another director, over the
 * change stream -- lands here without a reload.
 *
 * Layout: a bounded scroll box with BOTH headers pinned -- the date row across
 * the top and the member column down the left -- so the far end of an 18-week
 * term still says which Saturday and which person a cell belongs to. The box
 * scrolls, not the page, which is also why the scroll position now survives a
 * click at all.
 *
 * Interaction model by mode:
 *   assign       -- empty cell assigns VOLUNTEER; filled cell unassigns.
 *                   Director-kind members also get VOLUNTEER in grid mode; use the Day view
 *                   for DIRECTOR role assignment (keeps grid actions uniform and simple).
 *   shadow       -- empty cell assigns SHADOW; filled SHADOW cell unassigns.
 *                   Non-shadow filled cells are read-only in the grid (role changes via Day view).
 */

import { useEffect, useRef, useState } from "react";
import { MatrixScroll } from "@/platform/ui/matrix-table";
import { Badge } from "@/platform/ui/badge";
import { MembershipKindBadge } from "@/platform/ui/membership-kind-badge";
import { Spinner } from "@/platform/ui/spinner";
import { cx } from "@/platform/ui/cx";
import { displayDate } from "@/modules/schedule/engine/display";
import { isoDateKey } from "@/platform/dates";
import { rolesForDept } from "@/modules/schedule/engine/capacity";
import { compareBuilderMembers } from "@/modules/schedule/engine/member-order";
import type { BuilderMember, BuilderAssignmentEntry } from "@/modules/schedule/services/builder";
import { sortClinicDates } from "./clinic-date-order";
import { PROVISIONAL_BADGE_LABEL, PROVISIONAL_BADGE_TITLE } from "./provisional-labels";
import { EmptyState } from "@/platform/ui/empty-state";
import { useBuilderBoard, type BoardApi } from "./builder-board";
import {
  ROLE_GLYPH,
  SHIFT_TAG_KEYS,
  ROLE_LABEL,
  TAG_LABEL,
  TAG_SHORT,
  primaryTag,
  roleFillClass,
  roleRingClasses,
  tagCellStyle,
  tagChipStyle,
  tagSwatchStyle,
  type ShiftTagKey,
} from "./shift-colors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One matrix row. Derived from the UNION of three sets:
 *
 *   - ACTIVE members of the department (`member`);
 *   - people accepted into it for this term whose roster build has not run yet
 *     (`incoming`), so a director can draft around the class they are about to
 *     receive instead of waiting for everyone to finish onboarding;
 *   - anyone who still carries a live assignment but is neither of the above
 *     (`former`): offboarding drops the ACTIVE membership and leaves the
 *     ShiftAssignment rows, and without a row here their shift would be invisible
 *     in the grid and impossible to clear (audit L3).
 *
 * Former rows take their identity from the assignment-carried person snapshot and
 * have no membership `kind` or resolved availability.
 */
type GridRow = {
  /**
   * Row identity, and the personId every cell writes against. For an incoming
   * applicant with no Person record this is the synthetic acceptance-scoped id
   * from the service. Their draft shifts are keyed on the same id, and the
   * service routes a write carrying it to the draft table, so the row behaves
   * exactly like anyone else's.
   */
  personId: string;
  name: string;
  /** Membership kind, or null for a former-member assignee. */
  kind: "DIRECTOR" | "VOLUNTEER" | null;
  status: "member" | "incoming" | "former";
  /**
   * Whether an EMPTY cell on this row offers to assign. False only for a former
   * member: their leftover shifts are still actionable, but they hold no place to
   * be given a new one, and the grid must not render a "+" that setAssignment
   * would then refuse.
   */
  assignable: boolean;
  /** Resolved-available clinic dates; empty for former members. */
  availabilityDates: Date[];
};

type Props = {
  members: BuilderMember[];
  clinicDates: Date[];
  /** Clinic date to highlight as the "current week" wayfinding cue. */
  highlightDateKey: string | null;
  /**
   * Date keys the clinic has declared closed. Column headers say so; the cells
   * underneath stay editable, because a department can still staff triage on a
   * Saturday the clinic proper is shut.
   */
  closedDateKeys?: readonly string[];
  deptCode: string;
  mode: "assign" | "shadow";
  /** Test seam: a stub board in place of the surrounding provider's. */
  board?: BoardApi;
};

// ---------------------------------------------------------------------------
// Role glyph helpers
// ---------------------------------------------------------------------------

function roleGlyph(role: "DIRECTOR" | "VOLUNTEER" | "SHADOW" | null): string {
  return role ? ROLE_GLYPH[role] : "";
}

// Which tag abbreviations to show (dept-specific roles + remote always).
function tagKeys(deptCode: string): ShiftTagKey[] {
  const roles = rolesForDept(deptCode) as Array<"triage" | "walkin" | "cc">;
  // "remote" and "specialty" are offered for EVERY department, unlike the med
  // roles above, which only SCTP and JCTP use. Any team can work remotely, and
  // any team can be the one covering the day's specialty clinic.
  return [...roles, "remote", "specialty"] as ShiftTagKey[];
}

// Shared cell chrome, so the eight branches below cannot drift apart.
const CELL_BASE = "relative border-b border-r border-border text-center align-middle min-w-[52px]";

// ---------------------------------------------------------------------------
// CellContent -- pure display, no interactivity
// ---------------------------------------------------------------------------

function CellContent({
  assignment,
  deptCode,
}: {
  assignment: BuilderAssignmentEntry | undefined;
  deptCode: string;
}) {
  if (!assignment) {
    return <span className="text-subtle-foreground text-xs" aria-hidden="true">-</span>;
  }

  const glyph = roleGlyph(assignment.role);
  const shown = tagKeys(deptCode);
  const activeTags = shown.filter((t) => assignment.tags[t]);
  // The special shift owns the fill; the role keeps the ring and the glyph.
  const fillTag = primaryTag(assignment.tags, shown);

  return (
    <span
      className={cx(
        "inline-flex flex-col items-center gap-0.5 rounded-lg border px-1.5 py-0.5",
        roleRingClasses(assignment.role),
        fillTag ? "" : roleFillClass(assignment.role),
      )}
      style={fillTag ? tagCellStyle(fillTag) : undefined}
    >
      <span className="text-xs font-semibold leading-none">{glyph}</span>
      {activeTags.length > 0 && (
        <span className="inline-flex gap-0.5">
          {activeTags.map((t) => (
            <span
              key={t}
              style={tagChipStyle(t)}
              className="inline-block rounded-sm px-0.5 text-[9px] font-semibold leading-tight"
              aria-label={t}
            >
              {TAG_SHORT[t]}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Cell buttons
// ---------------------------------------------------------------------------

/** Empty grid cell: a compact "+" that assigns. */
function AssignCellButton({
  onAssign,
  ariaLabel,
  busy,
}: {
  onAssign: () => void;
  ariaLabel: string;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onAssign}
      disabled={busy}
      aria-label={ariaLabel}
      aria-busy={busy}
      // eslint-disable-next-line no-restricted-syntax -- grid-cell action button, not a standard Button
      className="flex h-9 w-full min-w-[40px] touch-manipulation items-center justify-center rounded-lg border border-dashed border-border-strong text-subtle-foreground hover:border-brand hover:text-brand-fg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      {busy ? <Spinner size="sm" /> : "+"}
    </button>
  );
}

/**
 * Filled grid cell with a two-click arm/confirm unassign.
 *
 * First click arms the cell (red, "Remove?"); a second click within the same
 * focus removes. Mirrors the platform ConfirmButton, including its accessibility
 * decision: arming is cleared by moving focus away, NOT by a timer. A timed
 * disarm is a WCAG 2.2.1 time limit, and the three-second one this cell used to
 * run expired before a screen reader had finished announcing the confirm step --
 * which made removing a shift from the grid impossible by AT.
 */
function FilledCellButton({
  label,
  ariaLabel,
  assignment,
  busy,
  onRemove,
}: {
  label: string;
  ariaLabel: string;
  assignment: BuilderAssignmentEntry;
  busy: boolean;
  onRemove: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const confirming = useRef(false);

  // A cell that is removed disappears with its armed state; one whose write
  // fails comes back, and must come back disarmed.
  useEffect(() => {
    if (!busy) confirming.current = false;
  }, [busy]);

  const activeTags = SHIFT_TAG_KEYS.filter((t) => assignment.tags[t]);
  // The special shift owns the fill; the role keeps the ring and the glyph.
  const fillTag = primaryTag(assignment.tags);

  if (armed) {
    return (
      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        onClick={() => {
          confirming.current = true;
          setArmed(false);
          onRemove();
        }}
        onBlur={() => {
          if (confirming.current || busy) return;
          setArmed(false);
        }}
        aria-label={`Confirm remove. ${ariaLabel}`}
        // eslint-disable-next-line no-restricted-syntax -- grid-cell action button, not a standard Button
        className="flex h-9 w-full min-w-[40px] touch-manipulation items-center justify-center rounded-lg border border-critical/30 bg-critical-faint text-critical transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        title="Click again to remove"
      >
        <span aria-live="polite" className="text-xs font-semibold leading-none">
          {busy ? <Spinner size="sm" /> : "Remove?"}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy}
      onClick={() => setArmed(true)}
      aria-label={ariaLabel}
      // eslint-disable-next-line no-restricted-syntax -- grid-cell action button, not a standard Button
      className={cx(
        "flex h-9 w-full min-w-[40px] touch-manipulation flex-col items-center justify-center rounded-lg border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        // Role ring + glyph, so a term of cells says at a glance which are
        // volunteers and which are shadows.
        roleRingClasses(assignment.role),
        // The special shift takes the fill when there is one; otherwise the role
        // keeps it. `bg-*` here would lose to the inline style anyway, so the
        // two are mutually exclusive rather than layered.
        fillTag ? "" : roleFillClass(assignment.role),
        // Removal is still the action, so the hover state still says red. The
        // inline fill below would outrank a hover background, so the hover cue
        // is carried by the ring and the glyph, which are classes.
        "hover:border-critical/40 hover:text-critical-foreground",
      )}
      style={fillTag ? tagCellStyle(fillTag) : undefined}
      title={ariaLabel}
    >
      {busy ? (
        <Spinner size="sm" />
      ) : (
        <>
          <span className="text-xs font-semibold leading-none">{label}</span>
          {activeTags.length > 0 && (
            <span className="mt-0.5 inline-flex gap-0.5">
              {activeTags.map((t) => (
                <span
                  key={t}
                  style={tagChipStyle(t)}
                  className="rounded-sm px-0.5 text-[10px] font-semibold leading-tight"
                >
                  {TAG_SHORT[t]}
                </span>
              ))}
            </span>
          )}
        </>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// GridLegend -- what the colours mean
// ---------------------------------------------------------------------------

/**
 * Names every colour the grid below can paint, in the three channels it paints
 * them: the cell's ground says whether the person is free that date, the role
 * rings a shift and letters it, the special shift fills it.
 *
 * Colour coding nobody can decode is decoration, and the cells are far too small
 * to label themselves. Only the shifts this department actually uses are listed,
 * so a Nursing director is not told what a care-coordinator fill means.
 *
 * The swatches are drawn the way the cells are -- availability swatches in the
 * cell grounds, role swatches ringed and lettered, shift swatches filled -- so
 * the key is the thing itself rather than a description of it.
 */
function GridLegend({ deptCode }: { deptCode: string }) {
  const roles = ["VOLUNTEER", "SHADOW", "DIRECTOR"] as const;
  const swatch =
    "inline-flex h-5 w-5 items-center justify-center rounded-md border text-[11px] font-semibold leading-none";
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-semibold uppercase tracking-wider text-subtle-foreground">
          Availability
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className={cx(swatch, "border-border bg-available")} />
          Available
        </span>
        <span className="inline-flex items-center gap-1">
          <span
            aria-hidden="true"
            className={cx(swatch, "border-border bg-unavailable text-subtle-foreground")}
          >
            &middot;
          </span>
          Not available
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-semibold uppercase tracking-wider text-subtle-foreground">
          Role (ring)
        </span>
        {roles.map((role) => (
          <span key={role} className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className={cx(swatch, roleRingClasses(role), roleFillClass(role))}
            >
              {ROLE_GLYPH[role]}
            </span>
            {ROLE_LABEL[role]}
          </span>
        ))}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-semibold uppercase tracking-wider text-subtle-foreground">
          Shift (fill)
        </span>
        {tagKeys(deptCode).map((t) => (
          <span key={t} className="inline-flex items-center gap-1">
            <span aria-hidden="true" style={tagSwatchStyle(t)} className={swatch}>
              {TAG_SHORT[t]}
            </span>
            {TAG_LABEL[t]}
          </span>
        ))}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GridCell -- one member x date cell
// ---------------------------------------------------------------------------

type GridCellProps = {
  row: GridRow;
  dateKey: string;
  assignment: BuilderAssignmentEntry | undefined;
  deptCode: string;
  mode: "assign" | "shadow";
  isHighlightDate: boolean;
  board: BoardApi;
};

function GridCell({
  row,
  dateKey,
  assignment,
  deptCode,
  mode,
  isHighlightDate,
  board,
}: GridCellProps) {
  const isAvailable = row.availabilityDates.some(
    (d) => isoDateKey(d) === dateKey,
  );

  // The cell's ground says whether the person is free that date: green when
  // they are, grey when they are not. It used to be white against slate-50,
  // which nobody could tell apart across a term of cells.
  const availBg = isAvailable ? "bg-available" : "bg-unavailable";
  const selectedHighlight = isHighlightDate ? "ring-1 ring-inset ring-brand/40" : "";
  const cellClass = cx(CELL_BASE, availBg, selectedHighlight);

  const memberName = row.name;
  const displayD = displayDate(dateKey);
  const stateLabel = assignment
    ? `${assignment.role.toLowerCase()} on ${displayD}`
    : `unassigned on ${displayD}`;
  // Encode availability in the accessible label so it is not conveyed by the
  // cell's color alone. Same for the incoming state, which the row
  // header otherwise carries only as a colored chip.
  const availLabel = isAvailable ? "" : ", unavailable";
  const incomingLabel = row.status === "incoming" ? ", incoming" : "";
  const ariaLabel = `${memberName}, ${stateLabel}${availLabel}${incomingLabel}`;
  const busy = board.isBusy(dateKey, row.personId);

  // Non-color cue for unavailable cells: a faint centered middot (decorative).
  const unavailableMarker = isAvailable ? null : (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute bottom-0.5 right-1 text-[10px] leading-none text-subtle-foreground"
    >
      &middot;
    </span>
  );

  // A cell nothing can be done to: an archived term (read-only), an empty cell
  // on a former member's row (their existing shifts are still actionable below),
  // or a non-shadow assignment while the grid is in shadow mode, where role
  // changes belong to the Day view. All three render the same inert cell; only
  // the explanation in the label differs.
  const inertReason = !board.editable
    ? "read-only"
    : !row.assignable && !assignment
      ? "former member"
      : mode === "shadow" && assignment && assignment.role !== "SHADOW"
        ? "role change via Day view"
        : null;

  if (inertReason) {
    return (
      <td className={cx(cellClass, "px-2 py-1.5")} aria-label={`${ariaLabel} (${inertReason})`}>
        <CellContent assignment={assignment} deptCode={deptCode} />
        {unavailableMarker}
      </td>
    );
  }

  // Empty cell: assign in the grid's current mode.
  if (!assignment) {
    const role = mode === "shadow" ? "SHADOW" : "VOLUNTEER";
    return (
      <td className={cx(cellClass, "px-1 py-1")}>
        <AssignCellButton
          onAssign={() => board.assign(dateKey, row.personId, role)}
          busy={busy}
          ariaLabel={`Assign ${memberName} as ${role.toLowerCase()} on ${displayD}${availLabel}${incomingLabel}`}
        />
        {unavailableMarker}
      </td>
    );
  }

  // Filled and actionable: unassign.
  return (
    <td className={cx(cellClass, "px-1 py-1")}>
      <FilledCellButton
        label={mode === "shadow" ? "S" : roleGlyph(assignment.role) || "?"}
        assignment={assignment}
        busy={busy}
        onRemove={() => board.unassign(dateKey, row.personId)}
        ariaLabel={`Unassign ${memberName} (${assignment.role.toLowerCase()}) from ${displayD}${availLabel}${incomingLabel}`}
      />
      {unavailableMarker}
    </td>
  );
}

// ---------------------------------------------------------------------------
// BuilderGrid (exported)
// ---------------------------------------------------------------------------

export function BuilderGrid({
  members,
  clinicDates,
  highlightDateKey,
  closedDateKeys,
  deptCode,
  mode,
  board: boardOverride,
}: Props) {
  const board = useBuilderBoard(boardOverride);
  const assignmentsByDate = board.assignments;

  // Row set = the builder's member list (confirmed roster members AND incoming
  // ones) UNION any person carrying a live assignment who is in neither.
  // Offboarding drops the ACTIVE membership but leaves ShiftAssignment rows, so a
  // former member with a future assignment must still get a row (mirroring the Day
  // view, audit L3) -- otherwise their shift is invisible here and can never be
  // cleared from the grid.
  const memberIds = new Set(members.map((m) => m.person.id));

  // Confirmed members first, then incoming ones, each in the shared
  // director-then-volunteer, alphabetical order (compareBuilderMembers).
  const memberRows: GridRow[] = [...members]
    .sort(compareBuilderMembers)
    .map((m) => ({
      personId: m.person.id,
      name: m.person.name,
      kind: m.kind,
      status: m.provisional ? ("incoming" as const) : ("member" as const),
      // Members and incoming people alike, first-time applicants included: the
      // service keeps their drafts against the acceptance until roster build.
      assignable: true,
      availabilityDates: m.availability.dates,
    }));

  // Former assignees: any personId present in the board that the member list does
  // not cover, identified by the assignment-carried person snapshot. Deduped
  // across dates; sorted by name and appended last.
  const formerRowByPerson = new Map<string, GridRow>();
  for (const byPerson of Object.values(assignmentsByDate)) {
    for (const [pid, entry] of Object.entries(byPerson)) {
      if (memberIds.has(pid) || formerRowByPerson.has(pid)) continue;
      formerRowByPerson.set(pid, {
        personId: pid,
        name: entry.person.name,
        kind: null,
        status: "former",
        assignable: false,
        availabilityDates: [],
      });
    }
  }
  const formerRows = [...formerRowByPerson.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const rows: GridRow[] = [...memberRows, ...formerRows];

  if (rows.length === 0) {
    return (
      <EmptyState inline>No members in this department.</EmptyState>
    );
  }

  // `clinicDates` is Term.clinicDates, handed to this component (and its
  // siblings in the same Builder request) by reference: it carries no
  // ordering guarantee, and the check-in feature's seed appends today's date
  // to the end regardless of where it falls chronologically. Sort a copy for
  // the column order below; never the prop itself, or every other consumer
  // of this same array in the request would see it reordered too.
  const sortedClinicDates = sortClinicDates(clinicDates);
  const closedDates = new Set(closedDateKeys ?? []);

  return (
    <div>
      <GridLegend deptCode={deptCode} />
      <MatrixScroll capHeight label="Schedule grid" tone={mode === "shadow" ? "warning" : "default"}>
        {/* border-separate, not the default collapse: collapsed borders are
            painted by the TABLE, so they scroll out from under a sticky cell and
            the pinned row loses its lines. Each cell therefore draws its own
            right and bottom border, and the container draws the outer frame. */}
        <table className="border-separate border-spacing-0 text-sm" aria-label="Schedule grid">
          <thead>
            <tr className="bg-muted">
              {/* Pinned in both axes: this is the corner cell, so it has to
                  outrank both the header row and the member column. */}
              <th
                scope="col"
                className="sticky left-0 top-0 z-30 bg-muted border-b border-r border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap min-w-[160px]"
              >
                Member
              </th>
              {sortedClinicDates.map((d) => {
                const dk = isoDateKey(d);
                const isHighlight = dk === highlightDateKey;
                const isClosed = closedDates.has(dk);
                return (
                  <th
                    key={dk}
                    scope="col"
                    className={cx(
                      "sticky top-0 z-20 border-b border-r border-border px-2 py-2 text-center text-xs font-medium whitespace-nowrap min-w-[52px]",
                      // Opaque, always: the rows scroll underneath this cell and
                      // any transparency would let them show through it.
                      isHighlight ? "bg-brand text-white" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {displayDate(dk)}
                    {isClosed && (
                      // Stacked under the date rather than beside it: the columns
                      // are ~52px wide and a second word on the same line would
                      // widen every one of ~18 of them.
                      <span
                        className={cx(
                          "block text-[10px] font-semibold uppercase tracking-wide",
                          isHighlight ? "text-white/90" : "text-warning-foreground",
                        )}
                      >
                        Closed
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              return (
                <tr key={row.personId} className="hover:bg-muted/60">
                  {/* Pinned member name column */}
                  <th scope="row" className="sticky left-0 z-10 bg-surface border-b border-r border-border px-3 py-2 whitespace-nowrap text-left font-normal">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-foreground">
                        {row.name}
                      </span>
                      {/* `kind` is null for a former-member assignee, and the
                          sibling status check does not narrow it, so guard it here. */}
                      {row.status === "member" && row.kind && (
                        <MembershipKindBadge kind={row.kind} abbreviated />
                      )}
                      {row.status === "incoming" && (
                        // Accepted into this department but not built onto the
                        // roster yet. The columns are ~52px, so the chip is the
                        // short one and the stage lives on the Day and
                        // availability views, which have room for it.
                        <Badge tone="warning" title={PROVISIONAL_BADGE_TITLE}>
                          {PROVISIONAL_BADGE_LABEL}
                        </Badge>
                      )}
                      {row.status === "former" && (
                        // Former member (offboarded) who still holds a live
                        // assignment. Flagged so directors can clear the leftover
                        // shift; they are not an assignable active member.
                        <Badge tone="warning">Former</Badge>
                      )}
                    </div>
                  </th>
                  {sortedClinicDates.map((d) => {
                    const dk = isoDateKey(d);
                    const assignment = assignmentsByDate[dk]?.[row.personId];
                    return (
                      <GridCell
                        key={dk}
                        row={row}
                        dateKey={dk}
                        assignment={assignment}
                        deptCode={deptCode}
                        mode={mode}
                        isHighlightDate={dk === highlightDateKey}
                        board={board}
                      />
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </MatrixScroll>
    </div>
  );
}
