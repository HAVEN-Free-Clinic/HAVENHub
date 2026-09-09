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
import { EvalProgress } from "@/modules/recruitment/components/interview-cells";
import { Badge } from "@/platform/ui/badge";

type Tone = "default" | "brand" | "success" | "warning" | "critical";

const decisionLabels: Record<string, string> = { ACCEPT: "Accepted", REJECT: "Rejected", WAITLIST: "Waitlisted", PENDING: "Pending" };

function status(iv: {
  scheduledAt: Date | null;
  decision: string;
  application: { status: string };
}): { label: string; tone: Tone } {
  // Withdrawal outranks both the decision and the schedule, and it is the one
  // fact this list used to omit: the panelist's own list badges it (and the
  // service deliberately keeps a withdrawn applicant's row precisely so nobody
  // dials into a cancelled call), while the lead running the cycle saw
  // "Scheduled" and had no idea the candidate had gone.
  if (iv.application.status === "WITHDRAWN") return { label: "Withdrawn", tone: "warning" };
  if (iv.decision !== "PENDING") {
    const tone: Tone = iv.decision === "ACCEPT" ? "success" : iv.decision === "REJECT" ? "critical" : "warning";
    return { label: decisionLabels[iv.decision] ?? iv.decision, tone };
  }
  return iv.scheduledAt ? { label: "Scheduled", tone: "brand" } : { label: "Offered", tone: "default" };
}

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
            const s = status(iv);
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
                  <Badge tone={s.tone}>{s.label}</Badge>
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
