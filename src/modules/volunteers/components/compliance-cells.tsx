import { Badge } from "@/platform/ui/badge";
import { TextLink } from "@/platform/ui/text-link";
import { TH, TD } from "@/platform/ui/table";
import { CalendarDate, DateOnly } from "@/platform/dates/display";
import { certExpiresAt } from "@/platform/compliance/rules";
import { complianceStatusLabel, onboardingTaskLabel } from "@/platform/compliance/labels";
import type { OnboardingTaskKey, OnboardingTaskState } from "@/platform/compliance/task-state";
import type { MemberCompliance } from "@/modules/volunteers/services/compliance";

/**
 * The compliance columns shared by the two staff rosters.
 *
 * /volunteers (a director's own departments) and /volunteers/master (the
 * clinic-wide view) answer the same question about the same people and were
 * built twice, cell for cell. The copies had already drifted: the department
 * roster shipped without the Learning column, so a director could read "Not
 * cleared" with no way to see that Learning was the thing blocking it. Both
 * pages compute `cleared` from the same loadClearanceMap, so the verdict was
 * never wrong; what was missing was the diagnostic beside it.
 *
 * The two pages still differ where they should: /volunteers shows a Role badge
 * (its rows are scoped to one department, so the useful fact is whether this
 * person directs it), /volunteers/master shows Departments (its rows span the
 * clinic). Those cells stay with their pages; everything between the name and
 * the actions comes from here.
 */

/** What both rosters carry. MasterComplianceRow already satisfies it; a
 *  MemberCompliance needs only its `kind` mapped to `isVolunteer`. */
export type ComplianceRowData = Omit<MemberCompliance, "kind"> & {
  isVolunteer: boolean;
};

/** Adapt a department-roster row to the shared shape. */
export function asComplianceRow(m: MemberCompliance): ComplianceRowData {
  const { kind, ...rest } = m;
  return { ...rest, isVolunteer: kind === "VOLUNTEER" };
}

export function taskState(
  clearance: { tasks: { key: OnboardingTaskKey; state: OnboardingTaskState }[] },
  key: OnboardingTaskKey,
): OnboardingTaskState | null {
  return clearance.tasks.find((t) => t.key === key)?.state ?? null;
}

/** Header cells for everything between the name/second column and Actions. */
export function ComplianceHeaderCells() {
  return (
    <>
      <TH>Status</TH>
      <TH>Training</TH>
      <TH>Learning</TH>
      <TH>EHS</TH>
      <TH>Cleared</TH>
      <TH>Completed</TH>
      <TH>Expires</TH>
      <TH>Verified</TH>
    </>
  );
}

/**
 * The name cell, with the contact identity underneath rather than in columns of
 * its own: the table already runs eleven wide, and "how do I reach this person"
 * is the question that follows "are they cleared".
 */
export function ComplianceNameCell({ person }: { person: ComplianceRowData["person"] }) {
  return (
    <TD className="font-medium">
      <TextLink href={`/volunteers/compliance/${person.id}`}>{person.name}</TextLink>
      <span className="block text-xs font-normal text-subtle-foreground break-words [overflow-wrap:anywhere]">
        {[person.netId, person.contactEmail, person.phone].filter(Boolean).join(" · ")}
      </span>
    </TD>
  );
}

/** A task badge, or a dash when the task does not apply to this person. */
function TaskCell({ state }: { state: OnboardingTaskState | null }) {
  if (!state) return <TD><span className="text-subtle-foreground">-</span></TD>;
  const { label, tone } = onboardingTaskLabel(state, { audience: "staff" });
  return (
    <TD>
      <Badge tone={tone}>{label}</Badge>
    </TD>
  );
}

export function ComplianceCells({ row }: { row: ComplianceRowData }) {
  const status = complianceStatusLabel(row.status, "staff");
  const expiresAt = row.cert?.completionDate ? certExpiresAt(row.cert.completionDate) : null;
  // Training only applies to a volunteer, and only when this term designated one.
  // Without both, show a dash rather than a "Pending" that contradicts Cleared.
  const trainingApplies =
    row.isVolunteer && row.clearance.tasks.some((t) => t.key === "training");

  return (
    <>
      <TD>
        <Badge tone={status.tone}>{status.label}</Badge>
      </TD>
      <TD>
        {trainingApplies ? (
          <Badge tone={row.trainingState === "COMPLETE" ? "success" : "default"}>
            {row.trainingState === "COMPLETE" ? "Complete" : "Pending"}
          </Badge>
        ) : (
          <span className="text-subtle-foreground">-</span>
        )}
      </TD>
      <TaskCell state={taskState(row.clearance, "learning")} />
      <TaskCell state={taskState(row.clearance, "ehs")} />
      <TD>
        <Badge tone={row.clearance.cleared ? "success" : "critical"}>
          {row.clearance.cleared ? "Cleared" : "Not cleared"}
        </Badge>
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
