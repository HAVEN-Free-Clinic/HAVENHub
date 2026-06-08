import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listApplicantsForReview } from "@/modules/recruitment/services/review";

function badge(depts: string[]): string {
  if (depts.length === 0) return "None";
  const distinct = [...new Set(depts)];
  return distinct.length > 1 ? `Conflict: ${distinct.join(" + ")}` : `Accepted: ${distinct[0]}`;
}

export default async function ApplicantsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const person = await requirePersonSession();
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const apps = await listApplicantsForReview(id, person.personId);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Applicants: {cycle.title}</h1>
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th className="py-2">Name</th><th>Email</th><th>Type</th><th>Ranked</th><th>Decision</th></tr></thead>
        <tbody>
          {apps.map((a) => (
            <tr key={a.id} className="border-t">
              <td className="py-2"><Link className="font-medium" href={`/recruitment/cycles/${id}/applicants/${a.id}`}>{a.applicant.firstName} {a.applicant.lastName}</Link></td>
              <td>{a.applicant.email}</td>
              <td>{a.applicantType}</td>
              <td>{a.departmentChoices.join(", ")}</td>
              <td>{badge(a.acceptances.map((x) => x.departmentCode))}</td>
            </tr>
          ))}
          {apps.length === 0 && <tr><td colSpan={5} className="py-6 text-slate-500">No applicants in your review scope.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
