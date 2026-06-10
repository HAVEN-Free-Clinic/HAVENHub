import Link from "next/link";
import { requirePersonSession } from "@/platform/auth/session";
import { myAssignedInterviews } from "@/modules/recruitment/services/interviews";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { recruitmentTrail } from "@/modules/recruitment/breadcrumbs";

export default async function MyInterviewsPage() {
  const person = await requirePersonSession();
  const interviews = await myAssignedInterviews(person.personId);
  return (
    <div>
      <SetBreadcrumb trail={recruitmentTrail({ label: "My interviews", href: "/recruitment/interviews" })} />
      <h1 className="text-2xl font-semibold tracking-tight">My interview assignments</h1>
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th className="py-2">Candidate</th><th>Dept</th><th>When</th><th>Your eval</th></tr></thead>
        <tbody>
          {interviews.map((iv) => (
            <tr key={iv.id} className="border-t">
              <td className="py-2"><Link className="font-medium" href={`/recruitment/cycles/${iv.application.cycle.id}/interviews/${iv.id}`}>{iv.application.applicant.firstName} {iv.application.applicant.lastName}</Link></td>
              <td>{iv.departmentCode}</td>
              <td>{iv.scheduledAt ? iv.scheduledAt.toLocaleString() : "TBD"}</td>
              <td>{iv.evaluations.length > 0 ? iv.evaluations[0].recommendation : "Pending"}</td>
            </tr>
          ))}
          {interviews.length === 0 && <tr><td colSpan={4} className="py-6 text-slate-500">No interview assignments.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
