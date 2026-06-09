import { notFound } from "next/navigation";
import { getApplication } from "@/modules/recruitment/services/submissions";
import { visibleSections } from "@/modules/recruitment/engine/visibility";
import { requirePersonSession } from "@/platform/auth/session";
import { reviewScope, listAcceptances } from "@/modules/recruitment/services/review";
import { can } from "@/platform/rbac/engine";
import { acceptApplicantAction, revokeAcceptanceAction, scheduleInterviewAction } from "../actions";
import { listApplicationInterviews } from "@/modules/recruitment/services/interviews";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";

export default async function ApplicationDetailPage({ params, searchParams }: { params: Promise<{ id: string; applicationId: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id, applicationId } = await params;
  const { error } = await searchParams;
  const app = await getApplication(applicationId);
  if (!app) notFound();
  const person = await requirePersonSession();
  if (app.cycleId !== id) notFound();
  const [scope, managesCycles, acceptances] = await Promise.all([
    reviewScope(person.personId),
    can(person.personId, "recruitment.manage_cycles"),
    listAcceptances(applicationId),
  ]);
  const seeAll = scope.all || managesCycles;
  const canView = seeAll || app.departmentChoices.some((d) => scope.departmentCodes.includes(d));
  if (!canView) notFound();
  const eligible = seeAll
    ? app.cycle.departments
    : app.cycle.departments.filter((d) => scope.departmentCodes.includes(d) && app.departmentChoices.includes(d));
  const accepted = new Set(acceptances.map((a) => a.departmentCode));
  const choices = eligible.filter((d) => !accepted.has(d));
  const existingInterviews = app.cycle.track === "DIRECTOR" ? await listApplicationInterviews(applicationId) : [];
  const interviewedDepts = new Set(existingInterviews.map((i) => i.departmentCode));
  const scheduleChoices = choices.filter((d) => !interviewedDepts.has(d));
  const answers = (app.answers ?? {}) as Record<string, unknown>;
  const sections = visibleSections(app.cycle.sections, {
    applicantType: app.applicantType,
    selectedDepartmentCodes: app.departmentChoices,
  });
  return (
    <div className="max-w-2xl space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: app.cycle.title,
          section: { label: "Applicants", slug: "applicants" },
          leaf: `${app.applicant.firstName} ${app.applicant.lastName}`,
        })}
      />
      <h1 className="text-2xl font-semibold tracking-tight">{app.applicant.firstName} {app.applicant.lastName}</h1>
      <p className="text-sm text-slate-500">{app.applicant.email} · {app.applicantType}{app.renewalDepartment ? ` · renewing in ${app.renewalDepartment}` : ""}</p>
      {sections.map((section) => (
        <section key={section.id}>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">{section.title}</h2>
          <dl className="mt-2 space-y-2">
            {section.fields.map((f) => {
              const val = answers[f.key];
              const display = f.type === "FILE" && val && typeof val === "object"
                ? (val as { fileName?: string }).fileName ?? "(file)"
                : Array.isArray(val) ? val.join(", ") : val === undefined || val === "" ? "(none)" : String(val);
              return (<div key={f.id}><dt className="text-xs text-slate-500">{f.label}</dt><dd className="text-sm">{display}</dd></div>);
            })}
          </dl>
        </section>
      ))}
      {app.cycle.track === "VOLUNTEER" ? (
        <section className="rounded border p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Decision</h2>
          {error && <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          {acceptances.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm">
              {acceptances.map((a) => (
                <li key={a.id} className="flex items-center justify-between border-t py-1">
                  <span>Accepted into <strong>{a.departmentCode}</strong>{a.notes ? `: ${a.notes}` : ""}{a.emailedAt ? " (notified)" : ""}</span>
                  <form action={revokeAcceptanceAction.bind(null, id, applicationId, a.id)}><button className="text-xs text-red-600">Revoke</button></form>
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-sm text-slate-500">No acceptances yet.</p>}
          {choices.length > 0 && (
            <form action={acceptApplicantAction.bind(null, id, applicationId)} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
              <select name="departmentCode" required className="rounded border px-2 py-1">{choices.map((d) => <option key={d} value={d}>{d}</option>)}</select>
              <input name="notes" placeholder="notes (optional)" className="rounded border px-2 py-1" />
              <button className="rounded bg-slate-900 px-2 py-1 text-white">Accept</button>
            </form>
          )}
        </section>
      ) : (
        <section className="rounded border p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Interview</h2>
          {error && <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          {existingInterviews.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {existingInterviews.map((iv) => (
                <li key={iv.id}><a className="text-blue-700 underline" href={`/recruitment/cycles/${id}/interviews/${iv.id}`}>Interview for {iv.departmentCode}</a></li>
              ))}
            </ul>
          )}
          {scheduleChoices.length > 0 ? (
            <form action={scheduleInterviewAction.bind(null, id, applicationId)} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
              <select name="departmentCode" required className="rounded border px-2 py-1">{scheduleChoices.map((d) => <option key={d} value={d}>{d}</option>)}</select>
              <button className="rounded bg-slate-900 px-2 py-1 text-white">Schedule interview</button>
            </form>
          ) : existingInterviews.length === 0 ? <p className="mt-2 text-sm text-slate-500">No eligible department to interview for in your scope.</p> : null}
        </section>
      )}
    </div>
  );
}
