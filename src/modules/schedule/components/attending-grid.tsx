/**
 * AttendingGrid -- server component rendering an attending x clinic-date matrix.
 *
 * The same shape as the volunteer BuilderGrid, so Faculty Relations builds the
 * attending schedule the way every other schedule on the platform is built:
 * a row per person, a column per date, one click per cell.
 *
 * Receives all data from the attendings page; performs no data fetching itself.
 * Layout: horizontally scrollable table with a sticky first column (attending).
 *
 * Interaction model by mode:
 *   slot:<id> -- empty cell posts assignAction for THAT column; a cell already
 *                in that column posts unassignAction. A cell filled in a
 *                DIFFERENT column renders read-only with its column's short
 *                label, so the whole day stays legible while you work one
 *                column at a time.
 *   oncall    -- the cell of the week's on-call attending posts clearOnCall;
 *                every other cell posts setOnCall, which REPLACES them (a date
 *                holds one on-call attending). Available on closed dates too:
 *                on call covers the week leading up to the next clinic day, so
 *                someone holds the pager through a break week.
 */

import { BuilderCell } from "./builder-cell";
import { Badge } from "@/platform/ui/badge";
import { cx } from "@/platform/ui/cx";
import { displayDate } from "@/modules/schedule/engine/display";
import type { AttendingScheduleRow, ClinicSlotView } from "@/modules/schedule/services/attendings";

// ---------------------------------------------------------------------------
// Slot labels
// ---------------------------------------------------------------------------

/**
 * A schedule column's label, shortened to fit a grid cell.
 *
 * Drops the "Attending"/"Clinic" noun the clinic's own column names carry
 * ("RHD Attending" -> "RHD") before truncating, so the part that identifies the
 * column survives. The full label is always on the cell's accessible name, and
 * the legend above the grid spells every one of them out.
 */
