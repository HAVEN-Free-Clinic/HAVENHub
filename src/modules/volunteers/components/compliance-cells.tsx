import { StatusBadge } from "@/platform/ui/status-badge";
import { TH, TD } from "@/platform/ui/table";
import { CalendarDate, DateOnly } from "@/platform/dates/display";
import { certExpiresAt } from "@/platform/compliance/rules";
import {
  complianceStatusLabel,
  onboardingTaskLabel,
  trainingStateLabel,
  clearanceLabel,
} from "@/platform/compliance/labels";
import type { OnboardingTaskKey, OnboardingTaskState } from "@/platform/compliance/task-state";
import type { MemberCompliance } from "@/modules/volunteers/services/compliance";

/**
 * The compliance columns of the staff roster at /volunteers.
 *
 * There were two rosters of the same people, a director's per-department cards
 * and the clinic-wide /volunteers/master, built twice cell for cell. The copies
 * drifted: the department roster shipped without the Learning column, so a
 * director could read "Not cleared" with no way to see Learning was the
 * blocker. They are one table now (scoped by viewer, see volunteers/page.tsx),
 * and everything between its Name/Departments columns and its actions comes
 * from here.
 */

/** A roster row. MasterComplianceRow satisfies it; `isVolunteer` stands in for
 *  a membership `kind`, which a one-row-per-person roster does not carry. */
export type ComplianceRowData = Omit<MemberCompliance, "kind"> & {
  isVolunteer: boolean;
};

export function taskState(
  clearance: { tasks: { key: OnboardingTaskKey; state: OnboardingTaskState }[] },
  key: OnboardingTaskKey,
): OnboardingTaskState | null {
  return clearance.tasks.find((t) => t.key === key)?.state ?? null;
}

/**
 * The compliance block's column headings, in order: everything between the
 * name/second column and Actions.
 *
 * Exported as data, not just rendered, because two other things must agree with
 * it and cannot read JSX: a caller computing an empty row's colSpan, and
 * volunteers/roster-skeleton.tsx, whose whole job is to reserve these
 * exact column widths so the Suspense swap does not shift the layout (that page
 * has measured CLS). The skeleton used to retype all eight.
 */
export const COMPLIANCE_COLUMN_LABELS = [
  "Status",
  "Training",
  "Learning",
  "EHS",
  "Cleared",
  "Completed",
  "Expires",
  "Verified",
] as const;

/** How many <TH>s ComplianceHeaderCells emits. */
export const COMPLIANCE_COLUMN_COUNT = COMPLIANCE_COLUMN_LABELS.length;

/** Header cells for everything between the name/second column and Actions. */
export function ComplianceHeaderCells() {
  return (
    <>
      {COMPLIANCE_COLUMN_LABELS.map((label) => (
        <TH key={label}>{label}</TH>
      ))}
    </>
  );
}

/** A task badge, or a dash when the task does not apply to this person. */
function TaskCell({ state }: { state: OnboardingTaskState | null }) {
  if (!state) return <TD><span className="text-subtle-foreground">-</span></TD>;
  return (
    <TD>
      <StatusBadge {...onboardingTaskLabel(state, { audience: "staff" })} />
    </TD>
  );
}

export function ComplianceCells({ row }: { row: ComplianceRowData }) {
  const expiresAt = row.cert?.completionDate ? certExpiresAt(row.cert.completionDate) : null;
  // Training only applies to a volunteer, and only when this term designated one.
  // Without both, show a dash rather than a "Pending" that contradicts Cleared.
  const trainingApplies =
    row.isVolunteer && row.clearance.tasks.some((t) => t.key === "training");

  return (
    <>
      <TD>
        <StatusBadge {...complianceStatusLabel(row.status, "staff")} />
      </TD>
      <TD>
        {/* trainingStateLabel, not a local ternary. This column said "Pending"
            in grey while the training roster one click away said "Not yet" in
            amber for the same state -- and "Pending" in this vocabulary already
            means outstanding and NOT yours to fix, which is exactly wrong for
            the one item a lead can clear on the spot. */}
        {trainingApplies ? (
          <StatusBadge {...trainingStateLabel(row.trainingState)} />
        ) : (
          <span className="text-subtle-foreground">-</span>
        )}
      </TD>
      <TaskCell state={taskState(row.clearance, "learning")} />
      <TaskCell state={taskState(row.clearance, "ehs")} />
      <TD>
        <StatusBadge {...clearanceLabel(row.clearance.cleared ? "CLEARED" : "NOT_CLEARED")} />
      </TD>
      <TD className="text-foreground-soft tabular-nums">
        <CalendarDate value={row.cert?.completionDate} />
      </TD>
      <TD className="text-foreground-soft tabular-nums">
        <CalendarDate value={expiresAt} />
      </TD>
      <TD className="text-foreground-soft text-xs">
        {row.cert?.verifiedAt ? (
          <span>
            {row.verifiedByName} <DateOnly value={row.cert.verifiedAt} />
          </span>
        ) : (
          "-"
        )}
      </TD>
    </>
  );
}
