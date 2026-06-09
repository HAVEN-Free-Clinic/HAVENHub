import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listInterviewsForReview } from "@/modules/recruitment/services/interviews";

function status(iv: { scheduledAt: Date | null; decision: string }): string {
  if (iv.decision !== "PENDING") return iv.decision;
  return iv.scheduledAt ? "Scheduled" : "Offered";
}

export default async function InterviewsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const person = await requirePersonSession();
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const interviews = await listInterviewsForReview(id, person.personId);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Interviews: {cycle.title}</h1>
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th className="py-2">Candidate</th><th>Dept</th><th>Status</th><th>Panel</th><th>Evals</th></tr></thead>
        <tbody>
          {interviews.map((iv) => (
            <tr key={iv.id} className="border-t">
              <td className="py-2"><Link className="font-medium" href={`/recruitment/cycles/${id}/interviews/${iv.id}`}>{iv.application.applicant.firstName} {iv.application.applicant.lastName}</Link></td>
              <td>{iv.departmentCode}</td>
              <td>{status(iv)}</td>
              <td>{iv.panelists.length}</td>
              <td>{iv.evaluations.length}/{iv.panelists.length}</td>
            </tr>
          ))}
          {interviews.length === 0 && <tr><td colSpan={5} className="py-6 text-slate-500">No interviews in your scope.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