export function shortSlotLabel(label: string): string {
  const trimmed = label.replace(/\s+(Attending|Clinic|Shift)$/i, "").trim() || label;
  return trimmed.length <= 9 ? trimmed : `${trimmed.slice(0, 8)}…`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AttendingGridMode = { kind: "slot"; slotId: string } | { kind: "oncall" };

type RosterEntry = { id: string; scheduleName: string; isActive: boolean };

type Props = {
  rows: AttendingScheduleRow[];
  slots: ClinicSlotView[];
  /** The roster, active first. */
  options: RosterEntry[];
  termId: string;
  mode: AttendingGridMode;
  editable: boolean;
  /** Clinic date to highlight as the "current week" wayfinding cue. */
  highlightDateKey: string | null;
  assignAction: (fd: FormData) => Promise<void>;
  unassignAction: (fd: FormData) => Promise<void>;
  setOnCallAction: (fd: FormData) => Promise<void>;
};

// ---------------------------------------------------------------------------
// GridCell
// ---------------------------------------------------------------------------

type CellProps = {
  attending: RosterEntry;
  row: AttendingScheduleRow;
  /** Short labels of every column this attending covers on this date. */
  covering: Array<{ slotId: string; short: string; label: string }>;
  isOnCall: boolean;
  slotById: Map<string, ClinicSlotView>;
  termId: string;
  mode: AttendingGridMode;
  editable: boolean;
  isHighlightDate: boolean;
  assignAction: (fd: FormData) => Promise<void>;
  unassignAction: (fd: FormData) => Promise<void>;
  setOnCallAction: (fd: FormData) => Promise<void>;
};

function GridCell({
  attending,
  row,
  covering,
  isOnCall,
  slotById,
  termId,
  mode,
  editable,
  isHighlightDate,
  assignAction,
  unassignAction,
  setOnCallAction,
}: CellProps) {
  const displayD = displayDate(row.dateKey);
  // A closed date staffs no column. Muted rather than hidden so the break in the
  // term is visible in the grid instead of being an unexplained empty stretch.
  const closedBg = row.isClosed ? "bg-muted" : "";
  const selectedHighlight = isHighlightDate ? "ring-1 ring-inset ring-brand/40" : "";
  const tdBase = `relative border border-border px-1 py-1 text-center align-middle min-w-[58px] ${closedBg} ${selectedHighlight}`;

  // Non-color cue for a closed date, so the state is not carried by the muted
  // background alone.
  const closedMarker = row.isClosed ? (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute bottom-0.5 right-1 text-[10px] leading-none text-subtle-foreground"
    >
      &middot;
    </span>
  ) : null;

  /** What the cell shows when it is not a button. */
  const readOnly = (extraLabel?: string) => (
    <td className={tdBase} aria-label={`${attending.scheduleName}, ${extraLabel ?? "not scheduled"} on ${displayD}`}>
      {covering.length === 0 && !isOnCall ? (
        <span className="text-subtle-foreground text-xs" aria-hidden="true">
          -
        </span>
      ) : (
        <span className="inline-flex flex-col items-center gap-0.5">
          {covering.map((c) => (
            <span key={c.slotId} className="text-[10px] font-semibold leading-tight text-foreground-soft">
              {c.short}
            </span>
          ))}
          {isOnCall && (
            <span className="rounded-sm bg-brand-faint px-0.5 text-[9px] font-medium leading-tight text-brand-fg">
              OC
            </span>
          )}
        </span>
      )}
      {closedMarker}
    </td>
  );

  const coveringLabel = covering.map((c) => c.label).join(", ");

  if (mode.kind === "oncall") {
    if (!editable) return readOnly(isOnCall ? "on call" : coveringLabel || undefined);

    if (isOnCall) {
      return (
        <td className={tdBase}>
          <BuilderCell
            action={setOnCallAction}
            hidden={{ termId, dateKey: row.dateKey, attendingId: "" }}
            label="OC"
            variant="grid-filled"
            ariaLabel={`Clear ${attending.scheduleName} as on-call attending for the week after ${displayD}`}
          />
          {closedMarker}
        </td>
      );
    }
    return (
      <td className={tdBase}>
        <BuilderCell
          action={setOnCallAction}
          hidden={{ termId, dateKey: row.dateKey, attendingId: attending.id }}
          label="+"
          variant="grid"
          ariaLabel={
            row.onCallName
              ? `Make ${attending.scheduleName} on-call attending for the week after ${displayD}, replacing ${row.onCallName}`
              : `Make ${attending.scheduleName} on-call attending for the week after ${displayD}`
          }
        />
        {closedMarker}
      </td>
    );
  }

  // Slot mode. A closed date takes no clinical staffing at all, so its cells are
  // read-only here -- the on-call mode above is the one thing that crosses it.
  if (!editable || row.isClosed) return readOnly(coveringLabel || undefined);

  const slot = slotById.get(mode.slotId);
  const inThisSlot = covering.some((c) => c.slotId === mode.slotId);
  const slotLabel = slot?.label ?? "this column";

  if (inThisSlot) {
    return (
      <td className={tdBase}>
        <BuilderCell
          action={unassignAction}
          hidden={{ termId, dateKey: row.dateKey, slotId: mode.slotId, attendingId: attending.id }}
          label={shortSlotLabel(slotLabel)}
          variant="grid-filled"
          ariaLabel={`Remove ${attending.scheduleName} from ${slotLabel} on ${displayD}`}
        />
        {closedMarker}
      </td>
    );
  }

  // Covered elsewhere that day: shown, not offered. Assigning them here as well
  // is legitimate (an attending can hold two columns), so the other columns are
  // rendered read-only ABOVE the "+" rather than replacing it.
  return (
    <td className={tdBase}>
      <div className="flex flex-col items-center gap-0.5">
        {covering.length > 0 && (
          <span className="text-[10px] font-semibold leading-tight text-subtle-foreground">
            {covering.map((c) => c.short).join(" ")}
          </span>
        )}
        <BuilderCell
          action={assignAction}
          hidden={{ termId, dateKey: row.dateKey, slotId: mode.slotId, attendingId: attending.id }}
          label="+"
          variant="grid"
          ariaLabel={
            slot && !slot.allowsMultiple && covering.length === 0
              ? `Assign ${attending.scheduleName} to ${slotLabel} on ${displayD}, replacing whoever holds it`
              : `Assign ${attending.scheduleName} to ${slotLabel} on ${displayD}`
          }
        />
      </div>
      {closedMarker}
    </td>
  );
}

// ---------------------------------------------------------------------------
// AttendingGrid
// ---------------------------------------------------------------------------

export function AttendingGrid({
  rows,
  slots,
  options,
  termId,
  mode,
  editable,
  highlightDateKey,
  assignAction,
  unassignAction,
  setOnCallAction,
}: Props) {
  const slotById = new Map(slots.map((s) => [s.id, s]));

  // Row set = ACTIVE attendings UNION any attending carrying an assignment or the
  // on-call pager. A deactivated attending who is still on the schedule must keep
  // a row -- otherwise their stale booking is invisible here and can never be
  // cleared from the grid, the same rule BuilderGrid applies to former members.
  const scheduledIds = new Set<string>();
  for (const row of rows) {
    for (const s of row.slots) for (const a of s.attendings) scheduledIds.add(a.id);
    if (row.onCallAttendingId) scheduledIds.add(row.onCallAttendingId);
  }
  const roster = options.filter((a) => a.isActive || scheduledIds.has(a.id));

  if (roster.length === 0) {
    return <p className="text-sm text-subtle-foreground">No attendings on the roster yet.</p>;
  }

  // Coverage indexed by attending, then date: the source data is per date, and
  // the grid reads per attending.
  const coverageByAttending = new Map<string, Map<string, Array<{ slotId: string; short: string; label: string }>>>();
  for (const row of rows) {
    for (const cov of row.slots) {
      const slot = slotById.get(cov.slotId);
      if (!slot) continue;
      for (const a of cov.attendings) {
        const byDate = coverageByAttending.get(a.id) ?? new Map();
        byDate.set(row.dateKey, [
          ...(byDate.get(row.dateKey) ?? []),
          { slotId: cov.slotId, short: shortSlotLabel(slot.label), label: slot.label },
        ]);
        coverageByAttending.set(a.id, byDate);
      }
    }
  }

  return (
    <div
      className={cx(
        "overflow-x-auto rounded-2xl border",
        mode.kind === "oncall" ? "border-warning bg-warning/5" : "border-border",
      )}
    >
      <table className="border-collapse text-sm" aria-label="Attending schedule grid">
        <thead>
          <tr className="bg-muted">
            <th
              scope="col"
              className="sticky left-0 z-10 bg-muted border border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap min-w-[170px]"
            >
              Attending
            </th>
            {rows.map((row) => (
              <th
                key={row.dateKey}
                scope="col"
                className={`border border-border px-2 py-2 text-center text-xs font-medium whitespace-nowrap min-w-[58px] ${
                  row.dateKey === highlightDateKey ? "bg-brand text-white" : "text-muted-foreground"
                }`}
              >
                {displayDate(row.dateKey)}
                {row.isClosed && (
                  <span
                    className={`block text-[9px] font-normal leading-tight ${
                      row.dateKey === highlightDateKey ? "text-white/80" : "text-subtle-foreground"
                    }`}
                  >
                    {row.isClinicDate ? "closed" : "no clinic"}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {roster.map((attending) => {
            const byDate = coverageByAttending.get(attending.id);
            return (
              <tr key={attending.id} className="hover:bg-muted/60">
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-surface border border-border px-3 py-2 whitespace-nowrap text-left font-normal"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-foreground">{attending.scheduleName}</span>
                    {!attending.isActive && <Badge tone="warning">Inactive</Badge>}
                  </div>
                </th>
                {rows.map((row) => (
                  <GridCell
                    key={row.dateKey}
                    attending={attending}
                    row={row}
                    covering={byDate?.get(row.dateKey) ?? []}
                    isOnCall={row.onCallAttendingId === attending.id}
                    slotById={slotById}
                    termId={termId}
                    mode={mode}
                    editable={editable}
                    isHighlightDate={row.dateKey === highlightDateKey}
                    assignAction={assignAction}
                    unassignAction={unassignAction}
                    setOnCallAction={setOnCallAction}
                  />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
