import Link from "next/link";
import { requirePersonSession } from "@/platform/auth/session";
import { DateTime } from "@/platform/dates/display";
import { myAssignedInterviews } from "@/modules/recruitment/services/interviews";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { recruitmentTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { InterviewStatusBadge, ScoreBadge } from "@/modules/recruitment/components/interview-cells";
import { Badge } from "@/platform/ui/badge";

export default async function MyInterviewsPage() {
  const person = await requirePersonSession();
  const interviews = await myAssignedInterviews(person.personId);
  return (
    <div className="space-y-6">
      <SetBreadcrumb trail={recruitmentTrail({ label: "My interviews", href: "/recruitment/interviews" })} />
      <PageHeader title="My interview assignments" description="Interviews where you are on the panel." />
      <Table>
        <THead>
          <tr>
            <TH>Candidate</TH>
            <TH>Dept</TH>
            {/* Same column, same order as the cycle-side list at
                /recruitment/cycles/[id]/interviews, so a lead who also sits on
                panels reads one vocabulary in one place across both. */}
            <TH>Status</TH>
            <TH>When</TH>
            <TH>Your eval</TH>
          </tr>
        </THead>
        <tbody>
          {interviews.map((iv) => (
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
              <TD><InterviewStatusBadge interview={iv} /></TD>
              <TD className="text-foreground-soft"><DateTime value={iv.scheduledAt} fallback="Not scheduled yet" /></TD>
              <TD>
                {/* "Pending" here is about YOU, not the candidate: it means you
                    have not scored yet. It never collides with the Status column,
                    whose PENDING-decision branch renders Scheduled or Offered. */}
                {iv.evaluations.length > 0 ? (
                  <ScoreBadge score={iv.evaluations[0].score} />
                ) : (
                  <Badge tone="warning">Pending</Badge>
                )}
              </TD>
            </TR>
          ))}
          {interviews.length === 0 && (
            <TR>
              <TD colSpan={5} className="py-10 text-center text-subtle-foreground">
                No interview assignments.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
