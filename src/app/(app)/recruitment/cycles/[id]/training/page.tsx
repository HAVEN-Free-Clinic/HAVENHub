import { notFound } from "next/navigation";
import { requirePermission, requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listTrainingRoster, TrainingStateError } from "@/modules/recruitment/services/training";
import {
  clearExcuseAction,
  excuseAbsenceAction,
  recordAttendanceAction,
  resetTrainingAction,
} from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { ExcuseAbsenceButton } from "@/modules/recruitment/components/excuse-absence-button";
import { formatDateOnly } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";

export default async function TrainingRosterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("recruitment.access");
  const viewer = await requirePersonSession();
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const trail = cycleTrail({ cycleId: id, cycleTitle: cycle.title, section: { label: "Training", slug: "training" } });

  // Excusing an absence is a lead's call, not a department director's: it is the
  // clinic deciding somebody is not at fault, and it is the leads who receive the
  // emails these excuses come out of. Directors still see the badge.
  const [canExcuse, zone] = await Promise.all([
    can(viewer.personId, "recruitment.manage_cycles"),
    getDisplayTimeZone(),
  ]);

  let rows;
  try {
    rows = await listTrainingRoster(id, viewer.personId);
  } catch (e) {
    if (e instanceof TrainingStateError) {
      return (
        <div className="max-w-2xl space-y-6">
          <SetBreadcrumb trail={trail} />
          <PageHeader title="Training" description={cycle.title} />
          <Alert tone="warning">
            {e.message} Set this cycle as the term training cycle from the overview.
          </Alert>
        </div>
      );
    }
    throw e;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <SetBreadcrumb trail={trail} />
      <PageHeader title="Training" description={cycle.title} />
      <Table>
        <THead>
          <tr>
            <TH>{cycle.track === "DIRECTOR" ? "Director" : "Volunteer"}</TH>
            <TH>Dept</TH>
            <TH>Cert</TH>
            <TH>Training</TH>
            <TH>Overall</TH>
            <TH className="text-right">Actions</TH>
          </tr>
        </THead>
        <tbody>
          {rows.map((r) => (
            <TR key={`${r.personId}-${r.departmentCode}`}>
              <TD className="font-medium text-foreground">{r.name}</TD>
              <TD className="text-foreground-soft">{r.departmentCode}</TD>
              <TD className="text-foreground-soft">{r.certStatus}</TD>
              <TD className="text-foreground-soft">
                <div className="space-y-1">
                  <div>
                    {r.trainingState}
                    {r.locked ? " (locked)" : ""}
                    {/* Shown even once training is COMPLETE: "COMPLETE, Excused" is
                        the true story of someone who missed the session with warning
                        and finished by makeup quiz, and keeping the record is the
                        point of recording it. */}
                    {r.excuse && (
                      <>
                        {" "}
                        <Badge tone="warning">Excused</Badge>
                      </>
                    )}
                  </div>
                  {r.excuse && (
                    // Clamped, not truncated to a tooltip: a long reason must not
                    // stretch this column past the rest of the table, and the full
                    // text is one click away in the edit form.
                    <p className="line-clamp-2 text-xs text-subtle-foreground">
                      {r.excuse.reason}
                      {" ("}
                      {r.excuse.recordedByName ? `${r.excuse.recordedByName}, ` : ""}
                      {formatDateOnly(r.excuse.recordedAt, zone)}
                      {")"}
                    </p>
                  )}
                </div>
              </TD>
              <TD className="text-foreground-soft">{r.overallClearance}</TD>
              <TD>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {r.trainingState !== "COMPLETE" && (
                    <form action={recordAttendanceAction.bind(null, id, r.personId)}>
                      <SubmitButton variant="outline" size="sm" pendingLabel="Recording…">
                        Record attendance
                      </SubmitButton>
                    </form>
                  )}
                  {/* Offered even on a COMPLETE row: an excuse is a record, and a
                      lead may only get to writing one down after the person has
                      already caught up by makeup quiz. */}
                  {canExcuse && (
                    <ExcuseAbsenceButton
                      name={r.name}
                      currentReason={r.excuse?.reason ?? null}
                      action={excuseAbsenceAction.bind(null, id, r.personId)}
                    />
                  )}
                  {canExcuse && r.excuse && (
                    <form action={clearExcuseAction.bind(null, id, r.personId)}>
                      <ConfirmButton label="Clear excuse" size="sm" />
                    </form>
                  )}
                  {r.locked && (
                    <form action={resetTrainingAction.bind(null, id, r.personId)}>
                      <ConfirmButton label="Reset" size="sm" />
                    </form>
                  )}
                </div>
              </TD>
            </TR>
          ))}
          {rows.length === 0 && (
            <TR>
              <TD colSpan={6} className="py-10 text-center text-subtle-foreground">
                No active {cycle.track === "DIRECTOR" ? "directors" : "volunteers"} in scope.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
