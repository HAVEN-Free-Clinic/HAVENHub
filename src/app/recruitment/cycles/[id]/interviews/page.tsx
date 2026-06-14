import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listInterviewsForReview } from "@/modules/recruitment/services/interviews";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";

type Tone = "default" | "brand" | "success" | "warning" | "critical";

function status(iv: { scheduledAt: Date | null; decision: string }): { label: string; tone: Tone } {
  if (iv.decision !== "PENDING") {
    const tone: Tone = iv.decision === "ACCEPT" ? "success" : iv.decision === "REJECT" ? "critical" : "warning";
    return { label: iv.decision, tone };
  }
  return iv.scheduledAt ? { label: "Scheduled", tone: "brand" } : { label: "Offered", tone: "default" };
}

export default async function InterviewsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const person = await requirePersonSession();
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const interviews = await listInterviewsForReview(id, person.personId);
  return (
    <div className="space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Interviews", slug: "interviews" },
        })}
      />
      <PageHeader title="Interviews" description={cycle.title} />
      <Table>
        <THead>
          <tr>
            <TH>Candidate</TH>
            <TH>Dept</TH>
            <TH>Status</TH>
            <TH>When</TH>
            <TH>Panel</TH>
            <TH>Evals</TH>
          </tr>
        </THead>
        <tbody>
          {interviews.map((iv) => {
            const s = status(iv);
            return (
              <TR key={iv.id}>
                <TD>
                  <Link
                    className="font-medium text-foreground hover:text-brand-fg"
                    href={`/recruitment/cycles/${id}/interviews/${iv.id}`}
                  >
                    {iv.application.applicant.firstName} {iv.application.applicant.lastName}
                  </Link>
                </TD>
                <TD className="text-foreground-soft">{iv.departmentCode}</TD>
                <TD>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </TD>
                <TD className="text-foreground-soft">{iv.scheduledAt ? iv.scheduledAt.toLocaleString() : "TBD"}</TD>
                <TD className="text-foreground-soft">{iv.panelists.length}</TD>
                <TD className="text-foreground-soft">
                  {iv.evaluations.length}/{iv.panelists.length}
                </TD>
              </TR>
            );
          })}
          {interviews.length === 0 && (
            <TR>
              <TD colSpan={6} className="py-10 text-center text-subtle-foreground">
                No interviews in your scope.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
