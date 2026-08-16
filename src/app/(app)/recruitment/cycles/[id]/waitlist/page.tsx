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
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Alert } from "@/platform/ui/alert";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function WaitlistPage({ params }: PageProps) {
  const { id } = await params;
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
      <p className="text-sm text-muted-foreground">
        {entries.length} waitlisted {entries.length === 1 ? "applicant" : "applicants"}. Promoting an applicant
        accepts them for their department and emails them their acceptance right away.
      </p>
      {/* Archiving blocks the acceptance email AND the onboarding link, so a promote
          here would strand the applicant accepted-but-un-onboardable. The action
          refuses it; say so up front rather than after the click (audit 14, REC-5). */}
      {cycle.status === "ARCHIVED" && (
        <Alert tone="warning">
          This cycle is archived, so promoting is blocked: neither the acceptance email nor the onboarding
          link can be sent for an archived cycle. Un-archive it from the cycle overview first.
        </Alert>
      )}
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
