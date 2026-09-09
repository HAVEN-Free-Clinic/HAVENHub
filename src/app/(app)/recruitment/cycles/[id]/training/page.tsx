import { notFound } from "next/navigation";
import { requirePermission, requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listTrainingRoster, TrainingStateError } from "@/modules/recruitment/services/training";
import { resolveAttendanceAuthority } from "@/modules/recruitment/services/attendance-events";
import {
  clearApplicantExcuseAction,
  clearExcuseAction,
  excuseAbsenceAction,
  excuseApplicantAbsenceAction,
  recordApplicantAttendanceAction,
  recordAttendanceAction,
  resetTrainingAction,
  startCheckInAction,
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
import { StatusBadge } from "@/platform/ui/status-badge";
import {
  clearanceLabel,
  complianceStatusLabel,
  trainingStateLabel,
} from "@/platform/compliance/labels";
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
  const [canExcuse, attendanceAuthority, zone] = await Promise.all([
    can(viewer.personId, "recruitment.manage_cycles"),
    resolveAttendanceAuthority(viewer.personId),
    getDisplayTimeZone(),
  ]);
  const canCheckIn = attendanceAuthority.all || attendanceAuthority.departmentCodes.length > 0;
  // Clinic-wide only: an accepted applicant's attendance is an unlinked row.
  const canRecordApplicants = attendanceAuthority.all;

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
    // 5xl, not the original 3xl: three of the six columns now carry a status
    // chip that must not wrap, and the two row actions sit beside them. At the
    // old width the chips folded; one step up and "Record attendance" folded
    // instead.
    <div className="max-w-5xl space-y-6">
      <SetBreadcrumb trail={trail} />
      <PageHeader
        title="Training"
        description={cycle.title}
        // The roster below is the after-the-fact surface: it corrects a record,
        // one person at a time, for people already on it. Taking attendance at
        // the session itself is a different job with a different shape -- fast,
        // one screen, and including everyone accepted whether or not they have
        // onboarded -- and this is the way into it.
        action={
          canCheckIn ? (
            <form action={startCheckInAction.bind(null, id)}>
              <SubmitButton pendingLabel="Opening…">Start check-in</SubmitButton>
            </form>
          ) : undefined
        }
      />
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
            <TR key={`${r.kind === "member" ? r.personId : r.acceptanceId}-${r.departmentCode}`}>
              {/* No second badge under the name. The Overall column now reads
                  "Not onboarded" for exactly these rows, and two chips saying the
                  same thing is how a table stops being scannable. */}
              <TD className="font-medium text-foreground">{r.name}</TD>
              <TD className="text-foreground-soft">{r.departmentCode}</TD>
              {/* No Person means no HipaaCertificate can exist yet: promotion is
                  what creates both, from whatever they uploaded with their
                  contract. An em-dash, matching how the other tables here render
                  a cell with genuinely nothing in it. */}
              <TD className="text-foreground-soft">
                {r.kind === "applicant" ? <>-</> : <StatusBadge {...complianceStatusLabel(r.certStatus, "staff")} />}
              </TD>
              <TD className="text-foreground-soft">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge {...trainingStateLabel(r.trainingState)} />
                    {r.locked && <Badge tone="critical">Locked</Badge>}
                    {/* Shown even once training is complete: "Complete, Excused" is
                        the true story of someone who missed the session with warning
                        and finished by makeup quiz, and keeping the record is the
                        point of recording it. */}
                    {r.excuse && <Badge tone="warning">Excused</Badge>}
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
              <TD className="text-foreground-soft">
                <StatusBadge {...clearanceLabel(r.overallClearance)} />
              </TD>
              <TD>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {/* Recording an applicant writes an UNLINKED row, which is a
                      clinic-wide assertion with no department behind it -- the
                      same reason a scoped director may not add walk-ups at the
                      door (see authorizeTarget). They still SEE the row, because
                      reading it is departmental; they just cannot press this. */}
                  {r.trainingState !== "COMPLETE" &&
                    (r.kind === "member" ? (
                      <form action={recordAttendanceAction.bind(null, id, r.personId)}>
                        <SubmitButton variant="outline" size="sm" pendingLabel="Recording…">
                          Record attendance
                        </SubmitButton>
                      </form>
                    ) : (
                      canRecordApplicants && (
                        <form
                          action={recordApplicantAttendanceAction.bind(null, id, r.acceptanceId)}
                        >
                          <SubmitButton variant="outline" size="sm" pendingLabel="Recording…">
                            Record attendance
                          </SubmitButton>
                        </form>
                      )
                    ))}
                  {/* Offered even on a COMPLETE row: an excuse is a record, and a
                      lead may only get to writing one down after the person has
                      already caught up by makeup quiz. */}
                  {canExcuse && (
                    <ExcuseAbsenceButton
                      name={r.name}
                      currentReason={r.excuse?.reason ?? null}
                      action={
                        r.kind === "member"
                          ? excuseAbsenceAction.bind(null, id, r.personId)
                          : excuseApplicantAbsenceAction.bind(null, id, r.applicantId)
                      }
                    />
                  )}
                  {canExcuse && r.excuse && (
                    <form
                      action={
                        r.kind === "member"
                          ? clearExcuseAction.bind(null, id, r.personId)
                          : clearApplicantExcuseAction.bind(null, id, r.applicantId)
                      }
                    >
                      <ConfirmButton label="Clear excuse" size="sm" />
                    </form>
                  )}
                  {r.kind === "member" && r.locked && (
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
                No {cycle.track === "DIRECTOR" ? "directors" : "volunteers"} in scope, either
                accepted into this cycle or on the term roster for it.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
