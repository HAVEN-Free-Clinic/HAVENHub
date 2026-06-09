import Link from "next/link";
import { listCycles } from "@/modules/recruitment/services/cycles";

export default async function RecruitmentPage() {
  const cycles = await listCycles();
  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Recruitment cycles</h1>
        <Link href="/recruitment/cycles/new" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white">New cycle</Link>
      </div>
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th className="py-2">Title</th><th>Track</th><th>Status</th></tr></thead>
        <tbody>
          {cycles.map((c) => (
            <tr key={c.id} className="border-t">
              <td className="py-2"><Link href={`/recruitment/cycles/${c.id}`} className="font-medium text-slate-900">{c.title}</Link></td>
              <td>{c.track}</td>
              <td>{c.status}</td>
            </tr>
          ))}
          {cycles.length === 0 && <tr><td colSpan={3} className="py-6 text-slate-500">No cycles yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
