import { notFound } from "next/navigation";
import { getApplication } from "@/modules/recruitment/services/submissions";
import { visibleSections } from "@/modules/recruitment/engine/visibility";

export default async function ApplicationDetailPage({ params }: { params: Promise<{ applicationId: string }> }) {
  const { applicationId } = await params;
  const app = await getApplication(applicationId);
  if (!app) notFound();
  const answers = (app.answers ?? {}) as Record<string, unknown>;
  const sections = visibleSections(app.cycle.sections, {
    applicantType: app.applicantType,
    selectedDepartmentCodes: app.departmentChoices,
  });
  return (
    <div className="max-w-2xl space-y-6">
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
                : Array.isArray(val) ? val.join(", ") : val === undefined || val === "" ? "—" : String(val);
              return (<div key={f.id}><dt className="text-xs text-slate-500">{f.label}</dt><dd className="text-sm">{display}</dd></div>);
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}
