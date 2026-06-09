import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { getInterview } from "@/modules/recruitment/services/interviews";
import { reviewScope } from "@/modules/recruitment/services/review";
import { evaluationSummary } from "@/modules/recruitment/engine/interview-eval";
import { scheduleAction, addPanelistAction, removePanelistAction, sendInviteAction, decideAction } from "../actions";

export default async function InterviewDetail({ params, searchParams }: { params: Promise<{ id: string; interviewId: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id, interviewId } = await params;
  const { error } = await searchParams;
  const person = await requirePersonSession();
  const iv = await getInterview(interviewId);
  if (!iv || iv.application.cycle.id !== id) notFound();
  const [scope, managesCycles] = await Promise.all([reviewScope(person.personId), can(person.personId, "recruitment.manage_cycles")]);
  const isPanelist = iv.panelists.some((p) => p.person.id === person.personId);
  // canView gates the page (cycle admins and panelists may read it); canManage
  // gates the action controls and matches the service authz exactly (scope.all
  // or the interview's department is in the actor's review scope) so a control
  // is never shown to someone whose submit would be rejected.
  const canView = scope.all || managesCycles || scope.departmentCodes.includes(iv.departmentCode) || isPanelist;
  if (!canView) notFound();
  const canManage = scope.all || scope.departmentCodes.includes(iv.departmentCode);
  const summary = evaluationSummary(iv.evaluations);
  const scheduledValue = iv.scheduledAt ? new Date(iv.scheduledAt.getTime() - iv.scheduledAt.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{iv.application.applicant.firstName} {iv.application.applicant.lastName}</h1>
      <p className="text-sm text-slate-500">{iv.departmentCode} director interview · {iv.decision}</p>
      {error && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {canManage && (
        <>
          <section className="rounded border p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Schedule</h2>
            <form action={scheduleAction.bind(null, id, interviewId)} className="mt-3 space-y-2 text-sm">
              <label className="block">Time<input type="datetime-local" name="scheduledAt" defaultValue={scheduledValue} className="mt-1 w-full rounded border px-2 py-1" /></label>
              <label className="block">Zoom link<input name="zoomLink" defaultValue={iv.zoomLink ?? ""} className="mt-1 w-full rounded border px-2 py-1" /></label>
              <label className="block">Notes<input name="notes" defaultValue={iv.notes ?? ""} className="mt-1 w-full rounded border px-2 py-1" /></label>
              <button className="rounded bg-slate-900 px-2 py-1 text-white">Save</button>
            </form>
            <form action={sendInviteAction.bind(null, id, interviewId)} className="mt-3">
              <button className="rounded-md border px-3 py-1.5 text-sm">{iv.invitedAt ? "Resend invite" : "Send invite"}</button>
              {iv.invitedAt && <span className="ml-2 text-xs text-slate-500">sent {iv.invitedAt.toLocaleString()}</span>}
            </form>
          </section>

          <section className="rounded border p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Panel</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {iv.panelists.map((p) => (
                <li key={p.id} className="flex items-center justify-between border-t py-1">
                  <span>{p.person.name}{p.isLead ? " (lead)" : ""}</span>
                  <form action={removePanelistAction.bind(null, id, interviewId, p.id)}><button className="text-xs text-red-600">Remove</button></form>
                </li>
              ))}
            </ul>
            <form action={addPanelistAction.bind(null, id, interviewId)} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
              <input name="personId" placeholder="person id" required className="rounded border px-2 py-1" />
              <label className="flex items-center gap-1"><input type="checkbox" name="isLead" /> lead</label>
              <button className="rounded bg-slate-900 px-2 py-1 text-white">Add panelist</button>
            </form>
            <p className="mt-1 text-xs text-slate-500">Panel members can submit an evaluation from their My interviews page.</p>
          </section>
        </>
      )}

      <section className="rounded border p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Evaluations ({summary.total})</h2>
        <p className="mt-1 text-xs text-slate-500">Strong yes {summary.strongYes} · Yes {summary.yes} · Maybe {summary.maybe} · No {summary.no}</p>
        <ul className="mt-2 space-y-1 text-sm">
          {iv.evaluations.map((e) => (<li key={e.id} className="border-t py-1"><strong>{e.evaluator.name}</strong>: {e.recommendation}{e.comments ? ` (${e.comments})` : ""}</li>))}
          {iv.evaluations.length === 0 && <li className="text-slate-500">No evaluations yet.</li>}
        </ul>
      </section>

      {canManage && (
        <section className="rounded border p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Decision</h2>
          <form action={decideAction.bind(null, id, interviewId)} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
            <select name="outcome" required className="rounded border px-2 py-1"><option value="ACCEPT">Accept</option><option value="REJECT">Reject</option><option value="WAITLIST">Waitlist</option></select>
            <input name="notes" placeholder="notes (optional)" className="rounded border px-2 py-1" />
            <button className="rounded bg-slate-900 px-2 py-1 text-white">Record decision</button>
          </form>
          <p className="mt-1 text-xs text-slate-500">Accept creates an acceptance, released from the Decisions page.</p>
        </section>
      )}

      {isPanelist && <div data-evaluator-slot />}
    </div>
  );
}
