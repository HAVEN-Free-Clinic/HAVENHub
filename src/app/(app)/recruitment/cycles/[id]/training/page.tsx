import { notFound, redirect } from "next/navigation";
import { PageBody } from "@/platform/ui/page-body";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listTrainingRoster, TrainingStateError } from "@/modules/recruitment/services/training";
import type { TrainingRosterRow } from "@/modules/recruitment/services/training";
import { reviewScope } from "@/modules/recruitment/services/review";
import {
  findTrainingEventForCycle,
  resolveAttendanceAuthority,
} from "@/modules/recruitment/services/attendance-events";
import {
  clearApplicantExcuseAction,
  clearExcuseAction,
  excuseAbsenceAction,
  excuseApplicantAbsenceAction,
  recordApplicantAttendanceAction,
  recordAttendanceAction,
  recordExpectedAttendanceAction,
  resetTrainingAction,
  startCheckInAction,
  markMockClinicDoneAction,
  undoMockClinicMarkOffAction,
  releaseMakeupAction,
  setMakeupDueDateAction,
} from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { getMakeupReleaseState, type MakeupReleaseState } from "@/modules/recruitment/services/makeup-release";
import { formatForDateInput } from "@/platform/dates";
import { Input } from "@/platform/ui/input";
import { FormRow, RowField } from "@/platform/ui/form";
import { TextLink } from "@/platform/ui/text-link";
import { ExcuseAbsenceButton } from "@/modules/recruitment/components/excuse-absence-button";
import { MarkMockClinicButton } from "@/modules/recruitment/components/mark-mock-clinic-button";
import {
  ROSTER_ORIGIN_LABELS,
  ROSTER_ORIGIN_TITLES,
} from "@/modules/recruitment/components/status-badge";
import { formatDateOnly } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { EmptyState } from "@/platform/ui/empty-state";
import { Badge } from "@/platform/ui/badge";
import { StatusBadge } from "@/platform/ui/status-badge";
import {
  clearanceLabel,
  complianceStatusLabel,
  trainingPartLabel,
  trainingStateLabel,
} from "@/platform/compliance/labels";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";

