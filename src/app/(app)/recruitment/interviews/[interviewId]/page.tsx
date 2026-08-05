import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { DateTime } from "@/platform/dates/display";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { zoneLabel } from "@/platform/dates/zone";
import { formatForDateTimeInput } from "@/platform/dates";
import { can } from "@/platform/rbac/engine";
import { getInterview, listPanelistCandidates } from "@/modules/recruitment/services/interviews";
import { reviewScope } from "@/modules/recruitment/services/review";
import { evaluationSummary } from "@/modules/recruitment/engine/interview-eval";
import { scheduleAction, addPanelistAction, removePanelistAction, sendInviteAction, decideAction, rescindAcceptanceAction, submitEvaluationAction } from "../actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { interviewDetailTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Badge } from "@/platform/ui/badge";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { AddPanelistForm } from "./add-panelist-form";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { RescindAcceptanceNotice } from "@/modules/recruitment/components/rescind-acceptance-notice";

const SCORES = [1, 2, 3, 4, 5];
const decisionTone = { PENDING: "default", ACCEPT: "success", REJECT: "critical", WAITLIST: "warning" } as const;
const decisionLabel = { PENDING: "Pending", ACCEPT: "Accepted", REJECT: "Rejected", WAITLIST: "Waitlisted" } as const;

