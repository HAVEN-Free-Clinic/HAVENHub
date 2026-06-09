import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listOnboarding } from "@/modules/recruitment/services/onboarding";
import { sendLinksAction, promoteAction } from "./actions";

function statusLabel(c: { status: string } | null): string {
  if (!c) return "No contract";
  if (c.status === "PENDING") return "Sent";
  if (c.status === "SUBMITTED") return "Submitted";
  return "Promoted";
}

export default async function OnboardingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string }> }) {
  const { id } = await params;
  const { msg } = await searchParams;
  await requirePermission("recruitment.review_all");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const rows = await listOnboarding(id);

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Onboarding: {cycle.title}</h1>
      {msg && <p className="mt-3 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">{msg}</p>}

      <form action={sendLinksAction.bind(null, id)} className="mt-6">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-slate-500"><th className="py-2"></th><th>Applicant</th><th>Dept</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="py-2">{!r.contract && <input type="checkbox" name="acceptanceId" value={r.id} />}</td>
                <td>{r.application.applicant.firstName} {r.application.applicant.lastName}</td>
                <td>{r.departmentCode}</td>
                <td>{statusLabel(r.contract)}{r.contract?.promotedPersonId ? " (on roster)" : ""}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={4} className="py-6 text-slate-500">No accepted applicants yet.</td></tr>}
          </tbody>
        </table>
        <button className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white">Send onboarding links</button>
      </form>

      <form action={promoteAction.bind(null, id)} className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Promote submitted contracts</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {rows.filter((r) => r.contract?.status === "SUBMITTED").map((r) => (
            <li key={r.id}><label><input type="checkbox" name="contractId" value={r.contract!.id} /> {r.application.applicant.firstName} {r.application.applicant.lastName} ({r.departmentCode})</label></li>
          ))}
          {rows.filter((r) => r.contract?.status === "SUBMITTED").length === 0 && <li className="text-slate-500">No submitted contracts ready to promote.</li>}
        </ul>
        <button className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white">Promote selected</button>
      </form>
    </div>
  );
}
