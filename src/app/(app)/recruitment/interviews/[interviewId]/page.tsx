import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { getInterview, listPanelistCandidates } from "@/modules/recruitment/services/interviews";
import { reviewScope } from "@/modules/recruitment/services/review";
import { evaluationSummary } from "@/modules/recruitment/engine/interview-eval";
import { scheduleAction, addPanelistAction, removePanelistAction, sendInviteAction, decideAction, rescindAcceptanceAction, submitEvaluationAction } from "../actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { interviewDetailTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Field, Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { AddPanelistForm } from "./add-panelist-form";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";

const RECS = ["STRONG_YES", "YES", "MAYBE", "NO"];
const decisionTone = { PENDING: "default", ACCEPT: "success", REJECT: "critical", WAITLIST: "warning" } as const;

export default async function InterviewDetail({ params, searchParams }: { params: Promise<{ interviewId: string }>; searchParams: Promise<{ error?: string }> }) {
  const { interviewId } = await params;
  const { error } = await searchParams;
  const person = await requirePersonSession();
  const iv = await getInterview(interviewId);
  if (!iv) notFound();
  const [scope, managesCycles] = await Promise.all([reviewScope(person.personId), can(person.personId, "recruitment.manage_cycles")]);
  const isPanelist = iv.panelists.some((p) => p.person.id === person.personId);
  // This page sits outside the recruitment.access module gate so panelists (who
  // are not recruitment staff) can reach their assigned interview. Access is
  // therefore enforced here: canView admits cycle staff and panelists; canManage
  // gates the action controls and matches the service authz exactly (scope.all or
  // the interview's department is in the actor's review scope) so a control is
  // never shown to someone whose submit would be rejected.
  const isStaff = scope.all || managesCycles || scope.departmentCodes.includes(iv.departmentCode);
  const canView = isStaff || isPanelist;
  if (!canView) notFound();
  const canManage = scope.all || scope.departmentCodes.includes(iv.departmentCode);
  const candidates = canManage ? await listPanelistCandidates(interviewId) : [];
  const summary = evaluationSummary(iv.evaluations);
  const scheduledValue = iv.scheduledAt ? new Date(iv.scheduledAt.getTime() - iv.scheduledAt.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
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
        action={<Badge tone={decisionTone[iv.decision as keyof typeof decisionTone] ?? "default"}>{iv.decision}</Badge>}
      />
      {error && <Alert tone="error">{error}</Alert>}

      {canManage && (
        <>
          <Card>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Schedule</h2>
            <form action={scheduleAction.bind(null, interviewId)} className="mt-3 space-y-3">
              <Field label="Time">
                <Input type="datetime-local" name="scheduledAt" defaultValue={scheduledValue} />
              </Field>
              <Field label="Zoom link">
                <Input name="zoomLink" defaultValue={iv.zoomLink ?? ""} />
              </Field>
              <Field label="Notes">
                <Input name="notes" defaultValue={iv.notes ?? ""} />
              </Field>
              <FormActions>
                <SubmitButton size="sm" pendingLabel="Saving…">Save</SubmitButton>
              </FormActions>
            </form>
            <form action={sendInviteAction.bind(null, interviewId)} className="mt-4 flex items-center gap-3 border-t border-border-subtle pt-4">
              <SubmitButton size="sm" variant="outline" pendingLabel="Sending…">
                {iv.invitedAt ? "Resend invite" : "Send invite"}
              </SubmitButton>
              {iv.invitedAt && <span className="text-xs text-subtle-foreground">sent {iv.invitedAt.toLocaleString()}</span>}
            </form>
          </Card>

          <Card>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Panel</h2>
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

      <Card>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Evaluations ({summary.total})</h2>
        <p className="mt-1 text-xs text-subtle-foreground">
          Strong yes {summary.strongYes} · Yes {summary.yes} · Maybe {summary.maybe} · No {summary.no}
        </p>
        {iv.evaluations.length > 0 ? (
          <ul className="mt-3 divide-y divide-border-subtle">
            {iv.evaluations.map((e) => (
              <li key={e.id} className="py-2 text-sm text-foreground-soft">
                <strong className="text-foreground">{e.evaluator.name}</strong>: {e.recommendation.replace("_", " ")}
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
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Decision</h2>
          {emailedAcceptance && (
            <div className="mt-3 space-y-3">
              <Alert tone="warning">
                This applicant has already been emailed their acceptance for {iv.departmentCode}. Changing the decision to Reject or Waitlist is blocked until the acceptance is rescinded.{" "}
                {scope.all ? "Rescind it below, then record the new decision." : "Ask an SRR to rescind it first."}
              </Alert>
              {scope.all && (
                <form action={rescindAcceptanceAction.bind(null, interviewId, emailedAcceptance.id)}>
                  <ConfirmButton label="Rescind acceptance" size="sm" />
                </form>
              )}
            </div>
          )}
          <form action={decideAction.bind(null, interviewId)} className="mt-3 flex flex-wrap items-end gap-3">
            <div className="w-40">
              <Field label="Outcome">
                <Select name="outcome" required>
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
          <p className="mt-2 text-xs text-subtle-foreground">Accept creates an acceptance, released from the Decisions page.</p>
        </Card>
      )}

      {isPanelist && (
        <Card>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Your evaluation</h2>
          <form action={submitEvaluationAction.bind(null, interviewId)} className="mt-3 flex flex-wrap items-end gap-3">
            <div className="w-44">
              <Field label="Recommendation">
                <Select name="recommendation" required defaultValue={myEval?.recommendation ?? ""}>
                  <option value="" disabled>
                    Select…
                  </option>
                  {RECS.map((r) => (
                    <option key={r} value={r}>
                      {r.replace("_", " ")}
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