export default async function InterviewDetail({ params }: { params: Promise<{ interviewId: string }> }) {
  const { interviewId } = await params;
  const person = await requirePersonSession();
  const iv = await getInterview(interviewId);
  if (!iv) notFound();
  const [scope, managesCycles, canScore] = await Promise.all([
    reviewScope(person.personId),
    can(person.personId, "recruitment.manage_cycles"),
    can(person.personId, "recruitment.score"),
  ]);
  const isPanelist = iv.panelists.some((p) => p.person.id === person.personId);
  // This page sits outside the recruitment.access module gate so panelists (who
  // are not recruitment staff) can reach their assigned interview. Access is
  // therefore enforced here: canView admits cycle staff, committee scorers (who
  // can already open the application detail that links here, so the link must not
  // 404 on them), and panelists; canManage gates the action controls and matches
  // the service authz exactly (scope.all or the interview's department is in the
  // actor's review scope) so a control is never shown to someone whose submit
  // would be rejected. A scorer gets canManage=false, so this stays read-only.
  const isStaff = scope.all || managesCycles || scope.departmentCodes.includes(iv.departmentCode);
  const canView = isStaff || canScore || isPanelist;
  if (!canView) notFound();
  const canManage = scope.all || scope.departmentCodes.includes(iv.departmentCode);
  const candidates = canManage ? await listPanelistCandidates(interviewId) : [];
  const summary = evaluationSummary(iv.evaluations);
  const zone = await getDisplayTimeZone();
  const scheduledValue = formatForDateTimeInput(iv.scheduledAt, zone);
  const myEval = iv.evaluations.find((e) => e.evaluator.id === person.personId);
  // Once this department's acceptance has been emailed, the applicant has been
  // told they're in. decideInterview blocks moving the decision off ACCEPT until
  // the acceptance is rescinded, so warn here before the decider tries (issue #77).
  // Only an SRR (review_all) may rescind a notified acceptance, so the rescind
  // control is shown to them alone; a director is told to ask an SRR.
  const emailedAcceptance = iv.application.acceptances.find((a) => a.departmentCode === iv.departmentCode && a.emailedAt != null);

  return (
    <div className="max-w-2xl space-y-6">
      <SetBreadcrumb
        trail={interviewDetailTrail({
          staff: isStaff,
          cycleId: iv.application.cycle.id,
          cycleTitle: iv.application.cycle.title,
          candidate: `${iv.application.applicant.firstName} ${iv.application.applicant.lastName}`,
        })}
      />
      <PageHeader
        title={`${iv.application.applicant.firstName} ${iv.application.applicant.lastName}`}
        description={`${iv.departmentCode} director interview`}
        action={<Badge tone={decisionTone[iv.decision as keyof typeof decisionTone] ?? "default"}>{decisionLabel[iv.decision as keyof typeof decisionLabel] ?? iv.decision}</Badge>}
      />
      {canManage && (
        <>
          <Card>
            <SectionHeader>Schedule</SectionHeader>
            <form action={scheduleAction.bind(null, interviewId)} className="mt-3 space-y-3">
              <Field label="Time">
                <Input type="datetime-local" name="scheduledAt" defaultValue={scheduledValue} />
              </Field>
              <p className="text-xs text-muted-foreground">Times are in {zoneLabel(zone)}.</p>
              <Field label="Zoom link">
                <Input name="zoomLink" defaultValue={iv.zoomLink ?? ""} />
              </Field>
              <Field label="Notes" hint="Internal only. Not shared with the applicant.">
                <Input name="notes" defaultValue={iv.notes ?? ""} />
              </Field>
              <Field label="Note to applicant" hint="Included in the invitation email. Leave blank to send none.">
                <Textarea name="applicantNote" rows={3} defaultValue={iv.applicantNote ?? ""} />
              </Field>
              <FormActions>
                <SubmitButton size="sm" pendingLabel="Saving…">Save</SubmitButton>
              </FormActions>
            </form>
            <form action={sendInviteAction.bind(null, interviewId)} className="mt-4 flex items-center gap-3 border-t border-border-subtle pt-4">
              <SubmitButton size="sm" variant="outline" pendingLabel="Sending…">
                {iv.invitedAt ? "Resend invite" : "Send invite"}
              </SubmitButton>
              {iv.invitedAt && <span className="text-xs text-subtle-foreground">sent <DateTime value={iv.invitedAt} /></span>}
            </form>
          </Card>

          <Card>
            <SectionHeader>Panel</SectionHeader>
            {iv.panelists.length > 0 ? (
              <ul className="mt-3 divide-y divide-border-subtle">
                {iv.panelists.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                    <span className="text-foreground-soft">
                      {p.person.name}
                      {p.isLead && <Badge tone="brand" className="ml-2">lead</Badge>}
                    </span>
                    <form action={removePanelistAction.bind(null, interviewId, p.id)}>
                      <ConfirmButton label="Remove" size="sm" />
                    </form>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No panelists yet.</p>
            )}
            <AddPanelistForm action={addPanelistAction.bind(null, interviewId)} candidates={candidates} />
            <p className="mt-2 text-xs text-subtle-foreground">Panel members can submit an evaluation from their My interviews page.</p>
          </Card>
        </>
      )}

      {isPanelist && !canManage && (
        <Card>
          <SectionHeader>Schedule</SectionHeader>
          <dl className="mt-3 space-y-3 text-sm">
            <div>
              <dt className="text-xs text-subtle-foreground">Time</dt>
              <dd className="text-foreground"><DateTime value={iv.scheduledAt} fallback="To be determined" /></dd>
            </div>
            <div>
              <dt className="text-xs text-subtle-foreground">Zoom link</dt>
              <dd>
                {iv.zoomLink ? (
                  <a
                    className="break-all font-medium text-brand-fg hover:text-brand-hover"
                    href={iv.zoomLink}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {iv.zoomLink}
                  </a>
                ) : (
                  <span className="text-muted-foreground">Not shared yet</span>
                )}
              </dd>
            </div>
          </dl>
        </Card>
      )}

      <Card>
        <SectionHeader>Evaluations ({summary.count})</SectionHeader>
        <p className="mt-1 text-xs text-subtle-foreground">
          Average {summary.average != null ? summary.average.toFixed(1) : "-"}
        </p>
        {iv.evaluations.length > 0 ? (
          <ul className="mt-3 divide-y divide-border-subtle">
            {iv.evaluations.map((e) => (
              <li key={e.id} className="py-2 text-sm text-foreground-soft">
                <strong className="text-foreground">{e.evaluator.name}</strong>: {e.score}/5
                {e.comments ? ` (${e.comments})` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No evaluations yet.</p>
        )}
      </Card>

      {canManage && (
        <Card>
          <SectionHeader>Decision</SectionHeader>
          {emailedAcceptance && (
            <RescindAcceptanceNotice
              departmentCode={iv.departmentCode}
              canRescind={scope.all}
              action={rescindAcceptanceAction.bind(null, interviewId, emailedAcceptance.id)}
            />
          )}
          <form action={decideAction.bind(null, interviewId)} className="mt-3 flex flex-wrap items-end gap-3">
            <div className="w-40">
              <Field label="Outcome">
                <Select name="outcome" required defaultValue={iv.decision === "PENDING" ? "ACCEPT" : iv.decision}>
                  <option value="ACCEPT">Accept</option>
                  <option value="REJECT">Reject</option>
                  <option value="WAITLIST">Waitlist</option>
                </Select>
              </Field>
            </div>
            <div className="min-w-[12rem] flex-1">
              <Field label="Notes" hint="Optional.">
                <Input name="notes" />
              </Field>
            </div>
            <SubmitButton size="sm" pendingLabel="Recording…">Record decision</SubmitButton>
          </form>
          {iv.decision !== "PENDING" && iv.decidedAt && (
            <p className="mt-2 text-xs text-subtle-foreground">
              {decisionLabel[iv.decision as keyof typeof decisionLabel]} · recorded <DateTime value={iv.decidedAt} />
            </p>
          )}
          <p className="mt-2 text-xs text-subtle-foreground">Accept creates an acceptance, released from the Decisions page.</p>
        </Card>
      )}

      {isPanelist && (
        <Card>
          <SectionHeader>Your evaluation</SectionHeader>
          <form action={submitEvaluationAction.bind(null, interviewId)} className="mt-3 flex flex-wrap items-end gap-3">
            <div className="w-44">
              <Field label="Score (1-5)">
                <Select name="score" required defaultValue={myEval?.score != null ? String(myEval.score) : ""}>
                  <option value="" disabled>
                    Select…
                  </option>
                  {SCORES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="min-w-[12rem] flex-1">
              <Field label="Comments">
                <Input name="comments" defaultValue={myEval?.comments ?? ""} />
              </Field>
            </div>
            <SubmitButton size="sm" pendingLabel="Submitting…">Submit</SubmitButton>
          </form>
        </Card>
      )}
    </div>
  );
}
