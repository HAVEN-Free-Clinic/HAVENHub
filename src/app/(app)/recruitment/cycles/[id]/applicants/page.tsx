import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listApplicantsForReview } from "@/modules/recruitment/services/review";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Pagination } from "@/platform/ui/pagination";
import { applicantTypeLabel } from "@/modules/recruitment/engine/visibility";

const PAGE_SIZE = 50;

function decision(depts: string[]): { label: string; tone: "default" | "success" | "critical" } {
  if (depts.length === 0) return { label: "None", tone: "default" };
  const distinct = [...new Set(depts)];
  return distinct.length > 1
    ? { label: `Conflict: ${distinct.join(" + ")}`, tone: "critical" }
    : { label: `Accepted: ${distinct[0]}`, tone: "success" };
}

export default async function ApplicantsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> }) {
  const { id } = await params;
  const { page: pageParam } = await searchParams;
  const [person, cycle] = await Promise.all([requirePersonSession(), getCycle(id)]);
  if (!cycle) notFound();
  const apps = await listApplicantsForReview(id, person.personId);
  const pageCount = Math.max(1, Math.ceil(apps.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(pageParam) || 1), pageCount);
  const pageApps = apps.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return (
    <div className="space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Applicants", slug: "applicants" },
        })}
      />
      <PageHeader title="Applicants" description={cycle.title} />
      <Table>
        <THead>
          <tr>
            <TH>Name</TH>
            <TH>Email</TH>
            <TH>Type</TH>
            <TH>Ranked</TH>
            <TH>Decision</TH>
          </tr>
        </THead>
        <tbody>
          {pageApps.map((a) => {
            const d = decision(a.acceptances.map((x) => x.departmentCode));
            return (
              <TR key={a.id}>
                <TD>
                  <Link
                    className="font-medium text-foreground hover:text-brand-fg"
                    href={`/recruitment/cycles/${id}/applicants/${a.id}`}
                  >
                    {a.applicant.firstName} {a.applicant.lastName}
                  </Link>
                </TD>
                <TD className="text-foreground-soft">{a.applicant.email}</TD>
                <TD className="text-foreground-soft">{applicantTypeLabel(a.applicantType)}</TD>
                <TD className="text-foreground-soft">{a.departmentChoices.join(", ")}</TD>
                <TD>
                  <Badge tone={d.tone}>{d.label}</Badge>
                </TD>
              </TR>
            );
          })}
          {apps.length === 0 && (
            <TR>
              <TD colSpan={5} className="py-10 text-center text-subtle-foreground">
                No applicants in your review scope.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
      <Pagination
        page={page}
        pageCount={pageCount}
        hrefFor={(p) => `/recruitment/cycles/${id}/applicants?page=${p}`}
      />
    </div>
  );
}
