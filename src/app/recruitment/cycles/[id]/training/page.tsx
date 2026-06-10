import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listTrainingRoster, TrainingStateError } from "@/modules/recruitment/services/training";
import { recordAttendanceAction, resetTrainingAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";

export default async function TrainingRosterPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; err?: string }> }) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const viewer = await requirePersonSession();
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const trail = cycleTrail({ cycleId: id, cycleTitle: cycle.title, section: { label: "Training", slug: "training" } });

  let rows;
  try {
    rows = await listTrainingRoster(id, viewer.personId);
  } catch (e) {
    if (e instanceof TrainingStateError) {
      return <div className="max-w-2xl"><SetBreadcrumb trail={trail} /><h1 className="text-2xl font-semibold">Training: {cycle.title}</h1><p className="mt-3 text-sm text-slate-500">{e.message} Set this cycle as the term training cycle from the overview.</p></div>;
    }
    throw e;
  }

  return (
    <div className="max-w-3xl">
      <SetBreadcrumb trail={trail} />
      <h1 className="text-2xl font-semibold tracking-tight">Training: {cycle.title}</h1>
      {err && <p role="alert" className="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
      {msg && <p className="mt-3 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">{msg}</p>}
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th className="py-2">Volunteer</th><th>Dept</th><th>Cert</th><th>Training</th><th>Overall</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.personId}-${r.departmentCode}`} className="border-t">
              <td className="py-2">{r.name}</td>
              <td>{r.departmentCode}</td>
              <td>{r.certStatus}</td>
              <td>{r.trainingState}{r.locked ? " (locked)" : ""}</td>
              <td>{r.overallClearance}</td>
              <td className="space-x-2">
                {r.trainingState !== "COMPLETE" && <form className="inline" action={recordAttendanceAction.bind(null, id, r.personId)}><button className="text-xs underline">Record attendance</button></form>}
                {r.locked && <form className="inline" action={resetTrainingAction.bind(null, id, r.personId)}><button className="text-xs underline">Reset</button></form>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="py-6 text-slate-500">No active volunteers in scope.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
