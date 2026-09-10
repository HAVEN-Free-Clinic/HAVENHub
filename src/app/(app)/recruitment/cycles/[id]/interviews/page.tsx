import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission, requirePersonSession } from "@/platform/auth/session";
import { DateTime } from "@/platform/dates/display";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listInterviewsForReview } from "@/modules/recruitment/services/interviews";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { EvalProgress, InterviewStatusBadge } from "@/modules/recruitment/components/interview-cells";

export default async function InterviewsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("recruitment.access");
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
      <div className="space-y-2">
        <PageHeader title="Interviews" description={cycle.title} />
        <p className="max-w-2xl text-sm text-muted-foreground">
          This is where you send Zoom links to applicants and panelists for their interviews. It is a confirmation tool only; you manage your own scheduling.
        </p>
      </div>
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
            const panelistCount = iv.panelists.length;
            const evaluationCount = iv.evaluations.length;
            return (
              <TR key={iv.id}>
                <TD>
                  <Link
                    className="font-medium text-foreground hover:text-brand-fg"
                    href={`/recruitment/interviews/${iv.id}`}
                  >
                    {iv.application.applicant.firstName} {iv.application.applicant.lastName}
                  </Link>
                </TD>
                <TD className="text-foreground-soft">{iv.departmentCode}</TD>
                <TD>
                  <InterviewStatusBadge interview={iv} />
                </TD>
                <TD className="text-foreground-soft"><DateTime value={iv.scheduledAt} fallback="Not scheduled yet" /></TD>
                <TD className="text-foreground-soft">{panelistCount}</TD>
                <TD>
                  <EvalProgress done={evaluationCount} panelists={panelistCount} />
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
