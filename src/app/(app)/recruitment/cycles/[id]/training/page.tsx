import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listTrainingRoster, TrainingStateError } from "@/modules/recruitment/services/training";
import { recordAttendanceAction, resetTrainingAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";

export default async function TrainingRosterPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const viewer = await requirePersonSession();
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const trail = cycleTrail({ cycleId: id, cycleTitle: cycle.title, section: { label: "Training", slug: "training" } });

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
      {err && <Alert tone="error">{err}</Alert>}
      {msg && <Alert tone="success">{msg}</Alert>}
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
                {r.trainingState}
                {r.locked ? " (locked)" : ""}
              </TD>
              <TD className="text-foreground-soft">{r.overallClearance}</TD>
              <TD>
                <div className="flex items-center justify-end gap-2">
                  {r.trainingState !== "COMPLETE" && (
                    <form action={recordAttendanceAction.bind(null, id, r.personId)}>
                      <SubmitButton variant="outline" size="sm" pendingLabel="Recording…">
                        Record attendance
                      </SubmitButton>
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
