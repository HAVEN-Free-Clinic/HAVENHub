import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission, requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listWaitlisted } from "@/modules/recruitment/services/review";
import { promoteFromWaitlistAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Alert } from "@/platform/ui/alert";
import { ConfirmButton } from "@/platform/ui/confirm-button";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; promoted?: string; sent?: string }>;
};

export default async function WaitlistPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { error, promoted, sent } = await searchParams;
  await requirePermission("recruitment.access");
  const [person, cycle] = await Promise.all([requirePersonSession(), getCycle(id)]);
  if (!cycle) notFound();
  const entries = await listWaitlisted(id, person.personId);

  return (
    <div className="space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Waitlist", slug: "waitlist" },
        })}
      />
      <PageHeader title="Waitlist" description={cycle.title} />
      {error && <Alert tone="error">{error}</Alert>}
      {promoted && (sent === "conflicted" ? (
        <Alert tone="warning">
          Promoted {promoted} to accepted, but they now hold offers from more than one department. Resolve the
          conflict on the Decisions page, then release to email them.
        </Alert>
      ) : (
        <Alert tone="success">
          Promoted {promoted} to accepted{sent === "1" ? " and emailed them." : "."}
        </Alert>
      ))}
      <p className="text-sm text-muted-foreground">
        {entries.length} waitlisted {entries.length === 1 ? "applicant" : "applicants"}. Promoting an applicant
        accepts them for their department and emails them their acceptance right away.
      </p>
      <Table>
        <THead>
          <tr>
            <TH>Name</TH>
            <TH>Email</TH>
            <TH>Department</TH>
            <TH>Action</TH>
          </tr>
        </THead>
        <tbody>
          {entries.map((e) => (
            <TR key={e.interviewId ?? e.applicationId}>
              <TD>
                <Link
                  className="font-medium text-foreground hover:text-brand-fg"
                  href={`/recruitment/cycles/${id}/applicants/${e.applicationId}`}
                >
                  {e.applicantName}
                </Link>
              </TD>
              <TD className="text-foreground-soft">{e.applicantEmail}</TD>
              <TD className="text-foreground-soft">{e.departmentCode ?? "-"}</TD>
              <TD>
                <form action={promoteFromWaitlistAction.bind(null, id)}>
                  <input type="hidden" name="applicationId" value={e.applicationId} />
                  {e.interviewId && <input type="hidden" name="interviewId" value={e.interviewId} />}
                  <input type="hidden" name="applicantName" value={e.applicantName} />
                  <ConfirmButton label="Promote to accept" confirmLabel="Accept and email now?" size="sm" />
                </form>
              </TD>
            </TR>
          ))}
          {entries.length === 0 && (
            <TR>
              <TD colSpan={4} className="py-10 text-center text-subtle-foreground">
                No waitlisted applicants in your review scope.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
