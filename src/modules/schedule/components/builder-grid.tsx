/**
 * BuilderGrid -- server component rendering a member x clinic-date matrix.
 *
 * Receives all data from the builder page; performs no data fetching itself.
 * Layout: horizontally scrollable table with a sticky first column (member name).
 *
 * Interaction model by mode:
 *   assign       -- empty cell posts assignAction(role=VOLUNTEER); filled cell posts unassignAction.
 *                   Director-kind members also get VOLUNTEER in grid mode; use the Day view
 *                   for DIRECTOR role assignment (keeps grid actions uniform and simple).
 *   shadow       -- empty cell posts assignAction(role=SHADOW); filled SHADOW cell posts unassignAction.
 *                   Non-shadow filled cells are read-only in the grid (role changes via Day view).
 */

import { BuilderCell } from "./builder-cell";
import { Badge } from "@/platform/ui/badge";
import { displayDate } from "@/modules/schedule/engine/display";
import { isoDateKey } from "@/platform/dates";
import { rolesForDept } from "@/modules/schedule/engine/capacity";
import type { BuilderMember, BuilderAssignmentEntry } from "@/modules/schedule/services/builder";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AssignmentsByDate = Record<string, Record<string, BuilderAssignmentEntry>>;

type Props = {
  members: BuilderMember[];
  clinicDates: Date[];
  assignmentsByDate: AssignmentsByDate;
  selectedDateKey: string | null;
  deptId: string;
  deptCode: string;
  mode: "assign" | "shadow";
  assignAction: (fd: FormData) => Promise<void>;
  unassignAction: (fd: FormData) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Role glyph helpers
// ---------------------------------------------------------------------------

function roleGlyph(role: "DIRECTOR" | "VOLUNTEER" | "SHADOW" | null): string {
  if (role === "DIRECTOR") return "D";
  if (role === "VOLUNTEER") return "V";
  if (role === "SHADOW") return "S";
  return "";
}

// Which tag abbreviations to show (dept-specific roles + remote always).
function tagKeys(deptCode: string): Array<"triage" | "walkin" | "cc" | "remote"> {
  const roles = rolesForDept(deptCode) as Array<"triage" | "walkin" | "cc">;
  return [...roles, "remote"] as Array<"triage" | "walkin" | "cc" | "remote">;
}

const TAG_SHORT: Record<"triage" | "walkin" | "cc" | "remote", string> = {
  triage: "T",
  walkin: "W",
  cc: "C",
  remote: "R",
};

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
  const activeTags = tagKeys(deptCode).filter((t) => assignment.tags[t]);

  return (
    <span className="inline-flex flex-col items-center gap-0.5">
      <span className="text-xs font-semibold text-foreground-soft">{glyph}</span>
      {activeTags.length > 0 && (
        <span className="inline-flex gap-0.5">
          {activeTags.map((t) => (
            <span
              key={t}
              className="inline-block rounded-sm bg-brand-faint px-0.5 text-[9px] font-medium text-brand-fg leading-tight"
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
// GridCell -- one member x date cell
// ---------------------------------------------------------------------------

type GridCellProps = {
  member: BuilderMember;
  dateKey: string;
  assignment: BuilderAssignmentEntry | undefined;
  deptId: string;
  deptCode: string;
  mode: "assign" | "shadow";
  isSelectedDate: boolean;
  assignAction: (fd: FormData) => Promise<void>;
  unassignAction: (fd: FormData) => Promise<void>;
};

function GridCell({
  member,
  dateKey,
  assignment,
  deptId,
  deptCode,
  mode,
  isSelectedDate,
  assignAction,
  unassignAction,
}: GridCellProps) {
  const isAvailable = member.availability.dates.some(
    (d) => isoDateKey(d) === dateKey,
  );

  // Muted background when member is not resolved-available on this date.
  const availBg = isAvailable ? "" : "bg-muted";
  const selectedHighlight = isSelectedDate ? "ring-1 ring-inset ring-brand/40" : "";

  const memberName = member.person.name;
  const displayD = displayDate(dateKey);
  const stateLabel = assignment
    ? `${assignment.role.toLowerCase()} on ${displayD}`
    : `unassigned on ${displayD}`;
  // Encode availability in the accessible label so it is not conveyed by the
  // muted background color alone.
  const availLabel = isAvailable ? "" : ", unavailable";
  const ariaLabel = `${memberName}, ${stateLabel}${availLabel}`;

  // Non-color cue for unavailable cells: a faint centered middot (decorative).
  const unavailableMarker = isAvailable ? null : (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute bottom-0.5 right-1 text-[10px] leading-none text-subtle-foreground"
    >
      &middot;
    </span>
  );

  // Assign mode: empty -> VOLUNTEER; filled -> unassign.
  if (mode === "assign") {
    if (!assignment) {
      return (
        <td
          className={`relative border border-border px-1 py-1 text-center align-middle min-w-[52px] ${availBg} ${selectedHighlight}`}
        >
          <BuilderCell
            action={assignAction}
            hidden={{
              departmentId: deptId,
              dateKey,
              personId: member.person.id,
              role: "VOLUNTEER",
            }}
            label="+"
            variant="grid"
            ariaLabel={`Assign ${memberName} as volunteer on ${displayD}${availLabel}`}
          />
          {unavailableMarker}
        </td>
      );
    }
    return (
      <td
        className={`relative border border-border px-1 py-1 text-center align-middle min-w-[52px] ${availBg} ${selectedHighlight}`}
      >
        <BuilderCell
          action={unassignAction}
          hidden={{
            departmentId: deptId,
            dateKey,
            personId: member.person.id,
          }}
          label={roleGlyph(assignment.role) || "?"}
          variant="grid-filled"
          ariaLabel={`Unassign ${memberName} (${assignment.role.toLowerCase()}) from ${displayD}${availLabel}`}
          assignment={assignment}
        />
        {unavailableMarker}
      </td>
    );
  }

  // Shadow mode: empty -> SHADOW; filled SHADOW -> unassign; other filled -> read-only.
  if (!assignment) {
    return (
      <td
        className={`relative border border-border px-1 py-1 text-center align-middle min-w-[52px] ${availBg} ${selectedHighlight}`}
      >
        <BuilderCell
          action={assignAction}
          hidden={{
            departmentId: deptId,
            dateKey,
            personId: member.person.id,
            role: "SHADOW",
          }}
          label="+"
          variant="grid"
          ariaLabel={`Assign ${memberName} as shadow on ${displayD}${availLabel}`}
        />
        {unavailableMarker}
      </td>
    );
  }

  if (assignment.role === "SHADOW") {
    return (
      <td
        className={`relative border border-border px-1 py-1 text-center align-middle min-w-[52px] ${availBg} ${selectedHighlight}`}
      >
        <BuilderCell
          action={unassignAction}
          hidden={{
            departmentId: deptId,
            dateKey,
            personId: member.person.id,
          }}
          label="S"
          variant="grid-filled"
          ariaLabel={`Unassign ${memberName} (shadow) from ${displayD}${availLabel}`}
          assignment={assignment}
        />
        {unavailableMarker}
      </td>
    );
  }

  // Non-shadow filled cell in shadow mode: read-only.
  return (
    <td
      className={`relative border border-border px-2 py-1.5 text-center align-middle min-w-[52px] ${availBg} ${selectedHighlight}`}
      aria-label={`${ariaLabel} (role change via Day view)`}
    >
      <CellContent assignment={assignment} deptCode={deptCode} />
      {unavailableMarker}
    </td>
  );
}

// ---------------------------------------------------------------------------
// BuilderGrid (exported server component)
// ---------------------------------------------------------------------------

export function BuilderGrid({
  members,
  clinicDates,
  assignmentsByDate,
  selectedDateKey,
  deptId,
  deptCode,
  mode,
  assignAction,
  unassignAction,
}: Props) {
  // Sort members alphabetically.
  const sorted = [...members].sort((a, b) =>
    a.person.name.localeCompare(b.person.name),
  );

  if (sorted.length === 0) {
    return (
      <p className="text-sm text-subtle-foreground">No members in this department.</p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-border">
      <table className="border-collapse text-sm" aria-label="Schedule grid">
        <thead>
          <tr className="bg-muted">
            {/* Sticky header for member column */}
            <th
              scope="col"
              className="sticky left-0 z-10 bg-muted border border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap min-w-[160px]"
            >
              Member
            </th>
            {clinicDates.map((d) => {
              const dk = isoDateKey(d);
              const isSelected = dk === selectedDateKey;
              return (
                <th
                  key={dk}
                  scope="col"
                  className={`border border-border px-2 py-2 text-center text-xs font-medium whitespace-nowrap min-w-[52px] ${
                    isSelected
                      ? "bg-brand text-white"
                      : "text-muted-foreground"
                  }`}
                >
                  {displayDate(dk)}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((member) => {
            const isDirector = member.kind === "DIRECTOR";
            return (
              <tr key={member.person.id} className="hover:bg-muted/60">
                {/* Sticky member name column */}
                <th scope="row" className="sticky left-0 z-10 bg-surface border border-border px-3 py-2 whitespace-nowrap text-left font-normal">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-foreground">
                      {member.person.name}
                    </span>
                    <Badge
                      tone={isDirector ? "brand" : "default"}
                    >
                      {isDirector ? "Dir" : "Vol"}
                    </Badge>
                  </div>
                </th>
                {clinicDates.map((d) => {
                  const dk = isoDateKey(d);
                  const assignment = assignmentsByDate[dk]?.[member.person.id];
                  return (
                    <GridCell
                      key={dk}
                      member={member}
                      dateKey={dk}
                      assignment={assignment}
                      deptId={deptId}
                      deptCode={deptCode}
                      mode={mode}
                      isSelectedDate={dk === selectedDateKey}
                      assignAction={assignAction}
                      unassignAction={unassignAction}
                    />
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