export default async function TrainingRosterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requirePersonSession();
  // Deliberately NOT requirePermission("recruitment.access"), which the Director
  // role does not grant: a department director's only sight of who will miss the
  // session is this page, and being told the week before is the whole point of
  // recording an excuse. listTrainingRoster already scopes every row through
  // reviewScope -> manageableDepartmentIds, so a director sees their own people
  // and nobody else's, and every write below still answers to manage_cycles.
  // cycleNavItems carries the identical gate; the two must move together or the
  // tab dead-ends on a page that refuses the viewer.
  const [hasAccess, scope] = await Promise.all([
    can(viewer.personId, "recruitment.access"),
    reviewScope(viewer.personId),
  ]);
  if (!hasAccess && !scope.all && scope.departmentCodes.length === 0) redirect("/no-access");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const trail = cycleTrail({ cycleId: id, cycleTitle: cycle.title, section: { label: "Training", slug: "training" } });

  // Excusing an absence is a lead's call, not a department director's: it is the
  // clinic deciding somebody is not at fault, and it is the leads who receive the
  // emails these excuses come out of. Directors still see the badge.
  const [canExcuse, attendanceAuthority, trainingEvent, zone] = await Promise.all([
    can(viewer.personId, "recruitment.manage_cycles"),
    resolveAttendanceAuthority(viewer.personId),
    findTrainingEventForCycle(id),
    getDisplayTimeZone(),
  ]);
  const canCheckIn = attendanceAuthority.all || attendanceAuthority.departmentCodes.length > 0;
  // Opening check-in CREATES the cycle's TRAINING event, and creating one is a
  // lead's write (requireEventManager). Offered on authority alone, the button
  // refused every scoped director who pressed it before a lead had opened the
  // session. Once the event exists, anyone with check-in authority works the door.
  const canStartCheckIn = canCheckIn && (canExcuse || trainingEvent !== null);
  // Clinic-wide only: an accepted applicant's attendance is an unlinked row.
  const canRecordApplicants = attendanceAuthority.all;
  // Also clinic-wide only: the director confirms a mock clinic make-up, and IT,
  // who holds clinic-wide attendance authority, marks it off.
  const canMarkMockClinic = attendanceAuthority.all;
  // Releasing is a lead's call, like releasing decisions: it emails everyone who
  // owes a part, including the reprimand for an unexcused absence.
  const makeup = canExcuse ? await getMakeupReleaseState(id) : null;

  let rows;
  try {
    rows = await listTrainingRoster(id, viewer.personId);
  } catch (e) {
    if (e instanceof TrainingStateError) {
      return (
        <PageBody width="form">
          <SetBreadcrumb trail={trail} />
          <PageHeader title="Training" description={cycle.title} />
          <Alert tone="warning">
            {e.message} Set this cycle as the term training cycle from the overview.
          </Alert>
        </PageBody>
      );
    }
    throw e;
  }

  // A department director got here by review scope alone, and the only thing on
  // this page that is theirs is who will be missing. Everything else is
  // recruitment-staff work: correcting a record one row at a time, opening the
  // door, writing or withdrawing an excuse. Showing them the roster would be a
  // table of controls that either refuse them or belong to somebody else, so
  // they get the section by itself. recruitment.access is the line, which is the
  // same line cycleNavItems draws: admitted BY the permission gets the working
  // surface, admitted by scope gets the answer.
  if (!hasAccess) {
    return (
      <PageBody width="wide">
        <SetBreadcrumb trail={trail} />
        <PageHeader
          title="Training"
          description={`${cycle.title}: who in your departments has told us they will miss the in-person session.`}
        />
        <ExcusedSection rows={rows} zone={zone} />
      </PageBody>
    );
  }

  return (
    // 6xl, not the original 3xl: three of the seven columns carry a status chip
    // that must not wrap, the two row actions sit beside them, and the Cert
    // column now draws a chip on every row rather than a dash on half of them.
    // At 3xl the chips folded; at 5xl "Record attendance" folded instead.
    <PageBody width="full">
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
          canStartCheckIn ? (
            <form action={startCheckInAction.bind(null, id)}>
              <SubmitButton pendingLabel="Opening…">Start check-in</SubmitButton>
            </form>
          ) : undefined
        }
      />
      {makeup && <MakeupReleaseCard cycleId={id} state={makeup} zone={zone} />}
      <TrainingDaySummary rows={rows} />
      <ExcusedSection rows={rows} zone={zone} />
      <Table>
        <THead>
          <tr>
            <TH>{cycle.track === "DIRECTOR" ? "Director" : "Volunteer"}</TH>
            <TH>Dept</TH>
            <TH>Type</TH>
            <TH>Cert</TH>
            <TH>Training</TH>
            <TH>Overall</TH>
            <TH className="text-right">Actions</TH>
          </tr>
        </THead>
        <tbody>
          {rows.map((r) => (
            <TR key={rosterRowKey(r)}>
              {/* No second badge under the name. The Overall column now reads
                  "Not onboarded" for exactly these rows, and two chips saying the
                  same thing is how a table stops being scannable. */}
              <TD className="font-medium text-foreground">{r.name}</TD>
              <TD className="text-foreground-soft">{r.departmentCode}</TD>
              {/* Whether the clinic has trained this person before, which is the
                  question a trainer asks about every name on the sheet. The
                  absent-value marker (#796) when neither the cycle's
                  applications nor a previous term's roster can answer it. */}
              <TD className="text-foreground-soft">
                {r.origin ? (
                  <span title={ROSTER_ORIGIN_TITLES[r.origin]}>{ROSTER_ORIGIN_LABELS[r.origin]}</span>
                ) : (
                  <>-</>
                )}
              </TD>
              {/* Before promotion a certificate can be in two places -- on the
                  account a returning volunteer already has, and on the contract
                  the applicant just filed -- and the roster reads both. The
                  title says so, since a status on a row for somebody with no
                  membership yet is otherwise a puzzle. */}
              <TD className="text-foreground-soft">
                <StatusBadge
                  {...complianceStatusLabel(r.certStatus, "staff")}
                  title={
                    r.kind === "applicant"
                      ? "From the certificate on their hub account, if they have one, and the one attached to their onboarding contract. The contract's copy becomes a HIPAA certificate when the contract is promoted."
                      : undefined
                  }
                />
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
                  {/* The two parts of training day, which the one chip above
                      rolls up: a morning check-in no longer finishes training
                      for someone who still owes mock clinic. */}
                  <dl className="grid grid-cols-[auto_auto] items-center justify-start gap-x-2 gap-y-1 text-xs">
                    <dt className="text-subtle-foreground">Morning</dt>
                    <dd><StatusBadge {...trainingPartLabel(r.morning)} /></dd>
                    <dt className="text-subtle-foreground">Mock clinic</dt>
                    <dd><StatusBadge {...trainingPartLabel(r.mockClinic)} /></dd>
                  </dl>
                  {r.mockClinicMarkOff && (
                    <p className="line-clamp-2 text-xs text-subtle-foreground">
                      {r.mockClinicMarkOff.note}
                      {" ("}
                      {r.mockClinicMarkOff.byName ? `${r.mockClinicMarkOff.byName}, ` : ""}
                      {formatDateOnly(r.mockClinicMarkOff.at, zone)}
                      {")"}
                    </p>
                  )}
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
                  {r.morning !== "ATTENDED" &&
                    (r.kind === "member" ? (
                      <form action={recordAttendanceAction.bind(null, id, r.personId)}>
                        <SubmitButton variant="outline" size="sm" pendingLabel="Recording…">
                          Record attendance
                        </SubmitButton>
                      </form>
                    ) : (
                      canRecordApplicants && (
                        <form
                          action={
                            r.kind === "applicant"
                              ? recordApplicantAttendanceAction.bind(null, id, r.acceptanceId)
                              : // Held for a language evaluation: no acceptance to
                                // check in against, so this writes a walk-up keyed
                                // on their address instead.
                                recordExpectedAttendanceAction.bind(null, id, r.applicantId)
                          }
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
                      <ConfirmButton label="Clear excuse" confirmLabel="Clear this excuse?" size="sm" />
                    </form>
                  )}
                  {canMarkMockClinic && r.kind === "member" && r.mockClinic === "OWED" && (
                    <MarkMockClinicButton
                      name={r.name}
                      action={markMockClinicDoneAction.bind(null, id, r.personId)}
                    />
                  )}
                  {canMarkMockClinic && r.kind === "member" && r.mockClinicMarkOff && (
                    <form action={undoMockClinicMarkOffAction.bind(null, id, r.personId)}>
                      <ConfirmButton label="Undo mark-off" confirmLabel="Remove this mock clinic mark-off?" size="sm" />
                    </form>
                  )}
                  {r.kind === "member" && r.locked && (
                    <form action={resetTrainingAction.bind(null, id, r.personId)}>
                      <ConfirmButton label="Reset" confirmLabel="Reset this member's makeup lockout?" size="sm" />
                    </form>
                  )}
                </div>
              </TD>
            </TR>
          ))}
          {rows.length === 0 && (
            <TR>
              <TD colSpan={7} className="py-10 text-center text-subtle-foreground">
                No {cycle.track === "DIRECTOR" ? "directors" : "volunteers"} in scope, either
                accepted into this cycle or on the term roster for it.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </PageBody>
  );
}

/**
 * Releasing the online makeup training, and what it will do when pressed.
 *
 * Deliberately shows the counts BEFORE the button: releasing sends an email
 * that tells people their absence was unacceptable, and the one thing a lead
 * needs before pressing it is how many people that is.
 */
function MakeupReleaseCard({ cycleId, state, zone }: { cycleId: string; state: MakeupReleaseState; zone: string }) {
  const ready = state.course?.ready ?? false;
  return (
    <Card>
      <SectionHeader level="card" className="mb-3">Online makeup training</SectionHeader>
      <div className="space-y-3">
        {!state.course ? (
          <Alert tone="info">
            No makeup course is linked to this cycle yet. Create a video course in Learning, upload
            the recording, write its quiz questions, then link it to this cycle.
          </Alert>
        ) : !ready ? (
          <Alert tone="warning">
            <TextLink href={`/learning/manage/${state.course.id}`}>{state.course.title}</TextLink> is
            not ready yet: every section needs a video and the course must be active. Releasing is
            blocked until it is, so nobody is emailed a link to an empty course.
          </Alert>
        ) : (
          <p className="text-sm text-foreground-soft">
            Course:{" "}
            <TextLink href={`/learning/manage/${state.course.id}`}>{state.course.title}</TextLink>
          </p>
        )}

        <form action={setMakeupDueDateAction.bind(null, cycleId)}>
          <FormRow>
            <RowField label="Due date">
              <Input
                name="makeupDueAt"
                type="date"
                defaultValue={state.dueAt ? formatForDateInput(state.dueAt, zone) : ""}
              />
            </RowField>
            <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save due date</SubmitButton>
          </FormRow>
        </form>

        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <Count label="Owe the course" value={state.owesMorning} />
          <Count label="Owe mock clinic" value={state.owesMockClinic} />
          <Count label="Accepted, no contract yet" value={state.notOnboarded} />
          <Count label="Emailed" value={state.emailed} />
        </dl>

        {state.releasedAt ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-foreground-soft">
              Released {formatDateOnly(state.releasedAt, zone)}. Anyone who still owes a part is
              chased by email every three days until they finish.
            </p>
            <form action={releaseMakeupAction.bind(null, cycleId)}>
              <SubmitButton size="sm" variant="outline" pendingLabel="Sending…">
                Email anyone not yet told
              </SubmitButton>
            </form>
          </div>
        ) : (
          <form action={releaseMakeupAction.bind(null, cycleId)}>
            <SubmitButton disabled={!ready} pendingLabel="Releasing…">
              Release makeup training
            </SubmitButton>
          </form>
        )}
      </div>
    </Card>
  );
}

/**
 * How much follow-up this session left, in three numbers.
 *
 * The table below answers it one row at a time, which is the wrong shape for
 * the question staff actually arrive with after training day: how many people
 * do we still have to chase, and for which of the two parts. Counted off the
 * rows the page already fetched, so it costs no query and is scoped exactly as
 * they are.
 */
function TrainingDaySummary({ rows }: { rows: TrainingRosterRow[] }) {
  const members = rows.filter((r) => r.kind === "member");
  const owesMorning = members.filter((r) => r.morning === "OWED").length;
  const owesMockClinic = members.filter((r) => r.mockClinic === "OWED").length;
  const clear = members.filter((r) => r.trainingState === "COMPLETE").length;
  return (
    <Card>
      <SectionHeader level="card" className="mb-3">Training day</SectionHeader>
      {members.length === 0 ? (
        <EmptyState inline>Nobody on the term roster for this cycle yet.</EmptyState>
      ) : (
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <Count label="Cleared" value={clear} />
          <Count label="Owe the online makeup course" value={owesMorning} />
          <Count label="Owe mock clinic" value={owesMockClinic} />
        </dl>
      )}
    </Card>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-subtle-foreground">{label}</dt>
      <dd className="text-lg font-semibold text-foreground">{value}</dd>
    </div>
  );
}

/** Stable key for a roster row. The union's three shapes carry three different
 *  ids, and one person can hold a row per department they were accepted into. */
function rosterRowKey(r: TrainingRosterRow): string {
  const id = r.kind === "member" ? r.personId : r.kind === "applicant" ? r.acceptanceId : r.applicantId;
  return `${id}-${r.departmentCode}`;
}

/**
 * Who has told the clinic, ahead of the day, that they will not be there.
 *
 * The table below answers "where does everyone stand", one row per person, and
 * an Excused badge inside sixty of those rows is not an answer to the question a
 * director opens this page with: who on my team is going to be missing. Reads
 * the rows the page already fetched, so it costs no query and inherits their
 * scoping exactly -- a director sees their departments, a lead sees the clinic.
 *
 * Each line keeps its training chip, because "excused" and "excused, and already
 * caught up by makeup quiz" are different facts and only one is outstanding.
 */
function ExcusedSection({ rows, zone }: { rows: TrainingRosterRow[]; zone: string }) {
  // flatMap rather than filter: it narrows the excuse out of the union, so the
  // fields below are read off a value TypeScript knows is there.
  const excused = rows.flatMap((r) => (r.excuse ? [{ row: r, excuse: r.excuse }] : []));
  return (
    <Card>
      <SectionHeader level="card" className="mb-3">
        Excused from the in-person session{excused.length > 0 ? ` (${excused.length})` : ""}
      </SectionHeader>
      {excused.length === 0 ? (
        <EmptyState inline>No excused absences recorded for this session.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {excused.map(({ row, excuse }) => (
            <li key={rosterRowKey(row)} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-medium text-foreground">{row.name}</span>
              <span className="text-foreground-soft">{row.departmentCode}</span>
              <StatusBadge {...trainingStateLabel(row.trainingState)} />
              <span className="text-subtle-foreground">
                {excuse.reason}
                {" ("}
                {excuse.recordedByName ? `${excuse.recordedByName}, ` : ""}
                {formatDateOnly(excuse.recordedAt, zone)}
                {")"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
