import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listConflicts, releaseSummary } from "@/modules/recruitment/services/decisions";
import { releaseDecisionsAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";

export default async function DecisionsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sent?: string; skipped?: string; error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  await requirePermission("recruitment.review_all");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const [conflicts, summary] = await Promise.all([listConflicts(id), releaseSummary(id)]);

  return (
    <div className="max-w-2xl space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Decisions", slug: "decisions" },
        })}
      />
      <h1 className="text-2xl font-semibold tracking-tight">Decisions: {cycle.title}</h1>
      {sp.error && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{sp.error}</p>}
      {sp.sent !== undefined && <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">Released {sp.sent} acceptance email(s); skipped {sp.skipped} conflicted applicant(s).</p>}

      <div className="grid grid-cols-4 gap-3 text-sm">
        <div className="rounded border p-3"><div className="text-slate-500">Accepted</div><div className="text-lg font-semibold">{summary.acceptedApplications}</div></div>
        <div className="rounded border p-3"><div className="text-slate-500">Unnotified</div><div className="text-lg font-semibold">{summary.unnotified}</div></div>
        <div className="rounded border p-3"><div className="text-slate-500">Conflicts</div><div className="text-lg font-semibold">{summary.conflictedApplications}</div></div>
        <div className="rounded border p-3"><div className="text-slate-500">Emailed</div><div className="text-lg font-semibold">{summary.emailed}</div></div>
      </div>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Conflicts to resolve</h2>
        {conflicts.length === 0 ? <p className="mt-2 text-sm text-slate-500">No conflicts.</p> : (
          <ul className="mt-2 space-y-1 text-sm">
            {conflicts.map((c) => (
              <li key={c.applicationId} className="border-t py-1">
                <a className="font-medium text-blue-700 underline" href={`/recruitment/cycles/${id}/applicants/${c.applicationId}`}>{c.applicantName}</a> accepted by {c.departments.join(" + ")}
              </li>
            ))}
          </ul>
        )}
      </section>

      <form action={releaseDecisionsAction.bind(null, id)}>
        <button className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white">Release decisions</button>
        <p className="mt-1 text-xs text-slate-500">Emails every accepted, non-conflicted applicant who hasn&apos;t been notified yet.</p>
      </form>
    </div>
  );
}
