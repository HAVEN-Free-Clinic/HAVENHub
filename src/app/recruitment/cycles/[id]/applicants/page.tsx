import Link from "next/link";
import { notFound } from "next/navigation";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listApplications } from "@/modules/recruitment/services/submissions";

export default async function ApplicantsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const apps = await listApplications(id);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Applicants: {cycle.title}</h1>
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th className="py-2">Name</th><th>Email</th><th>Type</th><th>Departments</th><th>Submitted</th></tr></thead>
        <tbody>
          {apps.map((a) => (
            <tr key={a.id} className="border-t">
              <td className="py-2"><Link className="font-medium" href={`/recruitment/cycles/${id}/applicants/${a.id}`}>{a.applicant.firstName} {a.applicant.lastName}</Link></td>
              <td>{a.applicant.email}</td>
              <td>{a.applicantType}</td>
              <td>{a.departmentChoices.join(", ")}</td>
              <td>{a.submittedAt.toLocaleString()}</td>
            </tr>
          ))}
          {apps.length === 0 && <tr><td colSpan={5} className="py-6 text-slate-500">No applications yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
