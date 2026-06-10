import Link from "next/link";
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
import { PageHeader } from "@/platform/ui/page-header";
import { Field, Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";

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
      <PageHeader
        title={`${app.applicant.firstName} ${app.applicant.lastName}`}
        description={`${app.applicant.email} · ${app.applicantType}${app.renewalDepartment ? ` · renewing in ${app.renewalDepartment}` : ""}`}
      />

      {sections.map((section) => (
        <section key={section.id} className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">{section.title}</h2>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            {section.fields.map((f) => {
              const val = answers[f.key];
              const display = f.type === "FILE" && val && typeof val === "object"
                ? (val as { fileName?: string }).fileName ?? "(file)"
                : Array.isArray(val) ? val.join(", ") : val === undefined || val === "" ? "(none)" : String(val);
              return (
                <div key={f.id}>
                  <dt className="text-xs text-slate-400">{f.label}</dt>
                  <dd className="mt-0.5 text-sm text-slate-800">{display}</dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}

      {app.cycle.track === "VOLUNTEER" ? (
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Decision</h2>
          {error && <Alert tone="error" className="mt-3">{error}</Alert>}
          {acceptances.length > 0 ? (
            <ul className="mt-3 divide-y divide-slate-100">
              {acceptances.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <span className="text-slate-700">
                    Accepted into <strong className="text-slate-900">{a.departmentCode}</strong>
                    {a.notes ? `: ${a.notes}` : ""}
                    {a.emailedAt && <Badge tone="success" className="ml-2">notified</Badge>}
                  </span>
                  <form action={revokeAcceptanceAction.bind(null, id, applicationId, a.id)}>
                    <ConfirmButton label="Revoke" size="sm" />
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-slate-500">No acceptances yet.</p>
          )}
          {choices.length > 0 && (
            <form
              action={acceptApplicantAction.bind(null, id, applicationId)}
              className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4"
            >
              <div className="w-40">
                <Field label="Department">
                  <Select name="departmentCode" required>
                    {choices.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="min-w-[12rem] flex-1">
                <Field label="Notes" hint="Optional.">
                  <Input name="notes" />
                </Field>
              </div>
              <SubmitButton size="sm" pendingLabel="Accepting…">Accept</SubmitButton>
            </form>
          )}
        </section>
      ) : (
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Interview</h2>
          {error && <Alert tone="error" className="mt-3">{error}</Alert>}
          {existingInterviews.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {existingInterviews.map((iv) => (
                <li key={iv.id}>
                  <Link
                    className="font-medium text-brand hover:text-brand-hover"
                    href={`/recruitment/cycles/${id}/interviews/${iv.id}`}
                  >
                    Interview for {iv.departmentCode}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {scheduleChoices.length > 0 ? (
            <form
              action={scheduleInterviewAction.bind(null, id, applicationId)}
              className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4"
            >
              <div className="w-40">
                <Field label="Department">
                  <Select name="departmentCode" required>
                    {scheduleChoices.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <SubmitButton size="sm" pendingLabel="Scheduling…">Schedule interview</SubmitButton>
            </form>
          ) : existingInterviews.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No eligible department to interview for in your scope.</p>
          ) : null}
        </section>
      )}
    </div>
  );
}
